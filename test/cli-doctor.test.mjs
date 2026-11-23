import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { KEY, SETUP_CODE, makeProject, runCli, startApp, startGateway } from "./cli-fakes.mjs";

const doctor = (gw, dir, extra = [], env = {}) =>
  runCli(["doctor", "--root", dir, "--ingest-url", gw.url, "--timeout", "5", ...extra], { cwd: dir, env: { ZOROVAL_INGEST_KEY: KEY, ...env } });
const json = (r) => JSON.parse(r.stdout);
const levels = (r) => json(r).checks.map((c) => `${c.level}:${c.check}`);

test("doctor passes: checks in order, text lines, exit 0, key never shown", async () => {
  const gw = await startGateway({ firstTrace: "2026-11-23T10:00:00Z" });
  const dir = makeProject();
  const r = await doctor(gw, dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "[ok  ] sdk: zoroval 0.1.0");
  assert.deepEqual(lines.slice(1).map((l) => l.split(":")[0]), [
    "[ok  ] key", "[ok  ] gateway", "[ok  ] test trace", "[ok  ] test trace processed", "[ok  ] grouping", "[ok  ] first trace received", "Doctor",
  ]);
  assert.equal(lines[1], "[ok  ] key: found in environment, key id abcdefghijkl");
  assert.equal(lines[2], `[ok  ] gateway: ${gw.url} accepts the key; project proj_1`);
  assert.match(lines[3], /^\[ok  \] test trace: sent 2 test turns, batch [0-9a-f-]{36}$/);
  assert.equal(lines[4], "[ok  ] test trace processed: batch done, 4 spans");
  assert.equal(lines[5], "[ok  ] grouping: 2 test turns with one conversation id became 1 trace");
  assert.equal(lines[6], "[ok  ] first trace received: app traces are arriving (first at 2026-11-23T10:00:00Z)");
  assert.equal(lines[7], "Doctor: all required checks passed.");
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  await gw.close();
});

