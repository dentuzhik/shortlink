import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const rate = Number(__ENV.RATE);
const seconds = Number(__ENV.SECONDS);
const fixedVus = __ENV.BENCH_VUS ? Number(__ENV.BENCH_VUS) : undefined;
const baseUrl = __ENV.BASE_URL ?? "http://redirect-service:3000";
const lookupMode = __ENV.BENCH_LOOKUP ?? "postgres";
const redisLookup = lookupMode.startsWith("redis-");
const hotLookup = lookupMode === "redis-hot";
const expiresAtMs = Number(__ENV.BENCH_EXPIRES_AT_MS ?? 0);
const spikeAtMs = Number(__ENV.BENCH_SPIKE_AT_MS ?? 0);
const fixtureCount = 1000;
const phaseSeconds = 3;
const spikeRate = 20000;
const steadyRate = 7500;

if (!Number.isInteger(rate) || rate < 1 || rate > 20000) {
  throw new Error("RATE must be an integer from 1 to 20000");
}
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
  throw new Error("SECONDS must be an integer from 1 to 120");
}
if (fixedVus !== undefined && (!Number.isInteger(fixedVus) || fixedVus < 1)) {
  throw new Error("BENCH_VUS must be a positive integer");
}
if (expiresAtMs && (!hotLookup || seconds < 10)) {
  throw new Error(
    "Hot-key expiry requires a hot-key run of at least 10 seconds",
  );
}
if (spikeAtMs && (!hotLookup || expiresAtMs)) {
  throw new Error("Spike mode schedules its own hot-key boundary");
}

http.setResponseCallback(http.expectedStatuses(302));
const poolAcquisition = new Trend("db_pool_acquire", true);
const databaseLookup = new Trend("db_lookup", true);
const cacheHitRate = new Rate("redis_hit_rate");
const postgresLookups = new Counter("postgres_lookups");
const coalescedRedirects = new Counter("coalesced_redirects");
const coldStartHitRate = new Rate("cold_first_3s_redis_hit_rate");
const coldStartLookups = new Counter("cold_first_3s_postgres_lookups");
const coldStartLatency = new Trend("cold_first_3s_http_duration", true);
const expiryLookups = new Counter("hot_expiry_postgres_lookups");
const expiryLatency = new Trend("hot_expiry_http_duration", true);
const steadyLatency = new Trend("hot_steady_http_duration", true);
const spikeBoundaryLag = new Trend("spike_boundary_after_start", true);
const spikeBoundaryLatency = new Trend("spike_first_100ms_http_duration", true);
const spikeBoundaryRequests = new Counter("spike_first_100ms_requests");
const spikeBoundaryLookups = new Counter("spike_first_100ms_postgres_lookups");
const coalescedLatency = new Trend("coalesced_http_duration", true);
const coalescedStartOffset = new Trend("coalesced_start_from_boundary_ms");
const spikeTransportErrors = new Counter("spike_transport_errors");
const spikeServerErrors = new Counter("spike_http_5xx");

function spikeScenarios() {
  const phase = `${phaseSeconds}s`;
  return {
    redirect: {
      executor: "ramping-arrival-rate",
      startRate: steadyRate,
      timeUnit: "1s",
      stages: [
        { target: steadyRate, duration: phase },
        { target: spikeRate, duration: "0s" },
        { target: spikeRate, duration: phase },
        { target: steadyRate, duration: "0s" },
        { target: steadyRate, duration: phase },
      ],
      preAllocatedVUs: fixedVus ?? 800,
      gracefulStop: "2s",
    },
    health: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: `${3 * phaseSeconds}s`,
      preAllocatedVUs: 20,
      gracefulStop: "2s",
      exec: "health",
    },
  };
}

function spikeThresholds() {
  return {
    // Phase tags use the actual start time, which can lag the scheduled start.
    "http_reqs{phase:spike}": [`count>=${spikeRate * phaseSeconds - 100}`],
    "http_req_failed{phase:spike}": ["rate==0"],
    "http_req_failed{scenario:health}": ["rate==0"],
    // Show latency by phase without imposing a latency budget.
    ...Object.fromEntries(
      ["before", "spike", "recovery", "health_spike"].map((phase) => [
        `http_req_duration{phase:${phase}}`,
        ["p(99)>=0"],
      ]),
    ),
    spike_boundary_after_start: ["min>=0", "max<=200"],
    spike_first_100ms_requests: ["count>0"],
  };
}

