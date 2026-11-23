// Login polling and doctor on a slow link. The fakes answer late (1.2 s on every request, like a 2G
// round trip plus a loaded server); both commands must still finish inside their deadlines.
// test/cli-slowproxy.manual.mjs does the same through the team's slowproxy (25 KB/s up, 300 ms latency).
import assert from "node:assert/strict";
import { test } from "node:test";
import { KEY, SETUP_CODE, connectReply, keyReply, makeProject, runCli, startApp, startGateway } from "./cli-fakes.mjs";

const LATENCY = 1200;

test("login on a slow link: sign-in, three pending polls and the key, inside --timeout", async () => {
  const app = await startApp({
    "/api/agent-connect": [200, connectReply({ interval: 0.5 })],
    "/api/agent-connect/token": (_b, i) => (i < 3 ? [202, { status: "pending" }] : [200, keyReply()]),
  }, { latencyMs: LATENCY });
  const dir = makeProject();
  const started = Date.now();
  const r = await runCli(["login", "--root", dir, "--app-url", app.url, "--no-browser", "--timeout", "30"], { cwd: dir });
  const took = Date.now() - started;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(took < 30_000, `took ${took} ms`);
  assert.equal(app.paths().filter((p) => p === "/api/agent-connect/token").length, 4);
  await app.close();
});

test("login with a setup code on a slow link: progress reports never hold it up beyond their 2 s", async () => {
  const app = await startApp({
    "/api/agent-setup/progress": [202, {}],
    "/api/agent-connect": [200, connectReply({ approved: true, handle: "#ZVtree", project_name: "Shop" })],
    "/api/agent-connect/token": [200, keyReply()],
  }, { latencyMs: 2500 }); // slower than the progress timeout, faster than the request timeout
  const dir = makeProject();
  const started = Date.now();
  const r = await runCli(["login", "--root", dir, "--app-url", app.url, "--timeout", "60"], { cwd: dir, env: { ZOROVAL_SETUP: SETUP_CODE } });
  const took = Date.now() - started;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stderr, "");
  assert.ok(took < 15_000, `took ${took} ms`); // 2 s for `started`, 2.5 s connect, 2.5 s token
  await app.close();
});

test("doctor on a slow link: every request is late and it still passes within --timeout", async () => {
  const gw = await startGateway({ firstTrace: "2026-11-23T10:00:00Z", latencyMs: LATENCY });
  const dir = makeProject();
  const started = Date.now();
  const r = await runCli(["doctor", "--root", dir, "--ingest-url", gw.url, "--timeout", "30", "--json"], { cwd: dir, env: { ZOROVAL_INGEST_KEY: KEY } });
  const took = Date.now() - started;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(JSON.parse(r.stdout).ok);
  assert.ok(took < 30_000, `took ${took} ms`);
  await gw.close();
});

test("doctor on a link that is too slow gives up inside its deadline and says so", async () => {
  const gw = await startGateway({ latencyMs: 20_000 }); // the status call times out (10 s) before it is answered
  const dir = makeProject();
  const started = Date.now();
  const r = await runCli(["doctor", "--root", dir, "--ingest-url", gw.url, "--timeout", "5", "--json"], { cwd: dir, env: { ZOROVAL_INGEST_KEY: KEY } });
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout).checks.at(-1).detail, /answered nothing \(connection:/);
  assert.ok(Date.now() - started < 15_000);
  await gw.close();
});
