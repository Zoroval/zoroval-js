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
