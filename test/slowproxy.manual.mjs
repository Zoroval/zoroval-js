// Manual 2G check through the team's slowproxy (outside this repo). Not part of `npm test`.
//   node test/slowproxy.manual.mjs [path/to/slowproxy.mjs]
// Profile: up 25 KB/s (about 200 kbit/s), down 50 KB/s, 300 ms one-way latency (slowproxy defaults).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway, sleep } from "./gateway.mjs";

const proxyPath = process.argv[2] ?? "/Users/inesh/Zoroval/low-bandwidth-tests/slowproxy.mjs";
if (!existsSync(proxyPath)) { console.log("slowproxy not found at", proxyPath); process.exit(2); }

async function scenario(name, { upKbps, turns, bytes, flushMs, expectDelivered }) {
  const gateway = await startGateway();
  const port = 18700 + Math.floor(Math.random() * 200);
  const proxy = spawn(process.execPath, [proxyPath], {
    env: { ...process.env, LISTEN: String(port), UPSTREAM: gateway.url.replace("http://", ""), UP_KBPS: String(upKbps), DOWN_KBPS: "50", LATENCY_MS: "300", LOG: join(tmpdir(), "zoroval-slowproxy.log") },
    stdio: "ignore",
  });
  await sleep(500);
  zoroval.init({ apiKey: KEY, ingestUrl: `http://127.0.0.1:${port}`, flushIntervalMs: 10, maxAttempts: 3 });
  for (let i = 0; i < turns; i++) {
    await zoroval.conversation(`chat-${i}`, () => zoroval.turn({ input: randomBytes(bytes).toString("base64") }, () => {}));
  }
  const started = Date.now();
  const flushed = await zoroval.flush(flushMs);
  const status = await zoroval.shutdown(1000);
  const elapsed = Date.now() - started;
  console.log(JSON.stringify({ name, upKbps, flushed, elapsedMs: elapsed, requestsAtGateway: gateway.requests.length, completeBodies: gateway.requests.filter((r) => r.complete).length,
    spansAtGateway: gateway.spans().length, exported: status.spansExported, failed: status.spansFailed, split: status.batchesSplit, requeued: status.batchesRequeued, bytesSent: status.bytesSent }));
  proxy.kill();
  await gateway.close();
  if (expectDelivered !== (status.spansExported === turns)) { console.log("UNEXPECTED"); process.exitCode = 1; }
  if (elapsed > flushMs + 2500) { console.log("TOO SLOW TO GIVE UP"); process.exitCode = 1; }
}

await scenario("2G: 10 turns, ~270 KB of text", { upKbps: 25, turns: 10, bytes: 20_000, flushMs: 40_000, expectDelivered: true });
await scenario("5 KB/s: link too slow for the deadline", { upKbps: 5, turns: 10, bytes: 20_000, flushMs: 4_000, expectDelivered: false });