test("doctor --json has the same shape as Python's", async () => {
  const gw = await startGateway({ firstTrace: "2026-11-23T10:00:00Z" });
  const r = await doctor(gw, makeProject(), ["--json"]);
  const out = json(r);
  assert.deepEqual(Object.keys(out), ["ok", "checks"]);
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out.checks[0]), ["level", "check", "detail"]);
  assert.match(r.stdout, /^\{\n {2}"ok": true,\n {2}"checks": \[\n {4}\{\n {6}"level": "pass",/);
  await gw.close();
});

test("the test trace: two turns, one conversation, each with a child step, boolean zoroval.test, explicit grouping", async () => {
  const gw = await startGateway();
  const r = await doctor(gw, makeProject());
  assert.equal(r.code, 0);
  const post = gw.posts()[0];
  assert.equal(post.headers["content-encoding"], "gzip");
  assert.equal(post.headers["content-type"], "application/json");
  assert.equal(post.headers.authorization, `Bearer ${KEY}`);
  assert.equal(post.headers["user-agent"], "zoroval-js/0.1.0");
  assert.equal(post.path, "/v1/traces");
  assert.equal(post.resource["service.name"], "zoroval-doctor");
  assert.equal(post.resource["zoroval.sdk.name"], "zoroval-js");
  assert.equal(post.scope.name, "zoroval");
  const turns = post.spans.filter((s) => s.attrs["zoroval.observation.type"] === "turn");
  const steps = post.spans.filter((s) => s.attrs["zoroval.observation.type"] === "step");
  assert.equal(turns.length, 2);
  assert.equal(steps.length, 2);
  const conversation = turns[0].attrs["zoroval.conversation.id"];
  assert.match(conversation, /^zoroval-doctor-[0-9a-f-]{36}$/);
  for (const turn of turns) {
    assert.equal(turn.attrs["zoroval.conversation.id"], conversation);
    assert.equal(turn.attrs["gen_ai.conversation.id"], conversation);
    assert.equal(turn.attrs["zoroval.grouping"], "explicit");
    assert.equal(turn.name, "zoroval doctor turn");
    assert.equal(turn.parentSpanId, undefined);
    // the type matters: a boolean, not the string "true"
    const raw = turn.rawAttrs.find((a) => a.key === "zoroval.test");
    assert.deepEqual(raw.value, { boolValue: true });
    assert.equal(turn.attrs["zoroval.input"].startsWith('"zoroval doctor test turn '), true);
  }
  assert.notEqual(turns[0].traceId, turns[1].traceId);
  for (const step of steps) {
    assert.equal(step.attrs["zoroval.conversation.id"], conversation);
    assert.equal(step.name, "zoroval doctor step");
    const parent = turns.find((t) => t.spanId === step.parentSpanId);
    assert.ok(parent, "a step hangs under a turn");
    assert.equal(parent.traceId, step.traceId);
    assert.equal(step.attrs["zoroval.test"], undefined);
  }
  assert.match(post.raw.resourceSpans[0].scopeSpans[0].spans[0].traceId, /^[0-9a-f]{32}$/);
  await gw.close();
});

test("the batch id that was sent is the one polled, and printed", async () => {
  const gw = await startGateway();
  const r = await doctor(gw, makeProject());
  const sent = gw.posts()[0].headers["x-zoroval-batch-id"];
  assert.match(r.stdout, new RegExp(`batch ${sent}`));
  assert.ok(gw.gets().some((g) => g.url.includes(`batch_id=${sent}`) && g.url.includes("since=")));
  assert.ok(gw.gets().every((g) => g.headers.authorization === `Bearer ${KEY}`));
  assert.ok(gw.gets().some((g) => g.url.includes("since=") && !g.url.includes("batch_id"))); // the 24 h poll
  const since = new URL(gw.gets().find((g) => g.url.includes("batch_id")).url, "http://x").searchParams.get("since");
  assert.match(since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  await gw.close();
});

test("ZOROVAL_SERVICE_NAME becomes the service name", async () => {
  const gw = await startGateway();
  await doctor(gw, makeProject(), [], { ZOROVAL_SERVICE_NAME: "my-svc", ZOROVAL_ENVIRONMENT: "prod", ZOROVAL_RELEASE: "9" });
  assert.equal(gw.posts()[0].resource["service.name"], "my-svc");
  assert.equal(gw.posts()[0].resource["deployment.environment.name"], undefined); // like Python: only what doctor sets
  await gw.close();
});

test("no key anywhere: FAIL key, exit 1, nothing sent, no network", async () => {
  const gw = await startGateway();
  const dir = makeProject();
  const r = await runCli(["doctor", "--root", dir, "--ingest-url", gw.url], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\[FAIL\] key: ZOROVAL_INGEST_KEY not found in the environment or \.env, \.dev\.vars, \.env\.local\. Run `npx zoroval login`\./);
  assert.match(r.stdout, /Doctor: failed\. Fix the FAIL lines above\./);
  assert.equal(gw.requests.length, 0);
  await gw.close();
});

test("a key that is not an ingest key fails and is not sent anywhere", async () => {
  const gw = await startGateway();
  const dir = makeProject();
  const r = await runCli(["doctor", "--root", dir, "--ingest-url", gw.url, "--json"], { cwd: dir, env: { ZOROVAL_INGEST_KEY: "hunter2" } });
  assert.equal(r.code, 1);
  assert.deepEqual(json(r).checks.at(-1), { level: "fail", check: "key", detail: "ZOROVAL_INGEST_KEY (from environment) is not a Zoroval ingest key." });
  assert.ok(!r.stdout.includes("hunter2"));
  assert.equal(gw.requests.length, 0);
  await gw.close();
});

test("the key is read from the project's env file, with a warning that the shell does not have it", async () => {
  const gw = await startGateway();
  const dir = makeProject({ files: { "wrangler.toml": 'name="w"\ncompatibility_flags=["nodejs_als"]', ".dev.vars": `ZOROVAL_INGEST_KEY=${KEY}\nZOROVAL_INGEST_URL=${gw.url}\n` } });
  const r = await runCli(["doctor", "--root", dir, "--timeout", "5", "--json"], { cwd: dir });
  assert.equal(r.code, 0, r.stdout);
  const checks = json(r).checks;
  assert.equal(checks.find((c) => c.check === "key").detail, "found in .dev.vars, key id abcdefghijkl");
  assert.equal(checks.find((c) => c.check === "key loading").level, "warn");
  assert.match(checks.find((c) => c.check === "key loading").detail, /not in this shell's environment.*wrangler dev.*\.dev\.vars/);
  assert.equal(checks.find((c) => c.check === "gateway").detail.startsWith(gw.url), true); // URL from the file
  await gw.close();
});

test("--env-file (via --file) is used when given, and only that file", async () => {
  const gw = await startGateway();
  const dir = makeProject({ files: { ".env": "ZOROVAL_INGEST_KEY=wrong\n", ".env.production": `ZOROVAL_INGEST_KEY=${KEY}\n` } });
  const r = await runCli(["doctor", "--root", dir, "--ingest-url", gw.url, "--file", ".env.production", "--json", "--timeout", "5"], { cwd: dir });
  assert.equal(r.code, 0, r.stdout);
  assert.match(json(r).checks.find((c) => c.check === "key").detail, /found in \.env\.production/);
  await gw.close();
});

test("the gateway refuses the key (401): FAIL with advice, exit 1, no test trace", async () => {
  const gw = await startGateway({ key: "zv_ingest_zzzzzzzzzzzz_0123456789ABCDEFGHIJ" });
  const r = await doctor(gw, makeProject());
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\[FAIL\] gateway: the gateway refused the key \(401 invalid_key\)\. Run `npx zoroval login --replace` or make a new key in the app\./);
  assert.equal(gw.posts().length, 0);
  await gw.close();
});

test("the gateway answers 503: FAIL gateway with the status", async () => {
  const gw = await startGateway({ statusCode: 503, statusMessage: "unavailable" });
  const r = await doctor(gw, makeProject());
  assert.equal(r.code, 1);
  assert.match(r.stdout, new RegExp(`\\[FAIL\\] gateway: ${gw.url.replace(/\./g, "\\.")} answered 503 \\(unavailable\\)\\.`));
  await gw.close();
});

test("no connection to the gateway: FAIL gateway, nothing", async () => {
  const dir = makeProject();
  const r = await runCli(["doctor", "--root", dir, "--ingest-url", "http://127.0.0.1:9", "--json"], { cwd: dir, env: { ZOROVAL_INGEST_KEY: KEY } });
  assert.equal(r.code, 1);
  assert.match(json(r).checks.at(-1).detail, /answered nothing \(connection:/);
});

test("a plain-http ingest URL that is not localhost is refused before the key is sent", async () => {
  const dir = makeProject();
  const r = await runCli(["doctor", "--root", dir, "--ingest-url", "http://example.test", "--json"], { cwd: dir, env: { ZOROVAL_INGEST_KEY: KEY } });
  assert.equal(r.code, 1);
  assert.match(json(r).checks.at(-1).detail, /answered nothing \(refused: the ingest URL must be https/);
});

test("the test trace is not accepted: FAIL test trace", async () => {
  const gw = await startGateway({ tracesStatus: 400, tracesMessage: "bad_otlp" });
  const r = await doctor(gw, makeProject(), ["--json"]);
  assert.equal(r.code, 1);
  assert.deepEqual(json(r).checks.at(-1), { level: "fail", check: "test trace", detail: "not accepted (400 bad_otlp)" });
  await gw.close();
});

test("the batch never gets processed: FAIL test trace processed after the timeout", async () => {
  const gw = await startGateway({ batchStatus: "received" });
  const started = Date.now();
  const r = await doctor(gw, makeProject(), ["--timeout", "1", "--json"]);
  assert.equal(r.code, 1);
  assert.deepEqual(json(r).checks.at(-1), { level: "fail", check: "test trace processed", detail: "batch status received after 1s" });
  assert.ok(Date.now() - started < 6000);
  await gw.close();
});

test("the batch fails: FAIL test trace processed", async () => {
  const gw = await startGateway({ batchStatus: "failed" });
  const r = await doctor(gw, makeProject(), ["--json"]);
  assert.equal(r.code, 1);
  assert.equal(json(r).checks.at(-1).detail, "batch status failed after 5s");
  await gw.close();
});

test("the two turns are not grouped: FAIL grouping", async () => {
  const gw = await startGateway({ groupTurns: false });
  const r = await doctor(gw, makeProject(), ["--json"]);
  assert.equal(r.code, 1);
  assert.deepEqual(json(r).checks.find((c) => c.check === "grouping"), { level: "fail", check: "grouping", detail: "expected 1 trace from 2 turns, got 2 trace ids and 2 turns" });
  await gw.close();
});

test("--no-test-trace sends nothing and only reads status", async () => {
  const gw = await startGateway({ firstTrace: "2026-11-23T10:00:00Z" });
  const r = await doctor(gw, makeProject(), ["--no-test-trace", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(gw.posts().length, 0);
  assert.deepEqual(levels(r), ["pass:sdk", "pass:key", "pass:gateway", "pass:first trace received"]);
  await gw.close();
});

test("no app traces yet: WARN, exit 0; with --wait it waits and then FAILs", async () => {
  const gw = await startGateway();
  let r = await doctor(gw, makeProject(), ["--no-test-trace", "--json"]);
  assert.equal(r.code, 0);
  assert.deepEqual(json(r).checks.at(-1), { level: "warn", check: "first trace received", detail: "no app traces yet. Run your app once, then `npx zoroval doctor --wait 60`." });
  const started = Date.now();
  r = await doctor(gw, makeProject(), ["--no-test-trace", "--wait", "2", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(json(r).checks.at(-1).level, "fail");
  assert.ok(Date.now() - started >= 1900);
  await gw.close();
});

test("ungrouped turns, dropped spans and ingest errors are warnings", async () => {
  const gw = await startGateway({ firstTrace: "2026-11-23T10:00:00Z", since: { ungrouped_turns: 7, dropped_spans_reported: 3, errors: [{ reason_code: "span_too_large", count: 2 }] } });
  const r = await doctor(gw, makeProject(), ["--no-test-trace", "--json"]);
  assert.equal(r.code, 0);
  const warns = json(r).checks.filter((c) => c.level === "warn");
  assert.deepEqual(warns.map((w) => w.check), ["grouping (app)", "dropped spans", "ingest errors"]);
  assert.match(warns[0].detail, /^7 turns in the last 24 h arrived ungrouped\. Wrap chat handlers in zoroval\.conversation\(chatId, \.\.\.\) so one chat is one trace\.$/);
  assert.equal(warns[1].detail, "the SDK reported 3 dropped spans in the last 24 h (queue full or failed sends).");
  assert.equal(warns[2].detail, "span_too_large: 2");
  await gw.close();
});

// ------------------------------------------------------------------ the Worker context flag

const workerChecks = async (files, expectWarn) => {
  const gw = await startGateway({ firstTrace: "2026-11-23T10:00:00Z" });
  const dir = makeProject({ files });
  const r = await doctor(gw, dir, ["--no-test-trace", "--json"]);
  const warn = json(r).checks.find((c) => c.check === "worker context");
  assert.equal(r.code, 0, "a missing flag is a warning, never a failure");
  if (expectWarn) assert.equal(warn.level, "warn");
  else assert.equal(warn, undefined);
  await gw.close();
  return warn;
};

test("a Worker without nodejs_als or nodejs_compat gets a warning that says how to fix it", async () => {
  const toml = await workerChecks({ "wrangler.toml": 'name = "w"\nmain = "src/index.ts"\ncompatibility_date = "2025-01-01"\n' }, true);
  assert.equal(toml.detail, 'wrangler.toml has neither the nodejs_als nor the nodejs_compat compatibility flag, so turns will not be grouped into conversations. Add compatibility_flags = ["nodejs_als"] to wrangler.toml and deploy again.');
  const json5 = await workerChecks({ "wrangler.jsonc": '{\n  // my worker\n  "name": "w",\n  "compatibility_flags": ["streams_enable_constructors"],\n}' }, true);
  assert.match(json5.detail, /^wrangler\.jsonc has neither .* Add "compatibility_flags": \["nodejs_als"\] to wrangler\.jsonc and deploy again\.$/);
  await workerChecks({ "wrangler.json": '{"name":"w"}' }, true);
});

test("the warning comes before the key checks, so it shows even when the key is missing", async () => {
  const dir = makeProject({ files: { "wrangler.toml": 'name = "w"' } });
  const r = await runCli(["doctor", "--root", dir, "--json"], { cwd: dir });
  assert.deepEqual(levels(r), ["pass:sdk", "warn:worker context", "fail:key"]);
  assert.equal(r.code, 1);
});

test("a Worker with nodejs_als or nodejs_compat gets no warning", async () => {
  await workerChecks({ "wrangler.toml": 'name = "w"\ncompatibility_flags = ["nodejs_als"]\n' }, false);
  await workerChecks({ "wrangler.toml": 'name = "w"\ncompatibility_flags = [\n  "a", # comment\n  "nodejs_compat",\n]\n' }, false);
  await workerChecks({ "wrangler.json": '{"compatibility_flags":["nodejs_compat"]}' }, false);
  await workerChecks({ "wrangler.jsonc": '{\n // c\n "compatibility_flags": ["nodejs_als",],\n}' }, false);
});

test("a project that is not a Worker gets no Worker check", async () => {
  await workerChecks({ "package.json": '{"dependencies":{"next":"15"}}' }, false);
});

// ------------------------------------------------------------------ progress and packages

test("doctor reports doctor_started (after started) when a setup code is set", async () => {
  const gw = await startGateway();
  const app = await startApp({ "/api/agent-setup/progress": [202, { status: "ok" }] });
  const dir = makeProject();
  await doctor(gw, dir, ["--no-test-trace"], { ZOROVAL_SETUP: SETUP_CODE, ZOROVAL_APP_URL: app.url });
  assert.deepEqual(app.events(), ["started", "doctor_started"]);
  await gw.close(); await app.close();
});

test("installed packages are listed from node_modules", async () => {
  const gw = await startGateway();
  const dir = makeProject({ files: { "node_modules/openai/package.json": '{"version":"5.1.0"}' } });
  const r = await doctor(gw, dir, ["--no-test-trace", "--json"]);
  assert.deepEqual(json(r).checks.slice(0, 2), [
    { level: "pass", check: "sdk", detail: "zoroval 0.1.0" },
    { level: "pass", check: "package openai", detail: "5.1.0" },
  ]);
  await gw.close();
});
