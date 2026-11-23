import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { KEY, startGateway } from "./gateway.mjs";

function child(mode, url) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [new URL("./edge-child.mjs", import.meta.url).pathname, mode, url, KEY], { timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}\n${stderr}`));
      resolve(JSON.parse(stdout.trim().split("\n").pop()));
    });
  });
}

test("edge entry with AsyncLocalStorage: groups turns, sends nothing until flush()", async () => {
  const gateway = await startGateway();
  const out = await child("als", gateway.url);
  assert.equal(out.queuedAfterWait, 2, "no background timer on the edge");
  assert.equal(out.flushed, true);
  const turns = gateway.spans();
  assert.deepEqual(turns.map((s) => s.attrs["zoroval.conversation.id"]).sort(), ["A", "B"]);
  assert.deepEqual(out.warnings, []);
  await gateway.close();
});

test("edge entry without AsyncLocalStorage: turns stay ungrouped, never mixed, one notice", async () => {
  const gateway = await startGateway();
  const out = await child("noals", gateway.url);
  assert.equal(out.flushed, true);
  const spans = gateway.spans();
  assert.equal(spans.length, 2);
  for (const s of spans) {
    assert.equal("zoroval.conversation.id" in s.attrs, false);
    assert.equal(s.attrs["zoroval.grouping"], "ungrouped");
  }
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /nodejs_als/);
  await gateway.close();
});

test("edge flush has a hard deadline: a stuck gateway is counted as failed, not retried forever", async () => {
  const gateway = await startGateway(() => ({ bytesPerSecond: 1024 }));
  const out = await child("als-slow", gateway.url);
  assert.equal(out.flushed, false);
  assert.ok(out.ms < 1500, `flush returned in ${out.ms} ms`);
  assert.equal(out.status.queueSpans, 0);
  assert.equal(out.status.spansFailed, 1);
  assert.ok(gateway.requests.length <= 3);
  await gateway.close();
});
