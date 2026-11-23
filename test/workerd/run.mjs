// Runs the SDK inside workerd (via Miniflare) to prove no Node-only API is used in the edge entries.
// usage: node test/workerd/run.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, startGateway } from "../gateway.mjs";
import { startFakeOpenAI } from "../fake-openai.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

// The worker imports "zoroval" through a real node_modules link, so the package's conditional
// exports decide which entry is bundled, exactly as for a developer who installed it.
const project = mkdtempSync(join(tmpdir(), "zoroval-workerd-"));
mkdirSync(join(project, "node_modules"));
symlinkSync(root, join(project, "node_modules", "zoroval"), "dir");
cpSync(fileURLToPath(new URL("./worker.mjs", import.meta.url)), join(project, "worker.mjs"));
cpSync(fileURLToPath(new URL("./openai-worker.mjs", import.meta.url)), join(project, "openai-worker.mjs"));

async function bundle(conditions, entry = "worker.mjs") {
  const result = await build({
    entryPoints: [join(project, entry)],
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
    conditions, mainFields: ["module", "main"],
    external: ["node:*"],
  });
  return result.outputFiles[0].text;
}

async function runWorker(flags, gatewayUrl, paths) {
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: await bundle(["workerd", "worker", "browser"]) }],
    compatibilityDate: "2025-01-01", compatibilityFlags: flags,
    bindings: { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gatewayUrl },
  });
  try {
    const responses = await Promise.all(paths.map((p) => mf.dispatchFetch("http://worker.test" + p)));
    if (process.env.DEBUG) { await new Promise((r) => setTimeout(r, 1500)); console.log(await (await mf.dispatchFetch("http://worker.test/?chat=Z")).text()); }
    return await Promise.all(responses.map(async (r) => ({ status: r.status, text: await r.text() })));
  } finally {
    await mf.dispose();
  }
}

// 1. With nodejs_als: two interleaved requests are grouped per chat and never mixed.
{
  const gateway = await startGateway();
  const responses = await runWorker(["nodejs_als"], gateway.url, ["/?chat=A&wait=60", "/?chat=B&wait=10", "/?chat=A&wait=20"]);
  for (const r of responses) assert.equal(r.status, 200, r.text);
  if (process.env.DEBUG) console.log(responses.map((r) => r.text), gateway.requests.map((r) => ({ ...r, raw: undefined })));
  // waitUntil(flush()) runs after the response: wait for the gateway to have the spans.
  for (let i = 0; i < 100 && gateway.spans().length < 6; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(gateway.requests.every((r) => r.headers["content-encoding"] === "gzip" && !r.parseError), "gzip JSON decoded by the gateway");
  const spans = gateway.spans();
  const turns = spans.filter((s) => s.attrs["zoroval.observation.type"] === "turn");
  assert.equal(turns.length, 3);
  for (const t of turns) {
    const chat = t.attrs["zoroval.conversation.id"];
    assert.ok(["A", "B"].includes(chat));
    assert.equal(t.attrs["zoroval.input"], JSON.stringify("hello " + chat));
    assert.equal(t.attrs["zoroval.user.id"], "u-" + chat);
    assert.equal(t.attrs["zoroval.output"], JSON.stringify("re: " + chat));
    assert.equal(t.attrs["zoroval.grouping"], "explicit");
  }
  for (const s of spans.filter((x) => x.name === "think")) {
    const parent = spans.find((p) => p.spanId === s.parentSpanId);
    assert.equal(s.attrs["zoroval.conversation.id"], parent.attrs["zoroval.conversation.id"]);
    assert.equal(s.attrs["zoroval.output"], JSON.stringify("thought " + s.attrs["zoroval.conversation.id"]));
  }
  assert.equal(gateway.requests[0].resource["zoroval.sdk.name"], "zoroval-js");
  assert.match(gateway.requests[0].headers["user-agent"], /^zoroval-js\//);
  console.log(`ok - workerd + nodejs_als: ${turns.length} turns, grouped per chat, ${gateway.requests.length} gzip JSON request(s) accepted`);
  await gateway.close();
}

// 2. Without nodejs_als or nodejs_compat: the Worker still loads and runs; turns stay ungrouped, never mixed.
{
  const gateway = await startGateway();
  const responses = await runWorker([], gateway.url, ["/?chat=A&wait=40", "/?chat=B&wait=10"]);
  for (const r of responses) assert.equal(r.status, 200, r.text);
  for (let i = 0; i < 100 && gateway.spans().length < 4; i++) await new Promise((r) => setTimeout(r, 50));
  const turns = gateway.spans().filter((s) => s.attrs["zoroval.observation.type"] === "turn");
  assert.equal(turns.length, 2);
  for (const t of turns) {
    assert.equal("zoroval.conversation.id" in t.attrs, false, "never grouped without AsyncLocalStorage");
    assert.equal(t.attrs["zoroval.grouping"], "ungrouped");
  }
  assert.equal(new Set(turns.map((t) => t.traceId)).size, 2, "each turn is its own trace");
  console.log("ok - workerd without flags: loads, runs, turns ungrouped and never mixed");
  await gateway.close();
}

// 3. A Worker that does not hand flush() to waitUntil sends nothing on a timer (nothing survives the response).
{
  const gateway = await startGateway();
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: (await bundle(["workerd", "worker", "browser"])) }],
    compatibilityDate: "2025-01-01", compatibilityFlags: ["nodejs_als"],
    bindings: { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url },
  });
  try {
    const response = await mf.dispatchFetch("http://worker.test/?chat=A&noflush=1");
    assert.equal(response.status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(gateway.requests.length, 0);
    console.log("ok - workerd: no background timer, nothing sent until flush() is handed to waitUntil");
  } finally {
    await mf.dispose();
    await gateway.close();
  }
}

