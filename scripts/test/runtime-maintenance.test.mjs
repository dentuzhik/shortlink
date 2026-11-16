import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

// Exercise the complete operator command with an isolated kubectl protocol fixture.
const fakeKubectl = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.MAINTENANCE_TEST_STATE;
let lock;
while (lock === undefined) {
  try { lock = fs.openSync(file + '.lock', 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}
process.on('exit', () => { fs.closeSync(lock); fs.rmSync(file + '.lock'); });
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if(args.includes('database-cutover')){if(state.cutover)process.stdout.write(JSON.stringify({metadata:{labels:{'shortlink.dev/exercise':'live-cutover'}},data:{'journal.json':JSON.stringify(state.cutover)}}));process.exit(0);}
const write = (value) => { fs.writeFileSync(file, JSON.stringify(state)); process.stdout.write(JSON.stringify(value)); };
const fail = () => { process.stderr.write('fixture request failed'); process.exit(1); };
if (args.includes('--raw')) {
  const path = args[args.indexOf('--raw') + 1];
  const pod = state.pods.find(p => path === '/api/v1/namespaces/shortlink/pods/http:' + p.name + ':9090/proxy/internal/maintenance');
  if (!pod) fail();
  pod.observations++;
  const stale = state.config.creationMode === 'reject' && (pod.terminating ? pod.observations < 4 : pod.name === 'second' && pod.observations < 3);
  const mode = stale ? 'accept' : state.config.creationMode;
  write({ observedRevision: stale ? state.config.revision - 1 : state.config.revision, configurationCurrent: true, configurationApplied: !stale, activeDatabase: state.config.activeDatabase || 'source', database: { preparedDatabase: state.config.prepareDatabase || null, candidateReady: Boolean(state.config.prepareDatabase) }, creationMode: mode, acceptingCreations: mode === 'accept', inflightCreations: 0, drained: mode === 'reject' });
} else if (args.includes('patch')) {
  const patch = JSON.parse(args[args.indexOf('-p') + 1]);
  if (!patch.some(p => p.op === 'test' && p.path === '/metadata/resourceVersion' && p.value === String(state.version))) fail();
  state.patchCalls++;
  state.version++;
  state.config = JSON.parse(patch.find(p => p.path === '/data/control.json').value);
  if (state.concurrentChange) state.config = { revision: state.config.revision + 1, creationMode: 'reject' };
  write({});
} else if (args.includes('configmap')) {
  write({ metadata: { resourceVersion: String(state.version) }, data: { 'control.json': JSON.stringify(state.config) } });
} else if (args.includes('deployment')) {
  write({ spec: { replicas: 2 } });
} else if (args.includes('pods')) {
  write({ items: state.pods.map(p => ({ metadata: { name: p.name, uid: p.name, ...(p.terminating ? { deletionTimestamp: '2026-11-15T00:00:00Z' } : {}) } })) });
} else fail();
`;

async function fixture(t, concurrentChange = false) {
  const directory = await mkdtemp(join(tmpdir(), "shortlink-operator-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");
  await writeFile(join(directory, "kubectl"), fakeKubectl, { mode: 0o700 });
  await writeFile(
    stateFile,
    JSON.stringify({
      config: { revision: 1, creationMode: "accept" },
      version: 1,
      patchCalls: 0,
      concurrentChange,
      pods: [
        { name: "first", observations: 0 },
        { name: "second", observations: 0 },
        { name: "old", terminating: true, observations: 0 },
      ],
    }),
  );
  const command = (...args) =>
    promisify(execFile)(
      process.execPath,
      [resolve("scripts/runtime-maintenance.mjs"), ...args],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          MAINTENANCE_TEST_STATE: stateFile,
        },
        timeout: 10000,
      },
    );
  return {
    command,
    state: async () => JSON.parse(await readFile(stateFile, "utf8")),
    cutover: async () => {
      const value = JSON.parse(await readFile(stateFile, "utf8"));
      value.cutover = { status: "paused" };
      await writeFile(stateFile, JSON.stringify(value));
    },
  };
}

test("an active cutover blocks ordinary maintenance mutations while status remains readable", async (t) => {
  const { command, state, cutover } = await fixture(t);
  await cutover();
  await assert.rejects(command("begin"), (error) =>
    error.stderr.includes("cutover journal"),
  );
  await command("status");
  assert.equal((await state()).patchCalls, 0);
});

test("maintenance command waits for both replicas and a still-serving terminating pod, then reopens", async (t) => {
  const { command, state } = await fixture(t);
  const begun = JSON.parse((await command("begin")).stdout);
  assert.equal(begun.desired.creationMode, "reject");
  assert.equal(begun.pods.length, 3);
  assert.ok(begun.pods.every((p) => p.drained && p.observedRevision === 2));
  assert.equal(begun.pods.find((p) => p.pod === "old").terminating, true);
  assert.ok(
    (await state()).pods.find((p) => p.name === "old").observations >= 4,
  );
  const ended = JSON.parse((await command("end")).stdout);
  assert.deepEqual(ended.desired, { revision: 3, creationMode: "accept" });
  assert.ok(
    ended.pods.every((p) => p.acceptingCreations && p.observedRevision === 3),
  );
  assert.equal((await state()).patchCalls, 2);
});

test("repeated begin and read-only status preserve the current revision", async (t) => {
  const { command, state } = await fixture(t);
  await command("begin");
  await command("begin");
  const status = JSON.parse((await command("status")).stdout);
  assert.equal(status.desired.revision, 2);
  assert.equal((await state()).patchCalls, 1);
});

test("concurrent configuration changes abort coordination without a compensating reopen", async (t) => {
  const { command, state } = await fixture(t, true);
  await assert.rejects(
    command("begin"),
    (error) =>
      error.code === 1 && error.stderr.includes("changed concurrently"),
  );
  assert.deepEqual((await state()).config, {
    revision: 3,
    creationMode: "reject",
  });
  assert.equal((await state()).patchCalls, 1);
});

test("prepare, maintenance and reopening preserve the selected database configuration", async (t) => {
  const { command, state } = await fixture(t);
  await command("prepare", "ha");
  await assert.rejects(command("switch", "ha"), (error) =>
    error.stderr.includes("Begin maintenance"),
  );
  await command("begin");
  assert.equal((await state()).config.prepareDatabase, "ha");
  await command("switch", "ha");
  await command("end");
  assert.deepEqual((await state()).config, {
    revision: 5,
    creationMode: "accept",
    prepareDatabase: null,
    activeDatabase: "ha",
  });
});
