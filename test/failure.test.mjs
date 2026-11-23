import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway, withWarnings, sleep } from "./gateway.mjs";

afterEach(async () => { await zoroval.shutdown(500); });

const fast = { flushIntervalMs: 10 };
const chat = (id = "c") => zoroval.conversation(id, () => zoroval.turn({ input: "hi" }, async (t) => { t.setOutput("yo"); return "answer"; }));

test("check 5: no key means nothing sent, nothing logged, functions return normally", async () => {
  const gateway = await startGateway();
  const saved = process.env.ZOROVAL_INGEST_KEY;
  delete process.env.ZOROVAL_INGEST_KEY;
  try {
    const logged = await withWarnings(async () => {
      assert.equal(zoroval.init({ ingestUrl: gateway.url }), false);
      assert.equal(await chat(), "answer");
      assert.equal(await zoroval.step("s", async () => 1), 1);
      assert.equal(await zoroval.tool("t", () => 2), 2);
      zoroval.setUser("u"); zoroval.setTags("a"); zoroval.setMetadata({ a: 1 });
      zoroval.currentObservation().setOutput("x");
      assert.equal(await zoroval.flush(200), true);
      const result = await zoroval.shutdown(200);
      assert.equal(result.active, false);
    });
    assert.deepEqual(logged, []);
    assert.equal(gateway.requests.length, 0);
  } finally {
    if (saved !== undefined) process.env.ZOROVAL_INGEST_KEY = saved;
    await gateway.close();
  }
});

test("explicit apiKey wins over the environment; env key is read when none is given", async () => {
  const gateway = await startGateway();
  const saved = process.env.ZOROVAL_INGEST_KEY;
  process.env.ZOROVAL_INGEST_KEY = "zv_ingest_zzzzzzzzzzzz_ENVENVENVENVENVENVENV";
  try {
    zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
    await chat(); await zoroval.flush(2000);
    assert.equal(gateway.requests[0].headers.authorization, `Bearer ${KEY}`);
    await zoroval.shutdown(500);
    zoroval.init({ ingestUrl: gateway.url, ...fast });
    await chat(); await zoroval.flush(2000);
    assert.equal(gateway.requests[1].headers.authorization, "Bearer zv_ingest_zzzzzzzzzzzz_ENVENVENVENVENVENVENV");
  } finally {
    if (saved === undefined) delete process.env.ZOROVAL_INGEST_KEY; else process.env.ZOROVAL_INGEST_KEY = saved;
    await gateway.close();
  }
});

test("enabled false, a bad ingest URL and a plain-http remote URL are silent no-ops", async () => {
  const logged = await withWarnings(async () => {
    assert.equal(zoroval.init({ apiKey: KEY, enabled: false }), false);
    assert.equal(zoroval.init({ apiKey: KEY, ingestUrl: "not a url" }), false);
    assert.equal(zoroval.init({ apiKey: KEY, ingestUrl: "http://example.com" }), false);
    assert.equal(await chat(), "answer");
    assert.equal(zoroval.status().active, false);
  });
  assert.deepEqual(logged, []);
});

test("init twice keeps the first configuration", async () => {
  const gateway = await startGateway();
  assert.equal(zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast }), true);
  assert.equal(zoroval.init({ apiKey: KEY, ingestUrl: "http://127.0.0.1:1" }), true);
  await chat(); await zoroval.flush(2000);
  assert.equal(gateway.requests.length, 1);
  await gateway.close();
});

test("check 6: wrong URL (nothing listens): no error reaches the app, flush and shutdown resolve", async () => {
  zoroval.init({ apiKey: KEY, ingestUrl: "http://127.0.0.1:1", maxAttempts: 2, ...fast });
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
  const logged = await withWarnings(async () => {
    assert.equal(await chat(), "answer");
    assert.equal(await zoroval.flush(1500), false);
    const result = await zoroval.shutdown(500);
    assert.ok(result.spansFailed >= 1 || result.queueSpans >= 1 || result.batchesRequeued >= 1);
  });
  await sleep(20);
  process.off("unhandledRejection", onRejection);
  assert.deepEqual(rejections, []);
  assert.ok(logged.length <= 2, logged.join("|"));
});

test("check 6: gateway 500s: app unaffected, retries are bounded", async () => {
  const gateway = await startGateway(() => ({ status: 500, message: "boom" }));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, maxAttempts: 3, ...fast });
  assert.equal(await chat(), "answer");
  const started = Date.now();
  assert.equal(await zoroval.flush(1500), false);
  const result = await zoroval.shutdown(500);
  assert.ok(Date.now() - started < 3000);
  assert.ok(gateway.requests.length >= 2 && gateway.requests.length <= 12, `requests ${gateway.requests.length}`);
  assert.equal(result.spansExported, 0);
  assert.equal(result.lastError, "500:boom");
  await gateway.close();
});

