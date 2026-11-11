import { sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const startAt = Number(__ENV.BENCH_START_AT_MS);
const rate = Number(__ENV.RATE);
const phases = ["healthy", "timeout", "recovery"];
const good = new Rate("correct_redirect_within_100ms");
const elapsed = new Trend("redirect_elapsed", true);
const overload = new Counter("redirect_overload_responses");
const starts = new Counter("redirect_starts");
const hit = new Rate("redis_hit");
const sourceValid = new Rate("cache_source_valid");
const stableFallback = new Rate("stable_fault_fallback");
const recovered = new Rate("recovery_tail_hit");
const created = new Rate("link_creation_success");
const creationElapsed = new Trend("link_creation_elapsed", true);
const creations = new Counter("creation_starts");
const expectRedirect = http.expectedStatuses(302);
const expectCreated = http.expectedStatuses(201);

export const options = {
  discardResponseBodies: true,
  setupTimeout: "10s",
  summaryTrendStats: ["avg", "p(95)", "p(99)", "max"],
  thresholds: {
    dropped_iterations: ["count==0"],
    // Completed iterations also catch requests interrupted at gracefulStop.
    "iterations{scenario:redirect}": [`count>=${rate * 45 - 1}`],
    "iterations{scenario:create_link}": ["count>=449"],
    redirect_starts: [`count>=${rate * 45 - 1}`],
    creation_starts: ["count>=449"],
    cache_source_valid: ["rate==1"],
    stable_fault_fallback: ["rate==1"],
    recovery_tail_hit: ["rate==1"],
    ...Object.fromEntries(
      phases.flatMap((phase) => [
        [`correct_redirect_within_100ms{phase:${phase}}`, ["rate>=0.99"]],
        [
          `redirect_starts{phase:${phase}}`,
          // Allow 250ms for setup-to-scenario handoff.
          // The total count and zero dropped starts still require the full load.
          [`count>=${Math.floor(rate * 14.75)}`],
        ],
        [`link_creation_success{phase:${phase}}`, ["rate==1"]],
        [`creation_starts{phase:${phase}}`, ["count>=149"]],
        // Include separate latency/source submetrics in the summary.
        [`redirect_elapsed{phase:${phase}}`, ["max>=0"]],
        [`link_creation_elapsed{phase:${phase}}`, ["max>=0"]],
        [
          `redis_hit{phase:${phase}}`,
          [phase === "recovery" ? "rate>0" : "rate>=0"],
        ],
        [`redirect_overload_responses{phase:${phase}}`, ["count>=0"]],
      ]),
    ),
  },
  scenarios: {
    redirect: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration: "45s",
      preAllocatedVUs: Number(__ENV.BENCH_VUS || 400),
      gracefulStop: "2s",
      exec: "visit",
    },
    create_link: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "45s",
      preAllocatedVUs: 20,
      gracefulStop: "2s",
      exec: "createLink",
    },
  },
};

export function setup() {
  const remaining = startAt - Date.now();
  if (remaining < 0) throw new Error("k6 missed the scheduled trial start");
  sleep(remaining / 1000);
}

function phaseAt(time) {
  return phases[Math.min(2, Math.max(0, Math.floor((time - startAt) / 15000)))];
}

export function visit() {
  const code = String((exec.scenario.iterationInTest % 1000) + 1).padStart(
    8,
    "0",
  );
  const startedAt = Date.now();
  const tags = { phase: phaseAt(startedAt) };
  starts.add(1, tags);
  const response = http.get(`${__ENV.BASE_URL}/${code}`, {
    redirects: 0,
    timeout: "2s",
    responseCallback: expectRedirect,
    tags: { ...tags, name: "GET /:code" },
  });
  const ms = Date.now() - startedAt;
  const correct =
    response.status === 302 &&
    response.headers.Location === `https://example.com/benchmark/${code}`;
  good.add(correct && ms <= 100, tags);
  elapsed.add(ms, tags);
  overload.add(Number(response.status === 503), tags);
  const source = response.headers["X-Cache"];
  const timing = response.headers["Server-Timing"];
  const cacheHit = correct && source === "HIT" && timing === undefined;
  const fallback =
    correct &&
    ((source === "COALESCED" && timing === undefined) ||
      (source === undefined &&
        /^db_pool;dur=\d+\.\d+, db_lookup;dur=\d+\.\d+$/.test(timing ?? "")));
  hit.add(cacheHit, tags);
  sourceValid.add(
    !correct || (tags.phase === "healthy" ? cacheHit : cacheHit || fallback),
    tags,
  );
  const sinceStart = startedAt - startAt;
  if (correct && sinceStart >= 18000 && sinceStart < 27000) {
    stableFallback.add(fallback);
  }
  if (correct && sinceStart >= 40000) recovered.add(cacheHit);
}

export function createLink() {
  const startedAt = Date.now();
  const tags = { phase: phaseAt(startedAt) };
  creations.add(1, tags);
  const response = http.post(
    `${__ENV.BASE_URL}/links`,
    JSON.stringify({ targetUrl: "https://example.com/benchmark-created" }),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "2s",
      responseCallback: expectCreated,
      tags,
    },
  );
  created.add(response.status === 201, tags);
  creationElapsed.add(Date.now() - startedAt, tags);
}

export function handleSummary(data) {
  return { [__ENV.BENCH_SUMMARY_PATH]: JSON.stringify(data) };
}