// 4. Check 2: a Worker calling OpenAI with plain fetch through wrapFetch and withZoroval.
{
  const gateway = await startGateway();
  const fake = await startFakeOpenAI({ chunkDelayMs: 15 });
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: await bundle(["workerd", "worker", "browser"], "openai-worker.mjs") }],
    compatibilityDate: "2025-01-01", compatibilityFlags: ["nodejs_als"],
    bindings: { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url, ZOROVAL_SERVICE_NAME: "openai-worker", OPENAI_BASE: fake.url },
  });
  try {
    // two messages of one chat: one non-streamed (a tool call), one streamed and returned before it finishes
    const first = await mf.dispatchFetch("http://worker.test/?chat=A");
    assert.equal(first.status, 200);
    assert.equal((await first.json()).choices[0].message.tool_calls[0].id, "call_abc123");
    const second = await mf.dispatchFetch("http://worker.test/?chat=A&stream=1&model=gpt-test-big");
    assert.equal(second.status, 200);
    const text = await second.text();
    assert.match(text, /\[DONE\]/, "the streamed body reached the client whole");
    for (let i = 0; i < 100 && !gateway.spans().some((s) => s.attrs["zoroval.observation.type"] === "generation" && s.attrs["gen_ai.request.stream"] === true); i++) await new Promise((r) => setTimeout(r, 50));
    const spans = gateway.spans();
    const turns = spans.filter((s) => s.attrs["zoroval.observation.type"] === "turn");
    const gens = spans.filter((s) => s.attrs["zoroval.observation.type"] === "generation");
    assert.equal(turns.length, 2);
    assert.ok(turns.every((t) => t.attrs["zoroval.conversation.id"] === "A" && t.attrs["zoroval.user.id"] === "u-A"));
    assert.equal(gens.length, 2);
    for (const g of gens) {
      assert.equal(g.name, g.attrs["gen_ai.request.model"] === "gpt-test" ? "chat gpt-test" : "chat gpt-test-big");
      assert.equal(g.attrs["zoroval.conversation.id"], "A");
      assert.equal(g.attrs["gen_ai.response.id"], "chatcmpl-test123");
      assert.ok(turns.some((t) => t.spanId === g.parentSpanId));
    }
    const streamed = gens.find((g) => g.attrs["gen_ai.request.stream"] === true);
    const parts = JSON.parse(streamed.attrs["gen_ai.output.messages"])[0].parts[0].content;
    assert.ok(parts.length > 10_000, "the whole streamed answer is in the span: the flush waited for the open stream");
    assert.equal(streamed.attrs["gen_ai.response.finish_reasons"][0], "stop");
    const plain = gens.find((g) => g.attrs["gen_ai.request.stream"] === false);
    assert.equal(JSON.parse(plain.attrs["zoroval.tool_calls"])[0].id, "call_abc123");
    assert.ok(gateway.requests.every((r) => r.headers["content-encoding"] === "gzip" && !r.parseError));
    console.log(`ok - workerd OpenAI Worker: wrapFetch + withZoroval, ${turns.length} turns in one conversation, streamed and non-streamed spans arrived after the response (${gateway.requests.length} request(s))`);
  } finally {
    await mf.dispose();
    await fake.close();
    await gateway.close();
  }
}

