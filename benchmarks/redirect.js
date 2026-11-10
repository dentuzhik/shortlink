import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Trend } from "k6/metrics";

const rate = Number(__ENV.RATE);
const seconds = Number(__ENV.SECONDS);

if (!Number.isInteger(rate) || rate < 1 || rate > 5000) {
  throw new Error("RATE must be an integer from 1 to 5000");
}
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
  throw new Error("SECONDS must be an integer from 1 to 120");
}

http.setResponseCallback(http.expectedStatuses(302));
const poolAcquisition = new Trend("db_pool_acquire", true);

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
      preAllocatedVUs: 20,
      maxVUs: 60,
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
  const response = http.get(`http://redirect-service:3000/${code}`, {
    redirects: 0,
    timeout: "2s",
    tags: { name: "GET /:code" },
  });
  const timing = /^db_pool;dur=(\d+(?:\.\d+)?)$/.exec(
    response.headers["Server-Timing"] ?? "",
  );
  if (timing) {
    poolAcquisition.add(Number(timing[1]));
  }
  check(response, {
    "302 with the expected Location": (res) =>
      res.status === 302 &&
      res.headers.Location === `https://example.com/benchmark/${code}`,
    "pool acquisition timing reported": () => timing !== null,
  });
}
