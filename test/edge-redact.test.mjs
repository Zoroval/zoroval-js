// The redactor and the SDK's edge entry inside Vercel's edge-runtime (the Edge VM, not Node): the
// shared corpus, adversarial timings, and one turn sent with redact "basic" through the edge bundle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { EdgeRuntime as EdgeVM } from "edge-runtime";
import { KEY, startGateway } from "./gateway.mjs";
import { ADVERSARIAL } from "./redaction-inputs.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const corpus = readFileSync(new URL("./redaction/level1_corpus.json", import.meta.url), "utf8");

async function iife(contents, conditions = ["edge-light", "worker", "browser"]) {
  const out = await build({
    stdin: { contents, resolveDir: root, loader: "js" }, bundle: true, write: false, format: "iife",
    platform: "neutral", target: "es2022", conditions, mainFields: ["module", "main"],
  });
  return out.outputFiles[0].text;
}

test("edge-runtime: corpus passes and adversarial inputs stay linear and within budget", async () => {
  const vm = new EdgeVM();
  vm.evaluate(await iife(`import { redactText, redactValue } from "./src/redact.ts"; globalThis.R = { redactText, redactValue };`));
  vm.context.CORPUS = corpus;
  const failures = vm.evaluate(`(() => {
    const c = JSON.parse(CORPUS), bad = [];
    for (const e of c.must_redact) if (R.redactText(e.text) !== e.expect) bad.push(e.id);
    for (const e of c.must_keep) if (R.redactText(e.text) !== e.text) bad.push(e.id);
    for (const e of c.values_must_redact) if (JSON.stringify(R.redactValue(e.value)) !== JSON.stringify(e.expect)) bad.push(e.id);
    for (const e of c.values_must_keep) if (R.redactValue(e.value) !== e.value) bad.push(e.id);
    return bad;
  })()`);
  assert.equal(JSON.stringify(failures), "[]"); // an array from the VM realm
  const MIB = 1 << 20;
  const worst = {};
  for (const [name, make] of Object.entries(ADVERSARIAL)) {
    vm.context.TEXT = make(4 * MIB);
    const ms = vm.evaluate(`(() => { const t = performance.now(); R.redactText(TEXT); return performance.now() - t; })()`);
    worst[name] = Math.round(ms / 4);
    assert.ok(ms / 4 < 600, `${name}: ${(ms / 4).toFixed(0)} ms per MiB in edge-runtime`);
  }
  if (process.env.ZOROVAL_PRINT_TIMINGS) console.log(JSON.stringify(worst));
});

test("edge-runtime: the edge bundle sends a turn with redact basic, cleaned", async () => {
  const gateway = await startGateway();
  const vm = new EdgeVM();
  vm.evaluate(await iife(`import * as zoroval from "zoroval"; globalThis.zoroval = zoroval;`));
  vm.context.CFG = { apiKey: KEY, ingestUrl: gateway.url, redact: "basic" };
  const status = await vm.evaluate(`(async () => {
    zoroval.init(CFG);
    await zoroval.conversation("e1", () => zoroval.turn({ input: "mail priya@example.com, card 4111 1111 1111 1111" }, async (t) => t.setOutput({ pnr: "8123456789", phone: "9876543210" })));
    await zoroval.flush(5000);
    return zoroval.status();
  })()`);
  assert.equal(status.redact, "basic");
  const turn = gateway.spans().find((s) => s.attrs["zoroval.observation.type"] === "turn");
  assert.equal(turn.attrs["zoroval.input"], '"mail [EMAIL], card [CARD]"');
  assert.deepEqual(JSON.parse(turn.attrs["zoroval.output"]), { pnr: "8123456789", phone: "[PHONE]" });
  await gateway.close();
});