function phaseAt(startedAt) {
  const elapsed = startedAt - exec.scenario.startTime;
  if (elapsed < phaseSeconds * 1000) return "before";
  return elapsed < 2 * phaseSeconds * 1000 ? "spike" : "recovery";
}

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: spikeAtMs
    ? ["avg", "p(99)", "p(99.9)", "min", "max"]
    : ["avg", "p(95)", "p(99)"],
  thresholds: {
    checks: ["rate==1"],
    dropped_iterations: ["count==0"],
    ...(spikeAtMs ? spikeThresholds() : {}),
  },
  scenarios: spikeAtMs
    ? spikeScenarios()
    : {
        redirect:
          lookupMode === "redis-prime"
            ? {
                executor: "shared-iterations",
                vus: 5,
                iterations: fixtureCount,
                maxDuration: `${seconds}s`,
                gracefulStop: "2s",
              }
            : {
                executor: "constant-arrival-rate",
                rate,
                timeUnit: "1s",
                duration: `${seconds}s`,
                preAllocatedVUs: fixedVus ?? 20,
                maxVUs: fixedVus ?? 60,
                gracefulStop: "2s",
              },
      },
};

export function setup() {
  if (spikeAtMs) {
    // Start the spike 100 ms before the Redis deadline to allow for scheduling jitter.
    const waitMs = spikeAtMs - phaseSeconds * 1000 - 100 - Date.now();
    if (waitMs < 0) {
      throw new Error("k6 setup missed the scheduled start of the spike test");
    }
    sleep(waitMs / 1000);
  }
}

export function health() {
  const response = http.get(`${baseUrl}/healthz`, {
    timeout: "2s",
    responseCallback: http.expectedStatuses(200),
    tags: { phase: `health_${phaseAt(Date.now())}` },
  });
  check(response, {
    "unrelated health probe returns 200": (r) => r.status === 200,
  });
}

export default function () {
  const startedAt = Date.now();
  const phase = spikeAtMs ? phaseAt(startedAt) : undefined;
  const inColdStart =
    lookupMode === "redis-cold" && startedAt - exec.scenario.startTime < 3000;
  // Match the 1,000 fixture codes in seed.sql and cycle through them evenly.
  const code = hotLookup
    ? "00000001"
    : String((exec.scenario.iterationInTest % fixtureCount) + 1).padStart(
        8,
        "0",
      );
  const response = http.get(`${baseUrl}/${code}`, {
    redirects: 0,
    timeout: "2s",
    tags: phase ? { name: "GET /:code", phase } : { name: "GET /:code" },
  });
  const serverTiming = response.headers["Server-Timing"];
  const timing = /^db_pool;dur=(\d+\.\d+),\s*db_lookup;dur=(\d+\.\d+)$/.exec(
    serverTiming ?? "",
  );
  const cacheSource = response.headers["X-Cache"];
  const hit = cacheSource === "HIT";
  const coalesced = cacheSource === "COALESCED";
  const usedPostgres = timing !== null;
  const correctRedirect =
    response.status === 302 &&
    response.headers.Location === `https://example.com/benchmark/${code}`;

  if (spikeAtMs) {
    if (exec.scenario.iterationInTest === 0) {
      spikeBoundaryLag.add(
        spikeAtMs - exec.scenario.startTime - phaseSeconds * 1000,
      );
    }
    const elapsedMs = startedAt - spikeAtMs;
    if (phase === "spike") {
      spikeTransportErrors.add(Number(response.status === 0));
      spikeServerErrors.add(Number(response.status >= 500));
    }
    if (elapsedMs >= 0 && elapsedMs < 100) {
      spikeBoundaryRequests.add(1);
      spikeBoundaryLatency.add(response.timings.duration);
      spikeBoundaryLookups.add(Number(usedPostgres));
    }
    if (coalesced) {
      coalescedLatency.add(response.timings.duration);
      coalescedStartOffset.add(elapsedMs);
    }
  }

  if (timing) {
    poolAcquisition.add(Number(timing[1]));
    databaseLookup.add(Number(timing[2]));
  }
  if (correctRedirect) {
    cacheHitRate.add(hit);
    postgresLookups.add(Number(usedPostgres));
    if (redisLookup) {
      coalescedRedirects.add(Number(coalesced));
    }
    if (inColdStart) {
      coldStartHitRate.add(hit);
      coldStartLookups.add(Number(usedPostgres));
      coldStartLatency.add(response.timings.duration);
    }
    if (expiresAtMs) {
      if (Math.abs(startedAt - expiresAtMs) <= 500) {
        expiryLookups.add(Number(usedPostgres));
        expiryLatency.add(response.timings.duration);
      } else {
        steadyLatency.add(response.timings.duration);
      }
    }
  }

  let sourceMatches = usedPostgres && cacheSource === undefined;
  if (redisLookup) {
    if (hit || coalesced) {
      sourceMatches = serverTiming === undefined;
    }
  } else if (lookupMode === "fixture") {
    sourceMatches = serverTiming === undefined && cacheSource === undefined;
  }
  check(response, {
    "302 with the expected Location": () => correctRedirect,
    "timing matches the lookup mode": () => sourceMatches,
  });
}
