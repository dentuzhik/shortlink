import exec from "k6/execution";
import http from "k6/http";
import { Rate, Trend } from "k6/metrics";

const baseUrl = __ENV.BASE_URL ?? "http://127.0.0.1:8080";
const correct = new Rate("redirect_correct");
const withinBudget = new Rate("redirect_correct_within_100ms");
const duration = new Trend("redirect_client_ms", true);
const expectedRedirect = http.expectedStatuses(302);
let failuresLogged = 0;

const thresholds = {
  dropped_iterations: ["count==0"],
  iterations: ["count>=8999"],
  http_req_failed: ["rate==0"],
  redirect_correct: ["rate==1"],
  redirect_correct_within_100ms: ["rate>=0.99"],
};
for (const phase of ["baseline", "restart_window", "after"]) {
  thresholds[`redirect_correct{phase:${phase}}`] = ["rate==1"];
  thresholds[`redirect_correct_within_100ms{phase:${phase}}`] = ["rate>=0.99"];
  // An empty threshold exposes each phase's latency distribution in the summary.
  thresholds[`redirect_client_ms{phase:${phase}}`] = [];
}

export const options = {
  summaryTrendStats: ["avg", "p(95)", "p(99)", "max"],
  scenarios: {
    redirects: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "90s",
      preAllocatedVUs: 50,
      maxVUs: 350,
      gracefulStop: "5s",
    },
  },
  thresholds,
};

export function setup() {
  const fixtures = [];
  for (let i = 0; i < 10; i++) {
    const targetUrl = `https://example.com/rolling-restart/${i}`;
    const created = http.post(
      `${baseUrl}/links`,
      JSON.stringify({ targetUrl }),
      {
        headers: {
          Host: "go.localhost:8080",
          "Content-Type": "application/json",
        },
        timeout: "3s",
        responseCallback: http.expectedStatuses(201),
        tags: { name: "POST /links (fixtures)" },
      },
    );
    if (created.status !== 201)
      throw new Error(`Fixture creation failed: ${created.status}`);
    const code = created.json("code");
    const warmed = http.get(`${baseUrl}/${code}`, {
      headers: { Host: "go.localhost:8080" },
      redirects: 0,
      timeout: "3s",
      responseCallback: expectedRedirect,
      tags: { name: "GET /:code (warm cache)" },
    });
    if (warmed.status !== 302 || warmed.headers.Location !== targetUrl)
      throw new Error("Fixture warmup returned an incorrect redirect");
    fixtures.push({ code, targetUrl });
  }
  // The runner uses this marker to schedule the restart after 20s of baseline.
  console.log(`ROLLING_RESTART_READY ${Date.now()}`);
  return fixtures;
}

export default function visit(fixtures) {
  const elapsed = Date.now() - exec.scenario.startTime;
  const phase =
    elapsed < 20_000
      ? "baseline"
      : elapsed < 60_000
        ? "restart_window"
        : "after";
  const fixture = fixtures[exec.scenario.iterationInTest % fixtures.length];
  const startedAt = Date.now();
  const response = http.get(`${baseUrl}/${fixture.code}`, {
    headers: { Host: "go.localhost:8080" },
    redirects: 0,
    timeout: "3s",
    responseCallback: expectedRedirect,
    tags: { name: "GET /:code", phase },
  });
  const ms = Date.now() - startedAt;
  const valid =
    response.status === 302 &&
    response.headers.Location === fixture.targetUrl &&
    response.headers["Cache-Control"] === "no-store";
  correct.add(valid, { phase });
  withinBudget.add(valid && ms <= 100, { phase });
  duration.add(ms, { phase });
  if (!valid && failuresLogged++ === 0) {
    console.warn(
      `REDIRECT_FAILURE ${JSON.stringify({
        startedAt,
        phase,
        status: response.status,
        error: response.error,
        errorCode: response.error_code,
        location: response.headers.Location,
      })}`,
    );
  }
}
