import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const endpoints = __ENV.ENDPOINTS.split(",");
const correct = new Rate("handoff_redirect_correct");
const withinBudget = new Rate("handoff_redirect_within_100ms");
const validCreation = new Rate("handoff_creation_response_valid");
const creationSucceeded = new Counter("handoff_creations");
const maintenance = new Counter("handoff_maintenance_rejections");
const elapsed = new Trend("handoff_redirect_ms");
http.setResponseCallback(http.expectedStatuses(200, 201, 302, 503));
export const options = {
  summaryTrendStats: ["avg", "p(95)", "p(99)", "max"],
  scenarios: {
    reads: {
      executor: "constant-arrival-rate",
      rate: 25,
      timeUnit: "1s",
      duration: "90s",
      preAllocatedVUs: 4,
      maxVUs: 4,
      exec: "redirects",
    },
    writes: {
      executor: "constant-arrival-rate",
      rate: 2,
      timeUnit: "1s",
      duration: "90s",
      preAllocatedVUs: 2,
      maxVUs: 2,
      exec: "creations",
    },
  },
  thresholds: {
    dropped_iterations: ["count==0"],
    handoff_redirect_correct: ["rate==1"],
    handoff_redirect_within_100ms: ["rate>=0.99"],
    handoff_creation_response_valid: ["rate==1"],
    handoff_creations: ["count>=20"],
    handoff_maintenance_rejections: ["count>=2"],
  },
};
export function setup() {
  console.log("HANDOFF_READY");
}
function redirect(base, code, target) {
  const start = Date.now();
  const response = http.get(`${base}/${code}`, { redirects: 0, timeout: "2s" });
  const ms = Date.now() - start;
  const ok =
    response.status === 302 &&
    response.headers.Location === target &&
    response.headers["Cache-Control"] === "no-store";
  correct.add(ok);
  withinBudget.add(ok && ms <= 100);
  elapsed.add(ms);
  if (!ok)
    console.log(
      `READ_FAILURE ${JSON.stringify({ at: Date.now(), status: response.status, base, code })}`,
    );
}
export function redirects() {
  const iteration = exec.scenario.iterationInTest;
  const seed = iteration % 2;
  redirect(
    endpoints[iteration % endpoints.length],
    `seedA00${seed}`,
    `https://example.test/seed/${seed}`,
  );
}
export function creations() {
  const iteration = exec.scenario.iterationInTest;
  const base = endpoints[iteration % endpoints.length];
  const targetUrl = `https://example.test/handoff/${__ENV.RUN_ID}/${iteration}`;
  const graphql = iteration % 2 === 1;
  const body = graphql
    ? {
        query:
          "mutation($input:CreateLinkInput!){createLink(input:$input){code targetUrl}}",
        variables: { input: { targetUrl } },
      }
    : { targetUrl };
  const response = http.post(
    `${base}/${graphql ? "graphql" : "links"}`,
    JSON.stringify(body),
    { headers: { "Content-Type": "application/json" }, timeout: "3s" },
  );
  let data;
  try {
    data = response.json();
  } catch {
    data = {};
  }
  const link = graphql ? data.data?.createLink : data;
  const ok =
    response.status === (graphql ? 200 : 201) &&
    /^[A-Za-z0-9_-]{8}$/.test(link?.code ?? "") &&
    link.targetUrl === targetUrl;
  const rejected =
    response.status === 503 &&
    (graphql
      ? data.errors?.[0]?.extensions?.code === "MAINTENANCE"
      : data.code === "MAINTENANCE") &&
    response.headers["Retry-After"] === "1";
  validCreation.add(ok || rejected);
  if (ok) {
    creationSucceeded.add(1);
    console.log(
      `ACK ${JSON.stringify({ at: Date.now(), code: link.code, targetUrl, graphql })}`,
    );
    for (const endpoint of endpoints) redirect(endpoint, link.code, targetUrl);
  } else if (rejected) {
    maintenance.add(1);
    console.log(`MAINTENANCE ${JSON.stringify({ at: Date.now(), graphql })}`);
  } else
    console.log(
      `WRITE_FAILURE ${JSON.stringify({ at: Date.now(), graphql, status: response.status, body: response.body })}`,
    );
}
export function handleSummary(data) {
  return { stdout: `HANDOFF_SUMMARY ${JSON.stringify(data)}\n` };
}
