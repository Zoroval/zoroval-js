import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, afterEach } from "node:test";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway, withWarnings, sleep } from "./gateway.mjs";

afterEach(async () => { await zoroval.shutdown(1000); });

const fast = { flushIntervalMs: 20 };

test("check 1 (core): two turns in one conversation share one conversation id, Python attribute names", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, serviceName: "shop", environment: "prod", release: "1.2.3", ...fast });
  await zoroval.conversation("chat-42", { userId: "u1", tags: ["a"], metadata: { plan: "pro" } }, async () => {
    await zoroval.turn({ input: "hello" }, async (turn) => {
      await sleep(5);
      await zoroval.step("plan", async (step) => { step.setOutput({ ok: true }); });
      turn.setOutput("hi there");
    });
    await zoroval.turn({ input: "and again" }, async (turn) => { turn.setOutput("again"); });
  });
  assert.equal(await zoroval.flush(3000), true);
  const [req] = gateway.requests;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/v1/traces");
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.equal(req.headers["content-encoding"], "gzip");
  assert.equal(req.headers["content-type"], "application/json");
  assert.match(req.headers["user-agent"], /^zoroval-js\/\d+\.\d+\.\d+$/);
  assert.match(req.headers["x-zoroval-batch-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(req.resource["service.name"], "shop");
  assert.equal(req.resource["zoroval.sdk.name"], "zoroval-js");
  assert.equal(req.resource["zoroval.sdk.version"], "0.1.0");
  assert.equal(req.resource["deployment.environment.name"], "prod");
  assert.equal(req.resource["service.version"], "1.2.3");
  assert.equal(req.scope.name, "zoroval");

  const spans = gateway.spans();
  const turns = spans.filter((s) => s.attrs["zoroval.observation.type"] === "turn");
  assert.equal(turns.length, 2);
  for (const t of turns) {
    assert.equal(t.attrs["zoroval.conversation.id"], "chat-42");
    assert.equal(t.attrs["gen_ai.conversation.id"], "chat-42");
    assert.equal(t.attrs["zoroval.user.id"], "u1");
    assert.equal(t.attrs["user.id"], "u1");
    assert.deepEqual(t.attrs["zoroval.tags"], ["a"]);
    assert.equal(t.attrs["zoroval.grouping"], "explicit");
    assert.equal(t.attrs["zoroval.metadata"], '{"plan":"pro"}');
    assert.match(t.traceId, /^[0-9a-f]{32}$/);
    assert.match(t.spanId, /^[0-9a-f]{16}$/);
    assert.equal(t.name, "turn");
    assert.equal(t.kind, 1);
    assert.match(t.startTimeUnixNano, /^\d{19}$/);
  }
  assert.notEqual(turns[0].traceId, turns[1].traceId);
  assert.equal(turns[0].attrs["zoroval.input"], '"hello"');
  assert.equal(turns[0].attrs["zoroval.output"], '"hi there"');
  const step = spans.find((s) => s.attrs["zoroval.observation.type"] === "step");
  assert.equal(step.name, "plan");
  assert.equal(step.attrs["zoroval.conversation.id"], "chat-42");
  assert.equal(step.parentSpanId, turns[0].spanId);
  assert.equal(step.traceId, turns[0].traceId);
  assert.equal(step.attrs["zoroval.output"], '{"ok":true}');
  assert.equal(zoroval.status().spansExported, 3);
  assert.equal("zoroval.test" in turns[0].attrs, false);
  await gateway.close();
});

test("parallel conversations never mix (AsyncLocalStorage)", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  await Promise.all(["A", "B", "C"].map((id, i) =>
    zoroval.conversation(id, async () => {
      await sleep(15 - i * 5);
      await zoroval.turn({ input: id }, async () => { await sleep(10); await zoroval.step("s", async () => sleep(5)); });
    })));
  await zoroval.flush(3000);
  const spans = gateway.spans();
  for (const s of spans.filter((x) => x.attrs["zoroval.observation.type"] === "turn")) {
    assert.equal(s.attrs["zoroval.conversation.id"], JSON.parse(s.attrs["zoroval.input"]));
  }
  for (const s of spans.filter((x) => x.attrs["zoroval.observation.type"] === "step")) {
    const parent = spans.find((p) => p.spanId === s.parentSpanId);
    assert.equal(s.attrs["zoroval.conversation.id"], parent.attrs["zoroval.conversation.id"]);
  }
  await gateway.close();
});

