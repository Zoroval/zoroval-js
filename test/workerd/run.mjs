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

const root = fileURLToPath(new URL("../..", import.meta.url));

// The worker imports "zoroval" through a real node_modules link, so the package's conditional
// exports decide which entry is bundled, exactly as for a developer who installed it.
const project = mkdtempSync(join(tmpdir(), "zoroval-workerd-"));
mkdirSync(join(project, "node_modules"));
symlinkSync(root, join(project, "node_modules", "zoroval"), "dir");
cpSync(fileURLToPath(new URL("./worker.mjs", import.meta.url)), join(project, "worker.mjs"));

async function bundle(conditions) {
  const result = await build({
    entryPoints: [join(project, "worker.mjs")],
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