test("check 6: 401 stops export for the process, logged once, app unaffected", async () => {
  const gateway = await startGateway(() => ({ status: 401, message: "invalid_key" }));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  const logged = await withWarnings(async () => {
    assert.equal(await chat("a"), "answer");
    await zoroval.flush(2000);
    assert.equal(zoroval.status().keyRefused, "invalid_key");
    assert.equal(zoroval.status().exportState, "off");
    assert.equal(await chat("b"), "answer");
    assert.equal(await chat("c"), "answer");
    await zoroval.flush(2000);
  });
  assert.equal(gateway.requests.length, 1, "no request after the key was refused");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /refused the ingest key/);
  assert.equal(zoroval.status().spansExported, 0);
  assert.ok(zoroval.status().spansFailed >= 3);
  await gateway.close();
});

test("403 is fatal too", async () => {
  const gateway = await startGateway(() => ({ status: 403, message: "key_revoked" }));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  await chat(); await zoroval.flush(2000);
  assert.equal(zoroval.status().keyRefused, "key_revoked");
  await gateway.close();
});

test("a 5xx then success is retried under the same batch id", async () => {
  const gateway = await startGateway((req, i) => (i === 0 ? { status: 502 } : {}));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  await chat();
  assert.equal(await zoroval.flush(5000), true);
  assert.equal(gateway.requests.length, 2);
  assert.equal(gateway.requests[0].headers["x-zoroval-batch-id"], gateway.requests[1].headers["x-zoroval-batch-id"]);
  assert.equal(zoroval.status().spansExported, 1);
  await gateway.close();
});

test("429 honours Retry-After, same batch id", async () => {
  const gateway = await startGateway((req, i) => (i === 0 ? { status: 429, headers: { "retry-after": "1" } } : {}));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  await chat();
  const started = Date.now();
  assert.equal(await zoroval.flush(6000), true);
  assert.ok(Date.now() - started >= 950, "waited for Retry-After");
  assert.equal(gateway.requests.length, 2);
  assert.equal(gateway.requests[0].headers["x-zoroval-batch-id"], gateway.requests[1].headers["x-zoroval-batch-id"]);
  await gateway.close();
});

test("a 400 is not retried and is logged once", async () => {
  const gateway = await startGateway(() => ({ status: 400, message: "bad_otlp" }));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  const logged = await withWarnings(async () => { await chat(); await zoroval.flush(2000); });
  assert.equal(gateway.requests.length, 1);
  assert.equal(logged.length, 1);
  assert.equal(zoroval.status().spansFailed, 1);
  await gateway.close();
});

test("partial success counts rejected spans", async () => {
  const gateway = await startGateway(() => ({ body: JSON.stringify({ partialSuccess: { rejectedSpans: "1" } }) }));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  await zoroval.conversation("c", () => zoroval.turn(async () => zoroval.step("s", () => {})));
  await zoroval.flush(2000);
  assert.equal(zoroval.status().spansRejected, 1);
  assert.equal(zoroval.status().spansExported, 1);
  await gateway.close();
});

test("the queue is capped in spans: oldest dropped, X-Zoroval-Dropped-Spans says how many", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, maxQueueSpans: 3, flushIntervalMs: 300 });
  for (let i = 0; i < 5; i++) await zoroval.conversation(`c${i}`, () => zoroval.turn({ input: i }, () => {}));
  assert.equal(zoroval.status().spansDropped, 2);
  await zoroval.flush(3000);
  const [req] = gateway.requests;
  assert.equal(req.headers["x-zoroval-dropped-spans"], "2");
  assert.deepEqual(req.spans.map((s) => s.attrs["zoroval.conversation.id"]), ["c2", "c3", "c4"]);
  await gateway.close();
});

test("the queue is capped in bytes", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, maxQueueBytes: 2500, flushIntervalMs: 300 });
  for (let i = 0; i < 6; i++) await zoroval.conversation(`c${i}`, () => zoroval.turn({ input: "x".repeat(500) }, () => {}));
  assert.ok(zoroval.status().spansDropped >= 3);
  assert.ok(zoroval.status().queueBytes <= 2500);
  await zoroval.flush(3000);
  assert.equal(gateway.requests[0].headers["x-zoroval-dropped-spans"], String(zoroval.status().spansDropped));
  await gateway.close();
});

test("unknown options are ignored with one warning; the app is unaffected", async () => {
  const gateway = await startGateway();
  const logged = await withWarnings(async () => {
    zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, bogus: 1, ...fast });
    await chat(); await zoroval.flush(2000);
  });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /bogus/);
  assert.equal(gateway.requests.length, 1);
  await gateway.close();
});

test("a redirect is never followed (the request carries the key)", async () => {
  const other = await startGateway();
  const gateway = await startGateway(() => ({ status: 307, headers: { location: `${other.url}/v1/traces` } }));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  const logged = await withWarnings(async () => { await chat(); await zoroval.flush(2000); });
  assert.equal(other.requests.length, 0);
  assert.equal(gateway.requests.length, 1);
  assert.equal(logged.length, 1);
  await gateway.close(); await other.close();
});
