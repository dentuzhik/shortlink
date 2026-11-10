import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const baseUrl = __ENV.BASE_URL;
const duration = Number(__ENV.SECONDS);
const rampSeconds = Number(__ENV.BENCH_BUDGET_RAMP_SECONDS ?? 0);
const redirectRate = Number(__ENV.RATE);
const redirectVus = Number(__ENV.BENCH_VUS || 400);
const redisTimingOut = __ENV.BENCH_LOOKUP === "redis-timeout";
const createRate = 10;
const fixtureCount = 1000;
const createUrl = "https://example.com/benchmark-created";

// Leave time to finish the run before the primed Redis keys expire.
if (!Number.isInteger(duration) || duration < 1 || duration > 45) {
  throw new Error("Latency budget trials must run for 1 to 45 seconds");
}
if (
  !Number.isInteger(rampSeconds) ||
  rampSeconds < 0 ||
  duration + rampSeconds > 45
) {
  throw new Error("Ramp and measurement must fit within 45 seconds");
}

const cutoffs = [100, 200, 300].map((ms) => ({
  ms,
  good: new Rate(`correct_redirect_within_${ms}ms`),
}));
const redirectSuccess = new Rate("redirect_success");
const measuredRedirects = new Counter("measured_redirects");
const createSuccess = new Rate("link_creation_success");
const redirectElapsed = new Trend("redirect_elapsed", true);
const createElapsed = new Trend("link_creation_elapsed", true);
const poolAcquisition = new Trend("db_pool_acquire", true);
const databaseLookup = new Trend("db_lookup", true);
const redisHits = new Counter("redis_hits");
const postgresLookups = new Counter("postgres_lookups");
const coalesced = new Counter("coalesced_redirects");
const cacheSourceMatches = new Rate("cache_source_matches");
const expectRedirect = http.expectedStatuses(302);
const expectCreated = http.expectedStatuses(201);

function arrivals(rate, preAllocatedVUs, handler, ramp = 0) {
  const scenario = {
    timeUnit: "1s",
    gracefulStop: "2s",
    preAllocatedVUs,
    exec: handler,
  };
  if (ramp > 0) {
    return {
      ...scenario,
      executor: "ramping-arrival-rate",
      startRate: Math.min(rate, 1000),
      stages: [
        { target: rate, duration: `${ramp}s` },
        { target: rate, duration: `${duration}s` },
      ],
    };
  }
  return {
    ...scenario,
    executor: "constant-arrival-rate",
    rate,
    duration: `${duration}s`,
  };
}

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(95)", "p(99)", "max"],
  thresholds: {
    correct_redirect_within_100ms: ["rate>=0.99"],
    dropped_iterations: ["count==0"],
    // The ramp cutoff uses client timestamps, which have millisecond precision.
    ...(rampSeconds > 0
      ? {
          measured_redirects: [
            `count>=${redirectRate * duration - 2 * Math.ceil(redirectRate / 1000)}`,
          ],
        }
      : {
          "iterations{scenario:redirect}": [
            `count>=${redirectRate * duration - 1}`,
          ],
        }),
    "iterations{scenario:create_link}": [`count>=${createRate * duration - 1}`],
    link_creation_success: ["rate==1"],
    cache_source_matches: ["rate==1"],
    [redisTimingOut ? "postgres_lookups" : "redis_hits"]: ["count>0"],
  },
  scenarios: {
    redirect: arrivals(redirectRate, redirectVus, "visit", rampSeconds),
    create_link: {
      ...arrivals(createRate, 20, "createLink"),
      startTime: `${rampSeconds}s`,
    },
  },
};

export function visit() {
  const code = String(
    (exec.scenario.iterationInTest % fixtureCount) + 1,
  ).padStart(8, "0");
  const startedAt = Date.now();
  const response = http.get(`${baseUrl}/${code}`, {
    redirects: 0,
    timeout: "2s",
    responseCallback: expectRedirect,
    tags: { name: "GET /:code" },
  });
  const elapsedMs = Date.now() - startedAt;
  if (rampSeconds > 0) {
    if (startedAt - exec.scenario.startTime < rampSeconds * 1000) return;
    measuredRedirects.add(1);
  }
  const correct =
    response.status === 302 &&
    response.headers.Location === `https://example.com/benchmark/${code}`;
  redirectElapsed.add(elapsedMs);
  redirectSuccess.add(correct);
  for (const { ms, good } of cutoffs) {
    good.add(correct && elapsedMs <= ms);
  }

  if (correct) {
    const serverTiming = response.headers["Server-Timing"];
    const timing = /^db_pool;dur=(\d+\.\d+), db_lookup;dur=(\d+\.\d+)$/.exec(
      serverTiming ?? "",
    );
    const source = response.headers["X-Cache"];
    const hit = source === "HIT" && serverTiming === undefined;
    const shared = source === "COALESCED" && serverTiming === undefined;
    const queried = timing !== null && source === undefined;
    redisHits.add(Number(hit));
    postgresLookups.add(Number(queried));
    coalesced.add(Number(shared));
    cacheSourceMatches.add(redisTimingOut ? queried || shared : hit);
    if (timing) {
      poolAcquisition.add(Number(timing[1]));
      databaseLookup.add(Number(timing[2]));
    }
  }
}

export function createLink() {
  const startedAt = Date.now();
  const response = http.post(
    `${baseUrl}/links`,
    JSON.stringify({ targetUrl: createUrl }),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "2s",
      responseCallback: expectCreated,
    },
  );
  createElapsed.add(Date.now() - startedAt);
  createSuccess.add(response.status === 201);
}
