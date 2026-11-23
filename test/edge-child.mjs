// Runs the Edge/Workers entry in a child process. usage: node edge-child.mjs <mode> <gatewayUrl> <key>
import { AsyncLocalStorage } from "node:async_hooks";
const [mode, url, key] = process.argv.slice(2);
if (mode.startsWith("als")) globalThis.AsyncLocalStorage = AsyncLocalStorage; // what Vercel Edge provides
const zoroval = await import("../dist/edge.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warnings = [];
console.warn = (m) => warnings.push(m);
const out = {};
zoroval.init({ apiKey: key, ingestUrl: url, flushIntervalMs: 20, requestTimeoutMs: 300, maxAttempts: 2 });
if (mode === "als" || mode === "noals") {
  await Promise.all(["A", "B"].map((id, i) => zoroval.conversation(id, async () => {
    await sleep(10 + i * 10);
    await zoroval.turn({ input: id }, async () => { await sleep(20); });
  })));
  out.beforeFlushStatus = zoroval.status().queueSpans;
  await sleep(250); // a Node timer would have sent by now; the edge entry sends nothing on its own
  out.queuedAfterWait = zoroval.status().queueSpans;
  out.flushed = await zoroval.flush(3000);
}
if (mode === "als-slow") {
  await zoroval.conversation("A", () => zoroval.turn({ input: "x".repeat(40_000) }, () => {}));
  const started = Date.now();
  out.flushed = await zoroval.flush(700);
  out.ms = Date.now() - started;
  out.status = zoroval.status();
}
out.warnings = warnings;
console.log(JSON.stringify(out));
process.exit(0);
