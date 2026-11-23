import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { KEY, startGateway } from "./gateway.mjs";

function run(mode, url, onReady) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("./exit-child.mjs", import.meta.url).pathname, mode, url, KEY], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("ready") && onReady) { onReady(child); onReady = null; } });
    child.on("exit", (code, signal) => resolve({ code, signal }));
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
  });
}

test("a script that just ends sends its spans (beforeExit flush)", async () => {
  const gateway = await startGateway();
  const { code } = await run("natural", gateway.url);
  assert.equal(code, 0);
  assert.equal(gateway.spans().length, 1);
  await gateway.close();
});

test("SIGTERM flushes, then the process still exits the way it would have", async () => {
  const gateway = await startGateway();
  const { signal } = await run("sigterm", gateway.url, (child) => setTimeout(() => child.kill("SIGTERM"), 100));
  assert.equal(signal, "SIGTERM", "default SIGTERM behaviour is kept");
  assert.equal(gateway.spans().length, 1);
  await gateway.close();
});

test("SIGTERM with the app's own handler: flush, and the app decides when to exit", async () => {
  const gateway = await startGateway();
  const { code, signal } = await run("sigterm-app", gateway.url, (child) => setTimeout(() => child.kill("SIGTERM"), 100));
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(gateway.spans().length, 1);
  await gateway.close();
});

// An unreachable ingest URL must not hold the process open: the exit flush is bounded and then stops retrying.
function runUnreachable(mode, onReady) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [new URL("./exit-child.mjs", import.meta.url).pathname, mode, "http://127.0.0.1:9", KEY], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("ready") && onReady) { onReady(child); onReady = null; } });
    child.on("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - started }));
    setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
  });
}

test("a script that ends while the ingest URL is unreachable exits within the shutdown timeout, not minutes later", async () => {
  const { code, signal, ms } = await runUnreachable("natural");
  assert.equal(signal, null, "it was not killed by the test's own timeout");
  assert.equal(code, 0);
  assert.ok(ms < 9000, `exited after ${ms} ms`);
});

test("SIGTERM with an unreachable ingest URL: bounded flush, then the default exit", async () => {
  const { signal, ms } = await runUnreachable("sigterm", (child) => setTimeout(() => child.kill("SIGTERM"), 200));
  assert.equal(signal, "SIGTERM");
  assert.ok(ms < 9000, `exited after ${ms} ms`);
});