test("setUser/setTags/setMetadata target the turn, then the conversation; tool links a pending call", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  await zoroval.conversation("c", () => {
    zoroval.setUser(7);
    zoroval.setTags("x", ["y"]);
    return zoroval.turn(async (turn) => {
      zoroval.setMetadata({ k: 1 });
      zoroval.setTags("z");
      assert.equal(zoroval.currentObservation(), turn);
      await zoroval.tool("search", { callId: "call_1", arguments: { q: "hi" } }, async (t) => { t.setOutput("found"); });
    });
  });
  await zoroval.flush(3000);
  const spans = gateway.spans();
  const turn = spans.find((s) => s.name === "turn");
  assert.equal(turn.attrs["zoroval.user.id"], "7");
  assert.deepEqual(turn.attrs["zoroval.tags"], ["x", "y", "z"]);
  assert.equal(turn.attrs["zoroval.metadata"], '{"k":1}');
  const tool = spans.find((s) => s.name === "execute_tool search");
  assert.equal(tool.attrs["gen_ai.tool.call.id"], "call_1");
  assert.equal(tool.attrs["gen_ai.operation.name"], "execute_tool");
  assert.equal(tool.attrs["gen_ai.tool.call.arguments"], '{"q":"hi"}');
  assert.equal(tool.attrs["gen_ai.tool.call.result"], '"found"');
  await gateway.close();
});

test("errors from the app's own callback pass through unchanged and mark the span", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  const boom = new TypeError("boom");
  await assert.rejects(zoroval.conversation("c", () => zoroval.turn(async () => { throw boom; })), (e) => e === boom);
  assert.throws(() => zoroval.turn(() => { throw boom; }), (e) => e === boom);
  await zoroval.flush(3000);
  const span = gateway.spans()[0];
  assert.equal(span.status.code, 2);
  assert.equal(span.status.message, "TypeError: boom");
  assert.equal(span.events[0].name, "exception");
  assert.equal(span.attrs["error.type"], "TypeError");
  assert.equal(await zoroval.conversation("c", () => 5), 5);
  await gateway.close();
});

test("a turn outside conversation() is ungrouped and says so once", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  const logged = await withWarnings(async () => {
    await zoroval.turn(async () => {});
    await zoroval.turn(async () => {});
  });
  assert.equal(logged.length, 1);
  await zoroval.flush(3000);
  assert.deepEqual(gateway.spans().map((s) => s.attrs["zoroval.grouping"]), ["ungrouped", "ungrouped"]);
  assert.equal(zoroval.status().ungroupedTurns, 2);
  await gateway.close();
});

test("a long conversation id is hashed the way Python does", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  const id = "é".repeat(300);
  await zoroval.conversation(id, () => zoroval.turn(() => {}));
  await zoroval.flush(3000);
  assert.equal(gateway.spans()[0].attrs["zoroval.conversation.id"], "sha256:" + createHash("sha256").update(id).digest("hex"));
  await gateway.close();
});

test("sampleRate 0 sends nothing; flush still resolves", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, sampleRate: 0, ...fast });
  await zoroval.conversation("c", () => zoroval.turn(() => {}));
  assert.equal(await zoroval.flush(500), true);
  assert.equal(gateway.requests.length, 0);
  assert.equal(zoroval.status().spansSampledOut, 1);
  await gateway.close();
});

test("flush waits (bounded) for a turn that is still open", async () => {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  let finish;
  const open = zoroval.conversation("c", () => zoroval.turn(() => new Promise((r) => { finish = r; })));
  setTimeout(() => finish(), 150);
  assert.equal(await zoroval.flush(3000), true);
  await open;
  assert.equal(gateway.spans().length, 1);
  await gateway.close();
});

test("zoroval.test is a real boolean in test mode", async () => {
  const internal = await import("../.test-build/internal.js");
  const gateway = await startGateway();
  internal.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  await internal.withTestMode(() => internal.conversation("t", () => internal.turn(() => {})));
  await internal.flush(3000);
  assert.strictEqual(gateway.spans()[0].attrs["zoroval.test"], true);
  assert.equal(gateway.requests[0].raw.resourceSpans[0].scopeSpans[0].spans[0].attributes.find((a) => a.key === "zoroval.test").value.boolValue, true);
  await internal.shutdown(1000);
  await gateway.close();
});

test("sha256 and uuid7 helpers behave", async () => {
  const { sha256Hex, uuid7 } = await import("../.test-build/internal.js");
  for (const text of ["", "abc", "é".repeat(100), "x".repeat(1000)]) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"));
  }
  assert.match(uuid7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