// 5. Overlapping requests on one isolate: each flush sends inside its own request, so a request that
//    starts while another one's flush is sending is still sent, and so is every later one.
{
  const gateway = await startGateway(() => ({ delayMs: 60 }));
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: await bundle(["workerd", "worker", "browser"]) }],
    compatibilityDate: "2025-01-01", compatibilityFlags: ["nodejs_als"],
    bindings: { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url },
  });
  const chats = () => new Set(gateway.spans().filter((s) => s.attrs["zoroval.observation.type"] === "turn").map((s) => s.attrs["zoroval.conversation.id"]));
  const until = async (ok, ms) => { for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50)); };
  try {
    const a = mf.dispatchFetch("http://worker.test/?chat=A").then((r) => r.text());
    await new Promise((r) => setTimeout(r, 20));
    const b = mf.dispatchFetch("http://worker.test/?chat=B").then((r) => r.text());
    await Promise.all([a, b]);
    await until(() => chats().has("A") && chats().has("B"), 5000);
    await (await mf.dispatchFetch("http://worker.test/?chat=C")).text();
    await until(() => chats().has("C"), 5000);
    await new Promise((r) => setTimeout(r, 2000));
    await (await mf.dispatchFetch("http://worker.test/?chat=D")).text();
    await until(() => chats().has("D"), 5000);
    assert.deepEqual([...chats()].sort(), ["A", "B", "C", "D"], "every request's turn reached the gateway");
    const { status } = await (await mf.dispatchFetch("http://worker.test/?chat=E&noflush=1")).json();
    assert.equal(status.internalErrors, 0, "no cross-request I/O error");
    assert.equal(status.spansFailed, 0);
    console.log(`ok - workerd overlapping requests: A, B (20 ms apart), C and D all sent (${gateway.requests.length} request(s)), no internal errors`);
  } finally {
    await mf.dispose();
    await gateway.close();
  }
}

// 6. A streamed reply longer than 10 s: withZoroval keeps the request alive until the stream ends,
//    and the generation span is sent with the whole answer.
{
  const gateway = await startGateway();
  const fake = await startFakeOpenAI({ chunkDelayMs: 30 }); // gpt-test-big streams for about 12 s
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: await bundle(["workerd", "worker", "browser"], "openai-worker.mjs") }],
    compatibilityDate: "2025-01-01", compatibilityFlags: ["nodejs_als"],
    bindings: { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url, OPENAI_BASE: fake.url },
  });
  try {
    const started = Date.now();
    const response = await mf.dispatchFetch("http://worker.test/?chat=L&stream=1&model=gpt-test-big");
    assert.match(await response.text(), /\[DONE\]/);
    const streamedMs = Date.now() - started;
    assert.ok(streamedMs > 10_000, `the stream took ${streamedMs} ms`);
    const generation = () => gateway.spans().find((s) => s.attrs["zoroval.observation.type"] === "generation");
    for (let i = 0; i < 100 && !generation(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(generation(), "the generation span of a 12 s stream reached the gateway");
    assert.equal(generation().attrs["gen_ai.response.finish_reasons"][0], "stop");
    console.log(`ok - workerd stream of ${(streamedMs / 1000).toFixed(1)} s: generation span sent after the stream ended`);
  } finally {
    await mf.dispose();
    await fake.close();
    await gateway.close();
  }
}
