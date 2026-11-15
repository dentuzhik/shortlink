import exec from "k6/execution";
import http from "k6/http";
import { Rate, Trend } from "k6/metrics";

const baseUrl = __ENV.BASE_URL ?? "http://127.0.0.1:8080";
const redirectRate = Number(__ENV.RATE ?? 1000);
const createRate = Number(__ENV.CREATE_RATE ?? 10);
const redirectWorkers = Number(__ENV.REDIRECT_WORKERS ?? 350);
const createWorkers = Number(__ENV.CREATE_WORKERS ?? 50);
const seconds = 90;
if (
  !Number.isSafeInteger(redirectRate) ||
  redirectRate < 1 ||
  !Number.isSafeInteger(createRate) ||
  createRate < 0 ||
  !Number.isSafeInteger(redirectWorkers) ||
  redirectWorkers < 1 ||
  !Number.isSafeInteger(createWorkers) ||
  createWorkers < 1
) {
  throw new Error(
    "RATE must be a positive integer; CREATE_RATE must be nonnegative",
  );
}
const correct = new Rate("redirect_correct");
const withinBudget = new Rate("redirect_correct_within_100ms");
const duration = new Trend("redirect_client_ms", true);
const creationCorrect = new Rate("link_creation_correct");
const creationDuration = new Trend("link_creation_client_ms", true);
const expectedRedirect = http.expectedStatuses(302);
let failuresLogged = 0;

const thresholds = {
  dropped_iterations: ["count==0"],
  "iterations{scenario:redirects}": [`count>=${redirectRate * seconds - 1}`],
  http_req_failed: ["rate==0"],
  redirect_correct: ["rate==1"],
  redirect_correct_within_100ms: ["rate>=0.99"],
};
if (createRate > 0) {
  thresholds["iterations{scenario:creations}"] = [
    `count>=${createRate * seconds - 1}`,
  ];
  thresholds.link_creation_correct = ["rate==1"];
}
for (const phase of ["baseline", "restart_window", "after"]) {
  thresholds[`redirect_correct{phase:${phase}}`] = ["rate==1"];
  thresholds[`redirect_correct_within_100ms{phase:${phase}}`] = ["rate>=0.99"];
  // An empty threshold exposes each phase's latency distribution in the summary.
  thresholds[`redirect_client_ms{phase:${phase}}`] = [];
  if (createRate > 0) {
    thresholds[`link_creation_correct{phase:${phase}}`] = ["rate==1"];
    thresholds[`link_creation_client_ms{phase:${phase}}`] = [];
  }
}

export const options = {
  summaryTrendStats: ["avg", "p(95)", "p(99)", "max"],
  scenarios: {
    redirects: {
      executor: "constant-arrival-rate",
      exec: "visit",
      rate: redirectRate,
      timeUnit: "1s",
      duration: `${seconds}s`,
      // Allocate the existing worker ceiling before load starts so a short
      // latency spike does not also require k6 to initialize more workers.
      preAllocatedVUs: redirectWorkers,
      maxVUs: redirectWorkers,
      gracefulStop: "5s",
    },
    ...(createRate > 0
      ? {
          creations: {
            executor: "constant-arrival-rate",
            exec: "createLink",
            rate: createRate,
            timeUnit: "1s",
            duration: `${seconds}s`,
            preAllocatedVUs: createWorkers,
            maxVUs: createWorkers,
            gracefulStop: "5s",
          },
        }
      : {}),
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

function currentPhase() {
  const elapsed = Date.now() - exec.scenario.startTime;
  return elapsed < 20_000
    ? "baseline"
    : elapsed < 60_000
      ? "restart_window"
      : "after";
}

export function visit(fixtures) {
  const phase = currentPhase();
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
        body: response.body?.slice(0, 512),
      })}`,
    );
  }
}

export function createLink() {
  const phase = currentPhase();
  const targetUrl = `https://example.com/rolling-restart/created-under-load/${exec.scenario.startTime}/${exec.scenario.iterationInTest}`;
  const startedAt = Date.now();
  const response = http.post(
    `${baseUrl}/links`,
    JSON.stringify({ targetUrl }),
    {
      headers: {
        Host: "go.localhost:8080",
        "Content-Type": "application/json",
      },
      timeout: "3s",
      responseCallback: http.expectedStatuses(201),
      tags: { name: "POST /links", phase },
    },
  );
  const ms = Date.now() - startedAt;
  let link;
  try {
    link = response.json();
  } catch {
    // Count malformed responses as incorrect rather than losing the sample.
  }
  const valid =
    response.status === 201 &&
    link?.targetUrl === targetUrl &&
    /^[A-Za-z0-9_-]{8}$/.test(link?.code ?? "");
  let immediatelyUsable = false;
  if (valid) {
    console.log(
      `CREATION_ACK ${JSON.stringify({ code: link.code, targetUrl })}`,
    );
    const verificationStartedAt = Date.now();
    const redirect = http.get(`${baseUrl}/${link.code}`, {
      headers: { Host: "go.localhost:8080" },
      redirects: 0,
      timeout: "3s",
      responseCallback: expectedRedirect,
      tags: { name: "GET /:code (newly created)", phase },
    });
    immediatelyUsable =
      redirect.status === 302 &&
      redirect.headers.Location === targetUrl &&
      redirect.headers["Cache-Control"] === "no-store";
    const verificationMs = Date.now() - verificationStartedAt;
    correct.add(immediatelyUsable, { phase });
    withinBudget.add(immediatelyUsable && verificationMs <= 100, { phase });
    duration.add(verificationMs, { phase });
  }
  creationCorrect.add(valid && immediatelyUsable, { phase });
  creationDuration.add(ms, { phase });
  if ((!valid || !immediatelyUsable) && failuresLogged++ === 0) {
    console.warn(
      `CREATION_FAILURE ${JSON.stringify({
        startedAt,
        phase,
        status: response.status,
        error: response.error,
        errorCode: response.error_code,
        body: response.body?.slice(0, 512),
      })}`,
    );
  }
}
