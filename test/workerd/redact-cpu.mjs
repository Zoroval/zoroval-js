// Measures what redaction adds to one Worker request in workerd (Miniflare), for a 20 KB and a 100 KB
// chat. workerd freezes clocks inside a request, so time is measured from outside: the same request
// with redact on and off, many times; the difference is redaction's CPU time. Prints JSON.
// Fails if redaction adds more than 5 ms (20 KB) or 10 ms (100 KB, the Workers free-plan CPU limit), or if
// the gateway receives an unredacted value.
// usage: node test/workerd/redact-cpu.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, startGateway } from "../gateway.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const project = mkdtempSync(join(tmpdir(), "zoroval-redact-cpu-"));
mkdirSync(join(project, "node_modules"));
symlinkSync(root, join(project, "node_modules", "zoroval"), "dir");
cpSync(fileURLToPath(new URL("./redact-worker.mjs", import.meta.url)), join(project, "worker.mjs"));
const bundled = (await build({
  entryPoints: [join(project, "worker.mjs")], bundle: true, write: false, format: "esm", platform: "neutral",
  target: "es2022", conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["node:*", "cloudflare:*"],
})).outputFiles[0].text;

const gateway = await startGateway();
async function timings(redact, size, runs) {
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: bundled }],
    compatibilityDate: "2025-01-01", compatibilityFlags: ["nodejs_als"],
    bindings: { ZOROVAL_INGEST_KEY: KEY, ZOROVAL_INGEST_URL: gateway.url, REDACT: redact },
  });
  try {
    const one = async () => {
      const began = performance.now();
      const r = await mf.dispatchFetch(`http://worker.test/?size=${size}`);
      await r.text();
      return performance.now() - began;
    };
    if (redact === "basic") {
      await (await mf.dispatchFetch(`http://worker.test/?size=${size}&flush=1`)).text();
      const sent = JSON.stringify(gateway.requests.map((r) => r.raw));
      assert.ok(sent.includes("[EMAIL]") && sent.includes("[CARD]") && sent.includes("[PHONE]"), "labels sent");
      assert.ok(!sent.includes("priya.sharma@example.com") && !sent.includes("4111 1111") && !sent.includes("98765 43210"), "raw values sent");
      assert.ok(sent.includes("403-5926381-7740324"), "order id kept");
    }
    await one(); // warm up: the first request also starts the isolate
    const rest = [];
    for (let i = 0; i < runs; i++) rest.push(await one());
    rest.sort((a, b) => a - b);
    return { median: rest[Math.floor(runs / 2)], p90: rest[Math.floor(runs * 0.9)] };
  } finally {
    await mf.dispose();
  }
}

const out = {};
for (const size of [20_000, 100_000]) {
  const off = await timings("off", size, 60);
  const on = await timings("basic", size, 60);
  out[`${size / 1000}KB`] = {
    off_median_ms: +off.median.toFixed(2), on_median_ms: +on.median.toFixed(2),
    added_median_ms: +(on.median - off.median).toFixed(2), added_p90_ms: +(on.p90 - off.p90).toFixed(2),
  };
}
await gateway.close();
console.log(JSON.stringify(out, null, 1));
assert.ok(out["20KB"].added_median_ms < 5, "20 KB over budget");
assert.ok(out["100KB"].added_median_ms < 10, "100 KB over the Workers free-plan CPU limit");
console.log("ok - workerd: redact basic cleans the payload and fits the CPU budget");
