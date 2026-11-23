// withZoroval: init from env bindings, results and errors pass through, flush is handed to waitUntil.
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway, sleep } from "./gateway.mjs";

afterEach(async () => { await zoroval.shutdown(1000); });

const makeCtx = () => { const waits = []; return { waits, waitUntil: (p) => waits.push(p) }; };

test("withZoroval reads the bindings, passes the result through, and flushes through waitUntil", async () => {
  const gateway = await startGateway();
  const env = { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url, ZOROVAL_SERVICE_NAME: "w", ZOROVAL_ENVIRONMENT: "staging", ZOROVAL_RELEASE: "r1", OTHER: { not: "a string" } };
  const worker = zoroval.withZoroval({
    version: 3,
    async fetch(request, e) {
      assert.equal(e, env);
      return zoroval.conversation("w-1", () => zoroval.turn({ input: "hi" }, async () => { await sleep(5); return new Response("ok"); }));
    },
  });
  assert.equal(worker.version, 3, "other properties are kept");
  const ctx = makeCtx();
  const response = await worker.fetch(new Request("http://x.test/"), env, ctx);
  assert.equal(await response.text(), "ok");
  assert.equal(ctx.waits.length, 1);
  assert.equal(gateway.requests.length, 0, "nothing is sent before the platform runs the waitUntil promise");
  await Promise.all(ctx.waits);
  const [turn] = gateway.spans();
  assert.equal(turn.attrs["zoroval.conversation.id"], "w-1");
  assert.equal(gateway.requests[0].resource["service.name"], "w");
  assert.equal(gateway.requests[0].resource["deployment.environment.name"], "staging");
  assert.equal(gateway.requests[0].resource["service.version"], "r1");
  await gateway.close();
});

test("a handler that throws: the error passes through unchanged and the trace is still sent", async () => {
  const gateway = await startGateway();
  const env = { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url };
  const boom = new RangeError("boom");
  const worker = zoroval.withZoroval({
    async fetch() { return zoroval.turn({}, async () => { throw boom; }); },
    scheduled() { throw boom; },
  });
  const ctx = makeCtx();
  await assert.rejects(() => worker.fetch(new Request("http://x.test/"), env, ctx), (error) => error === boom);
  assert.throws(() => worker.scheduled({}, env, ctx), (error) => error === boom);
  await Promise.all(ctx.waits);
  assert.equal(gateway.spans().filter((s) => s.status?.code === 2).length, 1);
  await gateway.close();
});

test("no key in the bindings: the handler runs, nothing is sent, waitUntil is harmless; explicit options win", async () => {
  const gateway = await startGateway();
  const seen = [];
  const worker = zoroval.withZoroval({ async fetch() { seen.push(zoroval.status().active); return new Response("fine"); } });
  const ctx = makeCtx();
  assert.equal(await (await worker.fetch(new Request("http://x.test/"), {}, ctx)).text(), "fine");
  assert.deepEqual(seen, [false]);
  await Promise.all(ctx.waits);
  assert.equal(gateway.requests.length, 0);
  const keyed = zoroval.withZoroval({ async fetch() { return new Response("x"); } }, { apiKey: KEY, ingestUrl: gateway.url, serviceName: "explicit" });
  await keyed.fetch(new Request("http://x.test/"), { ZOROVAL_SERVICE_NAME: "from-env" }, ctx);
  assert.equal(zoroval.status().active, true);
  // a ctx without waitUntil must not break the app either
  await keyed.fetch(new Request("http://x.test/"), {}, undefined);
  await gateway.close();
});
