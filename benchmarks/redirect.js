import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Trend } from "k6/metrics";

const rate = Number(__ENV.RATE);
const seconds = Number(__ENV.SECONDS);
const fixedVus = __ENV.BENCH_VUS ? Number(__ENV.BENCH_VUS) : undefined;
const baseUrl = __ENV.BASE_URL ?? "http://redirect-service:3000";

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

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(95)", "p(99)"],
  thresholds: {
    checks: ["rate==1"],
    dropped_iterations: ["count==0"],
  },
  scenarios: {
    redirect: {
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
  // Match the 1,000 fixture codes in seed.sql and cycle through them evenly.
  const code = String((exec.scenario.iterationInTest % 1000) + 1).padStart(
    8,
    "0",
  );
  const response = http.get(`${baseUrl}/${code}`, {
    redirects: 0,
    timeout: "2s",
    tags: { name: "GET /:code" },
  });
  const timing = /^db_pool;dur=(\d+\.\d+),\s*db_lookup;dur=(\d+\.\d+)$/.exec(
    response.headers["Server-Timing"] ?? "",
  );
  if (timing) {
    poolAcquisition.add(Number(timing[1]));
    databaseLookup.add(Number(timing[2]));
  }
  check(response, {
    "302 with the expected Location": (res) =>
      res.status === 302 &&
      res.headers.Location === `https://example.com/benchmark/${code}`,
    "database timings reported": () => timing !== null,
  });
}
