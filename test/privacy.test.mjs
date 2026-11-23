import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway, withWarnings } from "./gateway.mjs";

afterEach(async () => { await zoroval.shutdown(1000); });

const fast = { flushIntervalMs: 20 };
const SECRET = "my-card-4111-1111-1111-1111";

async function run(options, body) {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast, ...options });
  let logged = [];
  logged = await withWarnings(async () => {
    await zoroval.conversation("c", () => zoroval.turn({ input: `pay with ${SECRET}` }, async (turn) => {
      turn.setOutput(`ok ${SECRET}`);
      turn.setMetadata({ region: "eu" });
      await zoroval.tool("charge", { arguments: { card: SECRET }, callId: "call_9" }, async (t) => t.setOutput({ card: SECRET }));
      await body?.(turn);
    }));
    await zoroval.flush(3000);
  });
  const result = { gateway, logged, text: JSON.stringify(gateway.requests.map((r) => r.raw)), spans: gateway.spans() };
  return result;
}

test("check 4: captureContent false sends no prompt, output or tool text", async () => {
  const { gateway, text, spans } = await run({ captureContent: false });
  assert.equal(spans.length, 2);
  assert.ok(!text.includes(SECRET), "secret must not leave the app");
  for (const s of spans) {
    for (const key of ["zoroval.input", "zoroval.output", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) {
      assert.equal(key in s.attrs, false, key);
    }
  }
  const turn = spans.find((s) => s.name === "turn");
  assert.equal(turn.attrs["zoroval.metadata"], '{"region":"eu"}'); // metadata is not prompt content
  assert.equal(turn.attrs["zoroval.conversation.id"], "c");
  await gateway.close();
});

test("check 4: redact sends only redacted text", async () => {
  const redact = (value) => JSON.parse(JSON.stringify(value).split(SECRET).join("[card]"));
  const { gateway, text, spans } = await run({ redact });
  assert.ok(!text.includes(SECRET));
  const turn = spans.find((s) => s.name === "turn");
  assert.equal(turn.attrs["zoroval.input"], '"pay with [card]"');
  assert.equal(turn.attrs["zoroval.output"], '"ok [card]"');
  assert.equal(turn.attrs["zoroval.redacted"], true);
  const tool = spans.find((s) => s.name === "execute_tool charge");
  assert.equal(tool.attrs["gen_ai.tool.call.arguments"], '{"card":"[card]"}');
  assert.equal(tool.attrs["gen_ai.tool.call.result"], '{"card":"[card]"}');
  await gateway.close();
});

test("check 4: a throwing redact drops the field, flags it, and the app is unaffected", async () => {
  let calls = 0;
  const redact = () => { calls += 1; throw new RangeError("hook bug"); };
  const { gateway, text, spans, logged } = await run({ redact });
  assert.ok(calls >= 3);
  assert.ok(!text.includes(SECRET));
  const turn = spans.find((s) => s.name === "turn");
  assert.equal("zoroval.input" in turn.attrs, false);
  assert.equal("zoroval.output" in turn.attrs, false);
  assert.equal(turn.attrs["zoroval.redacted"], true);
  assert.equal(turn.attrs["zoroval.conversation.id"], "c");
  assert.equal(logged.length, 1, "logged once");
  assert.match(logged[0], /redact hook threw RangeError/);
  assert.ok(zoroval.status().redactErrors >= 3);
  await gateway.close();
});

test("size caps: content over the cap is cut, stays valid JSON, and truncated_bytes says how much", async () => {
  const big = "x".repeat(20_000);
  const { gateway, spans } = await run({ maxContentBytes: 1000, maxMetadataBytes: 200 }, async (turn) => {
    turn.setInput({ messages: [{ role: "user", content: big }] });
    turn.setMetadata({ blob: big });
  });
  const turn = spans.find((s) => s.name === "turn");
  const input = turn.attrs["zoroval.input"];
  assert.ok(Buffer.byteLength(input) <= 1000);
  assert.equal(JSON.parse(input).messages[0].role, "user");
  assert.ok(turn.attrs["zoroval.truncated_bytes"] > 19_000);
  assert.ok(Buffer.byteLength(turn.attrs["zoroval.metadata"]) <= 200);
  assert.ok(zoroval.status().truncatedFields >= 2);
  await gateway.close();
});

test("content with bigint, circular refs and bytes is serialized without throwing", async () => {
  const circular = { name: "a" }; circular.self = circular;
  const { gateway, spans } = await run({}, async (turn) => {
    turn.setInput({ n: 10n, bytes: new Uint8Array(4), circular, set: new Set([1]), map: new Map([["k", 1]]) });
  });
  const input = JSON.parse(spans.find((s) => s.name === "turn").attrs["zoroval.input"]);
  assert.equal(input.n, "10");
  assert.equal(input.bytes, "[4 bytes omitted]");
  assert.equal(input.circular.self, "[Circular]");
  assert.deepEqual(input.set, [1]);
  assert.deepEqual(input.map, { k: 1 });
  await gateway.close();
});
