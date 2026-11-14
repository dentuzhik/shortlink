import exec from "k6/execution";
import http from "k6/http";
import { Rate, Trend } from "k6/metrics";

const base = __ENV.BASE_URL ?? "http://127.0.0.1:8080";
const rate = Number(__ENV.RATE ?? 100);
const createRate = Number(__ENV.CREATE_RATE ?? 2);
const seconds = 85;
if (
  !Number.isSafeInteger(rate) ||
  rate < 1 ||
  !Number.isSafeInteger(createRate) ||
  createRate < 1
)
  throw new Error("RATE and CREATE_RATE must be positive integers");
const redirectCorrect = new Rate("redirect_correct");
const redirectBudget = new Rate("redirect_correct_within_100ms");
const redirectMs = new Trend("redirect_client_ms", true);
const creationCorrect = new Rate("graphql_creation_correct");
const creationMs = new Trend("graphql_creation_client_ms", true);
const thresholds = {
  dropped_iterations: ["count==0"],
  http_req_failed: ["rate==0"],
  "iterations{scenario:redirects}": [`count>=${rate * seconds - 1}`],
  "iterations{scenario:creations}": [`count>=${createRate * seconds - 1}`],
  redirect_correct: ["rate==1"],
  redirect_correct_within_100ms: ["rate>=0.99"],
  graphql_creation_correct: ["rate==1"],
};
for (const phase of ["baseline", "rollout_window", "after"]) {
  thresholds[`redirect_correct{phase:${phase}}`] = ["rate==1"];
  thresholds[`redirect_correct_within_100ms{phase:${phase}}`] = ["rate>=0.99"];
  thresholds[`graphql_creation_correct{phase:${phase}}`] = ["rate==1"];
  thresholds[`redirect_client_ms{phase:${phase}}`] = [];
  thresholds[`graphql_creation_client_ms{phase:${phase}}`] = [];
}
export const options = {
  summaryTrendStats: ["avg", "p(95)", "p(99)", "max"],
  scenarios: {
    redirects: {
      executor: "constant-arrival-rate",
      exec: "visit",
      rate,
      timeUnit: "1s",
      duration: `${seconds}s`,
      preAllocatedVUs: 350,
      maxVUs: 350,
      gracefulStop: "5s",
    },
    creations: {
      executor: "constant-arrival-rate",
      exec: "createLink",
      rate: createRate,
      timeUnit: "1s",
      duration: `${seconds}s`,
      preAllocatedVUs: 50,
      maxVUs: 50,
      gracefulStop: "5s",
    },
  },
  thresholds,
};
const mutation =
  "mutation($input:CreateLinkInput!){createLink(input:$input){code targetUrl}}";
const expectedRedirect = http.expectedStatuses(302);
let logged = false;
function create(targetUrl, phase) {
  const startedAt = Date.now();
  const response = http.post(
    `${base}/graphql`,
    JSON.stringify({ query: mutation, variables: { input: { targetUrl } } }),
    {
      headers: {
        Host: "app.localhost:8080",
        "Content-Type": "application/json",
      },
      timeout: "3s",
      responseCallback: http.expectedStatuses(200),
      tags: { name: "POST UI /graphql", ...(phase ? { phase } : {}) },
    },
  );
  let body;
  try {
    body = response.json();
  } catch {}
  const link = body?.data?.createLink;
  const valid =
    response.status === 200 &&
    !body?.errors &&
    link?.targetUrl === targetUrl &&
    /^[A-Za-z0-9_-]{8}$/.test(link?.code ?? "");
  if (phase) {
    creationCorrect.add(valid, { phase });
    creationMs.add(Date.now() - startedAt, { phase });
  }
  if (!valid && !logged) {
    logged = true;
    console.error(
      `WEB_CREATION_FAILURE ${JSON.stringify({ phase, status: response.status, error: response.error })}`,
    );
  }
  return valid ? link : undefined;
}
export function setup() {
  const fixtures = [];
  for (let i = 0; i < 10; i++) {
    const targetUrl = `https://example.com/web-rollout/${i}`;
    const link = create(targetUrl);
    if (!link) throw new Error("UI GraphQL fixture creation failed");
    const response = http.get(`${base}/${link.code}`, {
      headers: { Host: "go.localhost:8080" },
      redirects: 0,
      timeout: "3s",
      responseCallback: expectedRedirect,
      tags: { name: "GET /:code (warmup)" },
    });
    if (response.status !== 302 || response.headers.Location !== targetUrl)
      throw new Error("Fixture warmup failed");
    fixtures.push(link);
  }
  console.log(`WEB_ROLLOUT_READY ${Date.now()}`);
  return fixtures;
}
function phase() {
  const ms = Date.now() - exec.scenario.startTime;
  return ms < 10000 ? "baseline" : ms < 70000 ? "rollout_window" : "after";
}
export function visit(fixtures) {
  const window = phase();
  const link = fixtures[exec.scenario.iterationInTest % fixtures.length];
  const startedAt = Date.now();
  const response = http.get(`${base}/${link.code}`, {
    headers: { Host: "go.localhost:8080" },
    redirects: 0,
    timeout: "3s",
    responseCallback: expectedRedirect,
    tags: { name: "GET /:code", phase: window },
  });
  const ms = Date.now() - startedAt;
  const valid =
    response.status === 302 &&
    response.headers.Location === link.targetUrl &&
    response.headers["Cache-Control"] === "no-store";
  redirectCorrect.add(valid, { phase: window });
  redirectBudget.add(valid && ms <= 100, { phase: window });
  redirectMs.add(ms, { phase: window });
  if (!valid && !logged) {
    logged = true;
    console.error(
      `WEB_REDIRECT_FAILURE ${JSON.stringify({ phase: window, status: response.status, error: response.error })}`,
    );
  }
}
export function createLink() {
  create("https://example.com/web-rollout/created-under-load", phase());
}
