// 2G: a slow fake gateway reads the request body at a throttled rate.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, afterEach } from "node:test";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway } from "./gateway.mjs";

afterEach(async () => { await zoroval.shutdown(500); });

// Incompressible content, so the gzip body is about as big as the text.
const noise = (bytes) => randomBytes(bytes).toString("base64");
const send = (id, bytes) => zoroval.conversation(id, () => zoroval.turn({ input: noise(bytes) }, () => {}));

test("2G: the timeout grows with the body, so a slow but working link delivers the batch", async () => {
  const gateway = await startGateway(() => ({ bytesPerSecond: 90 * 1024 }));
  // The 400 ms floor alone would time out; the body-size allowance (64 KiB/s) is what lets it through.
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, requestTimeoutMs: 400, flushIntervalMs: 10 });
  await send("a", 240_000);
  const started = Date.now();
  assert.equal(await zoroval.flush(15_000), true);
  const status = zoroval.status();
  assert.equal(status.spansExported, 1);
  assert.equal(gateway.requests.length, 1, "one request, no retries");
  assert.ok(Date.now() - started > 1500, "the link really was slow");
  await gateway.close();
});

test("2G: a link too slow for the deadline fails cleanly: bounded retries, shutdown on time, counted", async () => {
  const gateway = await startGateway(() => ({ bytesPerSecond: 4 * 1024 }));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, requestTimeoutMs: 300, maxAttempts: 2, flushIntervalMs: 10 });
  for (let i = 0; i < 4; i++) await send(`c${i}`, 24_000);
  const started = Date.now();
  assert.equal(await zoroval.flush(2500), false);
  const result = await zoroval.shutdown(1000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4200, `shut down within the deadline, took ${elapsed} ms`);
  assert.equal(result.spansExported, 0);
  assert.ok(result.batchesSplit >= 1, "a timeout on a batch of several spans halves it");
  assert.ok(result.spansFailed + result.queueSpans >= 4 || result.spansFailed >= 1);
  assert.ok(gateway.requests.length <= 14, `no endless retries: ${gateway.requests.length} requests`);
  assert.equal(result.queueSpans, 0);
  await gateway.close();
});

test("2G: the first span through a slow link is not lost when a later halved batch gets through", async () => {
  // Slow for the first (big) request only; the halves are small enough for the timeout.
  const gateway = await startGateway((req, i) => (i === 0 ? { bytesPerSecond: 3 * 1024 } : {}));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, requestTimeoutMs: 400, maxAttempts: 2, flushIntervalMs: 10 });
  for (let i = 0; i < 4; i++) await send(`c${i}`, 20_000);
  assert.equal(await zoroval.flush(15_000), true);
  const status = zoroval.status();
  assert.equal(status.spansExported, 4);
  assert.ok(status.batchesSplit >= 1);
  const ids = new Set(gateway.spans().map((s) => s.spanId));
  assert.equal(ids.size, 4);
  await gateway.close();
});
