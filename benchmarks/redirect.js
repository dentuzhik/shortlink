import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const rate = Number(__ENV.RATE);
const seconds = Number(__ENV.SECONDS);
const fixedVus = __ENV.BENCH_VUS ? Number(__ENV.BENCH_VUS) : undefined;
const baseUrl = __ENV.BASE_URL ?? "http://redirect-service:3000";
const lookupMode = __ENV.BENCH_LOOKUP ?? "postgres";
const redisLookup = lookupMode.startsWith("redis-");
const fixtureCount = 1000;

if (!Number.isInteger(rate) || rate < 1 || rate > 20000) {
  throw new Error("RATE must be an integer from 1 to 20000");
}
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
  throw new Error("SECONDS must be an integer from 1 to 120");
}
if (fixedVus !== undefined && (!Number.isInteger(fixedVus) || fixedVus < 1)) {
  throw new Error("BENCH_VUS must be a positive integer");
}

http.setResponseCallback(http.expectedStatuses(302));
const poolAcquisition = new Trend("db_pool_acquire", true);
const databaseLookup = new Trend("db_lookup", true);
const cacheHitRate = new Rate("redis_hit_rate");
const postgresLookups = new Counter("postgres_lookups");
const coldStartHitRate = new Rate("cold_first_3s_redis_hit_rate");
const coldStartLookups = new Counter("cold_first_3s_postgres_lookups");
const coldStartLatency = new Trend("cold_first_3s_http_duration", true);

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(95)", "p(99)"],
  thresholds: {
    checks: ["rate==1"],
    dropped_iterations: ["count==0"],
  },
  scenarios: {
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

export default function () {
  const inColdStart =
    lookupMode === "redis-cold" && Date.now() - exec.scenario.startTime < 3000;
  // Match the 1,000 fixture codes in seed.sql and cycle through them evenly.
  const code = String(
    (exec.scenario.iterationInTest % fixtureCount) + 1,
  ).padStart(8, "0");
  const response = http.get(`${baseUrl}/${code}`, {
    redirects: 0,
    timeout: "2s",
    tags: { name: "GET /:code" },
  });
  const serverTiming = response.headers["Server-Timing"];
  const timing = /^db_pool;dur=(\d+\.\d+),\s*db_lookup;dur=(\d+\.\d+)$/.exec(
    serverTiming ?? "",
  );
  const hit = response.headers["X-Cache"] === "HIT";
  const usedPostgres = timing !== null;
  const correctRedirect =
    response.status === 302 &&
    response.headers.Location === `https://example.com/benchmark/${code}`;

  if (timing) {
    poolAcquisition.add(Number(timing[1]));
    databaseLookup.add(Number(timing[2]));
  }
  if (correctRedirect) {
    cacheHitRate.add(hit);
    postgresLookups.add(Number(usedPostgres));
    if (inColdStart) {
      coldStartHitRate.add(hit);
      coldStartLookups.add(Number(usedPostgres));
      coldStartLatency.add(response.timings.duration);
    }
  }

  let sourceMatches = usedPostgres && !hit;
  if (redisLookup) {
    sourceMatches = hit ? serverTiming === undefined : usedPostgres;
  } else if (lookupMode === "fixture") {
    sourceMatches = serverTiming === undefined && !hit;
  }
  check(response, {
    "302 with the expected Location": () => correctRedirect,
    "timing matches the lookup mode": () => sourceMatches,
  });
}
