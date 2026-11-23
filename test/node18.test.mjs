import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { KEY, startGateway } from "./gateway.mjs";

test("no global crypto (Node 18): ids still come from webcrypto, spans are sent", async () => {
  const gateway = await startGateway();
  const { stdout: out } = await promisify(execFile)(process.execPath, [new URL("./node18-child.mjs", import.meta.url).pathname, gateway.url, KEY], { encoding: "utf8", timeout: 20_000 });
  const result = JSON.parse(out.trim().split("\n").pop());
  assert.equal(result.typeofCrypto, "undefined");
  assert.equal(result.ok, true);
  assert.equal(result.status, 2);
  const spans = gateway.spans();
  assert.equal(spans.length, 2);
  for (const s of spans) { assert.match(s.traceId, /^[0-9a-f]{32}$/); assert.match(s.spanId, /^[0-9a-f]{16}$/); }
  assert.match(gateway.requests[0].headers["x-zoroval-batch-id"], /^[0-9a-f-]{36}$/);
  assert.notEqual(spans[0].spanId, spans[1].spanId);
  await gateway.close();
});
