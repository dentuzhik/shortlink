import exec from "k6/execution";
import http from "k6/http";
import { Rate, Trend } from "k6/metrics";

const baseUrl = __ENV.BASE_URL ?? "http://127.0.0.1:8080";
const expectedRedirect = http.expectedStatuses(302);
const expectedMissing = http.expectedStatuses(404);
const expectedCreated = http.expectedStatuses(201);
const expectedGraphql = http.expectedStatuses(200);
const existingCorrect = new Rate("existing_redirect_correct");
const missingCorrect = new Rate("missing_redirect_correct");
const creationCorrect = new Rate("graphql_creation_correct");
const clientDuration = new Trend("existing_redirect_client_ms", true);
const within100ms = new Rate("existing_redirect_within_100ms");

export const options = {
  summaryTrendStats: ["avg", "p(95)", "p(99)", "max"],
  scenarios: {
    redirect: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      gracefulStop: "5s",
      exec: "visit",
      stages: [
        { duration: "15s", target: 100 },
        { duration: "30s", target: 100 },
        { duration: "15s", target: 500 },
        { duration: "45s", target: 500 },
        { duration: "15s", target: 1000 },
        { duration: "45s", target: 1000 },
        { duration: "15s", target: 100 },
        { duration: "30s", target: 100 },
        { duration: "15s", target: 0 },
      ],
    },
    create_link: {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: "1s",
      duration: "225s",
      preAllocatedVUs: 5,
      gracefulStop: "5s",
      exec: "createLink",
    },
  },
  thresholds: {
    dropped_iterations: ["count==0"],
    existing_redirect_correct: ["rate>=0.99"],
    missing_redirect_correct: ["rate==1"],
    graphql_creation_correct: ["rate==1"],
    "iterations{scenario:create_link}": ["count>=224"],
  },
};

export function setup() {
  const fixtures = [];
  for (let i = 0; i < 50; i++) {
    const targetUrl = `https://example.com/observability/${i}`;
    const response = http.post(
      `${baseUrl}/links`,
      JSON.stringify({ targetUrl }),
      {
        headers: {
          Host: "go.localhost:8080",
          "Content-Type": "application/json",
        },
        timeout: "3s",
        responseCallback: expectedCreated,
        tags: { name: "POST /links (fixtures)" },
      },
    );
    if (response.status !== 201)
      throw new Error(`Fixture creation failed: ${response.status}`);
    fixtures.push({ code: response.json("code"), targetUrl });
  }
  console.log(
    `Created ${fixtures.length} fixture links. The demo also creates about 225 links through GraphQL.`,
  );
  return fixtures;
}

export function visit(fixtures) {
  const missing = exec.scenario.iterationInTest % 20 === 0;
  const fixture = fixtures[exec.scenario.iterationInTest % fixtures.length];
  const code = missing ? "observability-missing" : fixture.code;
  const startedAt = Date.now();
  const response = http.get(`${baseUrl}/${code}`, {
    headers: { Host: "go.localhost:8080" },
    redirects: 0,
    timeout: "3s",
    responseCallback: missing ? expectedMissing : expectedRedirect,
    tags: { name: "GET /:code", kind: missing ? "missing" : "existing" },
  });
  if (missing) {
    missingCorrect.add(response.status === 404);
  } else {
    const ms = Date.now() - startedAt;
    const correct =
      response.status === 302 &&
      response.headers.Location === fixture.targetUrl;
    existingCorrect.add(correct);
    within100ms.add(correct && ms <= 100);
    clientDuration.add(ms);
  }
}

export function createLink() {
  const response = http.post(
    `${baseUrl}/graphql`,
    JSON.stringify({
      query:
        "mutation CreateLink($input: CreateLinkInput!) { createLink(input: $input) { code targetUrl } }",
      variables: {
        input: { targetUrl: "https://example.com/observability-created" },
      },
    }),
    {
      headers: {
        Host: "app.localhost:8080",
        "Content-Type": "application/json",
      },
      timeout: "3s",
      responseCallback: expectedGraphql,
      tags: { name: "POST /graphql" },
    },
  );
  let body = null;
  try {
    if (response.status === 200) body = response.json();
  } catch {
    // A malformed 200 response must count as a failed operation too.
  }
  creationCorrect.add(
    response.status === 200 &&
      !body?.errors &&
      /^[A-Za-z0-9_-]{8}$/.test(body?.data?.createLink?.code ?? ""),
  );
}
