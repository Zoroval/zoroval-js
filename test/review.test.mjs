// Fixes from the PR review: shared references, and a turn that never ends.
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway } from "./gateway.mjs";

afterEach(async () => { await zoroval.shutdown(1000); });

test("an object shared twice is written twice; only a real cycle is [Circular]", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, flushIntervalMs: 20 });
  const shared = { x: 1 };
  const input = { a: shared, b: shared, list: [shared, shared], self: null };
  input.self = input;
  await zoroval.turn({ input }, () => {});
  await zoroval.flush(3000);
  const [turn] = gateway.spans();
  assert.deepEqual(JSON.parse(turn.attrs["zoroval.input"]), { a: { x: 1 }, b: { x: 1 }, list: [{ x: 1 }, { x: 1 }], self: "[Circular]" });
  await gateway.close();
});

test("a turn that never settles delays flush by at most 10 s, and its spans still go out", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, flushIntervalMs: 20 });
  await zoroval.turn({ input: "done" }, () => {});
  void zoroval.turn({ input: "stuck" }, () => new Promise(() => {})); // never resolves
  const started = Date.now();
  const ok = await zoroval.flush(60_000);
  const took = Date.now() - started;
  assert.equal(ok, true);
  assert.ok(took >= 9000 && took < 13_000, `flush took ${took} ms`);
  assert.equal(gateway.spans().filter((s) => s.attrs["zoroval.input"] === '"done"').length, 1);
  await gateway.close();
});

// ------------------------------------------------------------------ second review (2026-11-24)

import { startFakeOpenAI } from "./fake-openai.mjs";
import { OpenAI } from "./openai-packages.mjs";

const toolCallsOf = (gateway) => gateway.spans().find((s) => s.attrs["zoroval.tool_calls"]);
const askWeather = (fetchFn, base) => fetchFn(base + "/chat/completions", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "weather in Paris" }] }),
}).then((r) => r.json());

test("tool call arguments go through redact, and are dropped when redact throws", async () => {
  const fake = await startFakeOpenAI();
  for (const [redact, expected] of [[() => "[R]", "[R]"], [() => { throw new Error("no"); }, undefined]]) {
    const gateway = await startGateway();
    zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, flushIntervalMs: 20, redact });
    const traced = zoroval.wrapFetch(fetch, { baseURLs: [fake.url] });
    await zoroval.conversation("c", () => zoroval.turn({}, () => askWeather(traced, fake.url)));
    await zoroval.flush(3000);
    const span = toolCallsOf(gateway);
    const [call] = JSON.parse(span.attrs["zoroval.tool_calls"]);
    assert.equal(call.name, "get_weather");
    assert.equal(call.arguments, expected);
    assert.equal(span.attrs["zoroval.redacted"], true);
    assert.doesNotMatch(JSON.stringify(gateway.requests.map((r) => r.raw)), /Paris/);
    await zoroval.shutdown(1000);
    await gateway.close();
  }
  await fake.close();
});

test("globalThis.fetch = wrapFetch() does not recurse, before init or after, and the SDK's own sends skip it", async () => {
  const fake = await startFakeOpenAI();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = zoroval.wrapFetch(undefined, { baseURLs: [fake.url] });
    assert.notEqual(globalThis.fetch, original);
    const gateway = await startGateway();
    assert.equal((await fetch(gateway.url + "/healthz")).status > 0, true, "an app fetch before init works");
    zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, flushIntervalMs: 20 });
    await zoroval.conversation("g", () => zoroval.turn({}, () => askWeather(fetch, fake.url)));
    assert.equal(await zoroval.flush(3000), true);
    const types = gateway.spans().map((s) => s.attrs["zoroval.observation.type"]).sort();
    assert.deepEqual(types, ["generation", "turn"], "the export request itself is not traced");
    await gateway.close();
  } finally {
    globalThis.fetch = original;
    await fake.close();
  }
});

test("init() leaves tracing off: wrapFetch and wrapOpenAI hand back what they were given", () => {
  zoroval.init({ enabled: false });
  const f = async () => new Response("x");
  assert.equal(zoroval.wrapFetch(f), f);
  assert.equal(zoroval.wrapFetch(), globalThis.fetch);
  const client = new OpenAI({ apiKey: "sk", baseURL: "http://127.0.0.1:1/v1" });
  const create = client.chat.completions.create;
  assert.equal(zoroval.wrapOpenAI(client), client);
  assert.equal(client.chat.completions.create, create, "the client is not patched");
});

test("a fetch wrapped before init() (module scope) is traced once init() runs", async () => {
  const fake = await startFakeOpenAI();
  const traced = zoroval.wrapFetch(fetch, { baseURLs: [fake.url] });
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, flushIntervalMs: 20 });
  await zoroval.turn({}, () => askWeather(traced, fake.url));
  await zoroval.flush(3000);
  assert.ok(gateway.spans().some((s) => s.attrs["zoroval.observation.type"] === "generation"));
  await gateway.close();
  await fake.close();
});

test("turn() and trace() return the callback's own promise, and a handled rejection stays handled", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, flushIntervalMs: 20 });
  class Special extends Promise { extra() { return "kept"; } }
  const mine = Special.resolve(7);
  const fromTurn = zoroval.turn({}, () => mine);
  assert.equal(fromTurn, mine);
  assert.equal(fromTurn.extra(), "kept");
  assert.equal(zoroval.trace("job", () => mine), mine);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(zoroval.turn({}, async () => { throw new RangeError("boom"); }), RangeError);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  await zoroval.flush(3000);
  assert.equal(gateway.spans().filter((s) => s.status?.code === 2).length, 1, "the failed turn is recorded");
  await gateway.close();
});

test("withZoroval(WorkerEntrypoint class) wraps its handlers; anything else without handlers fails loudly", async () => {
  const gateway = await startGateway();
  class Entrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
  class MyWorker extends Entrypoint {
    async fetch() { return zoroval.conversation("cls", () => zoroval.turn({}, async () => new Response("from " + this.env.NAME))); }
  }
  const Wrapped = zoroval.withZoroval(MyWorker);
  const waits = [];
  const worker = new Wrapped({ waitUntil: (p) => waits.push(p) }, { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url, NAME: "class" });
  assert.ok(worker instanceof MyWorker);
  assert.equal(await (await worker.fetch(new Request("http://x.test/"))).text(), "from class");
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  assert.equal(gateway.spans()[0].attrs["zoroval.conversation.id"], "cls");
  assert.throws(() => zoroval.withZoroval(() => {}), TypeError);
  await gateway.close();
});
