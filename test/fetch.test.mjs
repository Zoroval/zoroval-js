// wrapFetch with plain fetch against the local fake OpenAI API, and the 2G check.
import assert from "node:assert/strict";
import { test, afterEach, before, after } from "node:test";
import { OpenAI } from "./openai-packages.mjs";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway } from "./gateway.mjs";
import { startFakeOpenAI, BIG_CHUNKS, BIG_CHUNK_TEXT } from "./fake-openai.mjs";

let fake;
before(async () => { fake = await startFakeOpenAI(); });
after(async () => { await fake.close(); });
afterEach(async () => { await zoroval.shutdown(1000); });

const fast = { flushIntervalMs: 20 };
const gens = (gateway) => gateway.spans().filter((s) => s.attrs["zoroval.observation.type"] === "generation");
const parsed = (text) => JSON.parse(text);
const post = (fetchFn, path, body, base = fake.url, headers = {}) =>
  fetchFn(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-test", ...headers }, body: JSON.stringify(body) });

async function setup(options = {}) {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast, ...options });
  return gateway;
}

test("check 2 (Node half): plain fetch, non-stream and stream, one conversation with both turns", async () => {
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(globalThis.fetch, { baseURLs: [fake.url] });
  await zoroval.conversation("f-1", { userId: "u2" }, async () => {
    await zoroval.turn({ input: "weather?" }, async (turn) => {
      const tools = [{ type: "function", function: { name: "get_weather" } }];
      const reply = await (await post(tracedFetch, "/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "weather?" }], tools, temperature: 1 })).json();
      assert.equal(reply.choices[0].message.tool_calls[0].id, "call_abc123");
      await zoroval.tool("get_weather", {}, async (t) => { t.setOutput("22C"); });
      turn.setOutput("done");
    });
    await zoroval.turn({ input: "stream it" }, async () => {
      const response = await post(tracedFetch, "/chat/completions", { model: "gpt-test", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "stream it" }] });
      const text = await response.text();
      assert.match(text, /data: \[DONE\]/, "the app gets the whole, unchanged stream");
      assert.ok(response.url.endsWith("/chat/completions") && response.status === 200);
    });
  });
  assert.equal(await zoroval.flush(3000), true);
  const spans = gateway.spans();
  const turns = spans.filter((s) => s.attrs["zoroval.observation.type"] === "turn");
  assert.equal(turns.length, 2);
  assert.ok(turns.every((t) => t.attrs["zoroval.conversation.id"] === "f-1"));
  const [first, second] = gens(gateway).sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
  assert.equal(first.name, "chat gpt-test");
  assert.equal(first.parentSpanId, turns[0].spanId);
  assert.equal(first.attrs["gen_ai.provider.name"], "openai");
  assert.equal(first.attrs["gen_ai.request.temperature"], 1);
  assert.equal(first.attrs["gen_ai.usage.input_tokens"], 21);
  assert.deepEqual(parsed(first.attrs["zoroval.tool_calls"]), [{ id: "call_abc123", name: "get_weather", arguments: '{"city":"Paris"}' }]);
  assert.equal(parsed(first.attrs["gen_ai.tool.definitions"])[0].function.name, "get_weather");
  assert.equal(spans.find((s) => s.name === "execute_tool get_weather").attrs["gen_ai.tool.call.id"], "call_abc123");
  assert.equal(second.attrs["gen_ai.request.stream"], true);
  assert.equal(parsed(second.attrs["gen_ai.output.messages"])[0].parts[0].content, "You said: stream it");
  assert.equal(second.attrs["gen_ai.usage.output_tokens"], 9);
  assert.equal(typeof second.attrs["gen_ai.response.time_to_first_chunk"], "number");
  await gateway.close();
});

test("responses over fetch: stream and non-stream", async () => {
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(undefined, { baseURLs: [fake.url] });
  await zoroval.conversation("f-2", async () => {
    await zoroval.turn({}, async () => {
      await (await post(tracedFetch, "/responses", { model: "gpt-test", input: "hello", previous_response_id: "resp_prev" })).json();
      await (await post(tracedFetch, "/responses", { model: "gpt-test", input: "hello", stream: true })).text();
    });
  });
  await zoroval.flush(3000);
  const [a, b] = gens(gateway).sort((x, y) => x.startTimeUnixNano.localeCompare(y.startTimeUnixNano));
  assert.equal(a.attrs["gen_ai.openai.previous_response_id"], "resp_prev");
  assert.equal(parsed(a.attrs["gen_ai.output.messages"])[0].parts[0].content, "Echo: hello");
  assert.equal(b.attrs["gen_ai.usage.input_tokens"], 12);
  assert.equal(parsed(b.attrs["gen_ai.output.messages"])[0].parts[0].content, "Echo: hello");
  await gateway.close();
});

test("responses: OpenAI's built-in tools (web search, file search, MCP) are tool calls with their query, in output and input", async () => {
  const gateway = await setup();
  const body = {
    id: "resp_ws", model: "gpt-test", usage: { input_tokens: 5, output_tokens: 7 },
    output: [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "Lord's stadium events" } },
      { type: "file_search_call", id: "fs_1", status: "completed", queries: ["ticket policy"] },
      { type: "mcp_call", id: "mcp_1", name: "lookup", arguments: '{"q":"x"}', server_label: "s" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Check with the organiser." }] },
    ],
  };
  const inner = async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const tracedFetch = zoroval.wrapFetch(inner);
  await zoroval.turn({}, async () => {
    const history = [{ role: "user", content: "hi" }, { type: "web_search_call", id: "ws_0", status: "completed", action: { type: "search", query: "earlier" } }];
    await (await tracedFetch("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-test", input: history, tools: [{ type: "web_search" }] }) })).json();
  });
  await zoroval.flush(3000);
  const [gen] = gens(gateway);
  const out = parsed(gen.attrs["gen_ai.output.messages"])[0].parts;
  assert.deepEqual(out.slice(0, 3), [
    { type: "tool_call", id: "ws_1", name: "web_search", arguments: '{"type":"search","query":"Lord\'s stadium events"}' },
    { type: "tool_call", id: "fs_1", name: "file_search", arguments: '["ticket policy"]' },
    { type: "tool_call", id: "mcp_1", name: "lookup", arguments: '{"q":"x"}' },
  ]);
  assert.equal(out[3].content, "Check with the organiser.");
  assert.deepEqual(parsed(gen.attrs["zoroval.tool_calls"]).map((c) => c.name), ["web_search", "file_search", "lookup"]);
  const input = parsed(gen.attrs["gen_ai.input.messages"]);
  assert.deepEqual(input[1], { role: "assistant", parts: [{ type: "tool_call", id: "ws_0", name: "web_search", arguments: '{"type":"search","query":"earlier"}' }] });
  await gateway.close();
});

test("everything that is not an OpenAI call passes straight through: same call, same result, no span", async () => {
  const gateway = await setup();
  const calls = [];
  const inner = async (...args) => { calls.push(args); return new Response("ok"); };
  const tracedFetch = zoroval.wrapFetch(inner);
  const init = { method: "POST", body: "x" };
  const results = await Promise.all([
    tracedFetch("https://example.com/api", init),
    tracedFetch("https://api.openai.com/v1/models", { method: "GET" }),
    tracedFetch("https://api.openai.com/v1/chat/completions", { method: "GET" }),
    tracedFetch("https://api.openai.com/v1/embeddings", { method: "POST", body: "{}" }),
    tracedFetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "not json" }),
    tracedFetch("https://example.com/v1/chat/completions", { method: "POST", body: "{}" }),
  ]);
  assert.equal(calls.length, 6);
  assert.equal(calls[0][1], init, "the same init object, untouched");
  for (const r of results) assert.equal(await r.text(), "ok");
  await zoroval.flush(1000);
  assert.equal(gateway.spans().length, 0);
  await gateway.close();
});

test("disabled SDK: wrapFetch is a plain pass-through", async () => {
  const calls = [];
  const inner = async (input, init) => { calls.push([input, init]); return new Response("{}"); };
  const tracedFetch = zoroval.wrapFetch(inner);
  const init = { method: "POST", body: "{}" };
  await tracedFetch("https://api.openai.com/v1/chat/completions", init);
  assert.equal(calls[0][1], init);
});

test("a Request object input works and its body is not consumed", async () => {
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(globalThis.fetch, { baseURLs: [fake.url] });
  const request = new Request(`${fake.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "via Request" }] }) });
  const reply = await (await tracedFetch(request)).json();
  assert.equal(reply.choices[0].message.content, "You said: via Request");
  await zoroval.flush(3000);
  assert.equal(parsed(gens(gateway)[0].attrs["gen_ai.input.messages"])[0].parts[0].content, "via Request");
  await gateway.close();
});

test("no second span when wrapOpenAI already has a generation open (both on one client)", async () => {
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(globalThis.fetch, { baseURLs: [fake.url] });
  const openai = zoroval.wrapOpenAI(new OpenAI({ apiKey: "sk-test", baseURL: fake.url, maxRetries: 0, fetch: tracedFetch }));
  await zoroval.conversation("d-1", async () => {
    await zoroval.turn({}, async () => {
      await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
      const stream = await openai.chat.completions.create({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hi again" }] });
      for await (const chunk of stream) void chunk;
    });
  });
  await zoroval.flush(3000);
  assert.equal(gens(gateway).length, 2, "one span per call, not two");
  // and wrapFetch alone under the openai package (no wrapOpenAI) still traces
  const plain = new OpenAI({ apiKey: "sk-test", baseURL: fake.url, maxRetries: 0, fetch: tracedFetch });
  await plain.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "alone" }] });
  await zoroval.flush(3000);
  assert.equal(gens(gateway).length, 3);
  await gateway.close();
});

test("provider errors: the app gets the 429 response unchanged, the span has ERROR status; network failure rethrows", async () => {
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(globalThis.fetch, { baseURLs: [fake.url] });
  const response = await post(tracedFetch, "/chat/completions", { model: "gpt-test-429", messages: [] });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "rate_limit_exceeded");
  const tracedRefused = zoroval.wrapFetch(globalThis.fetch, { baseURLs: ["http://127.0.0.1:1/v1"] });
  await assert.rejects(() => post(tracedRefused, "/chat/completions", { model: "gpt-test", messages: [] }, "http://127.0.0.1:1/v1"), TypeError);
  await zoroval.flush(3000);
  const [limited, failed] = gens(gateway).sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
  assert.equal(limited.status.code, 2);
  assert.match(limited.status.message, /^429 Rate limit reached/);
  assert.equal(limited.attrs["error.type"], "requests");
  assert.equal(failed.status.code, 2);
  assert.equal(failed.attrs["error.type"], "TypeError");
  await gateway.close();
});

test("a stream that dies mid-way: the app sees its own error, the span gets ERROR status and keeps what arrived", async () => {
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(globalThis.fetch, { baseURLs: [fake.url] });
  const response = await post(tracedFetch, "/chat/completions", { model: "gpt-test-midfail", stream: true, messages: [{ role: "user", content: "one two three four five" }] });
  await assert.rejects(() => response.text());
  await zoroval.flush(3000);
  const [g] = gens(gateway);
  assert.equal(g.status.code, 2);
  assert.ok(parsed(g.attrs["gen_ai.output.messages"])[0].parts[0].content.length > 0);
  await gateway.close();
});

test("early cancel of the app's half does not break the app and the span ends once the provider is done", async () => {
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(globalThis.fetch, { baseURLs: [fake.url] });
  const response = await post(tracedFetch, "/chat/completions", { model: "gpt-test", stream: true, messages: [{ role: "user", content: "one two three four" }] });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await zoroval.flush(3000);
  assert.equal(gens(gateway).length, 1);
  assert.equal(gens(gateway)[0].status, undefined);
  await gateway.close();
});

test("an abort through the app's AbortController ends the span without ERROR status", async () => {
  const slow = await startFakeOpenAI({ chunkDelayMs: 40 });
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(globalThis.fetch, { baseURLs: [slow.url] });
  const controller = new AbortController();
  const response = await tracedFetch(`${slow.url}/chat/completions`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-test-big", stream: true, messages: [{ role: "user", content: "x" }] }) });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(async () => { for (;;) { const { done } = await reader.read(); if (done) return; } });
  await zoroval.flush(3000);
  const [g] = gens(gateway);
  assert.equal(g.status, undefined);
  await gateway.close();
  await slow.close();
});

test("2G: a large streamed answer over a slow link completes, and the SDK does not delay the app's stream", async () => {
  // About 11 KB/s to the app (a 2G-class link), a 90 KB streamed answer, and an ingest link of 6 KB/s.
  const slow = await startFakeOpenAI({ bytesPerSecond: 40_000 });
  const gateway = await startGateway(() => ({ bytesPerSecond: 6 * 1024 }));
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast, requestTimeoutMs: 400 });
  const body = { model: "gpt-test-big", stream: true, messages: [{ role: "user", content: "a long answer" }] };
  const timed = async (fetchFn) => {
    const started = performance.now();
    const response = await post(fetchFn, "/chat/completions", body, slow.url);
    let firstAt = 0, bytes = 0;
    for await (const chunk of response.body) { firstAt ||= performance.now() - started; bytes += chunk.length; }
    return { total: performance.now() - started, firstAt, bytes };
  };
  const plain = await timed(globalThis.fetch);
  const traced = await zoroval.conversation("g-1", () => zoroval.turn({}, () => timed(zoroval.wrapFetch(globalThis.fetch, { baseURLs: [slow.url] }))));
  assert.equal(traced.bytes, plain.bytes, "the app received every byte");
  assert.ok(traced.bytes > BIG_CHUNKS * BIG_CHUNK_TEXT.length, "a large stream");
  assert.ok(traced.total < plain.total * 1.25 + 300, `the SDK added no delay: ${Math.round(traced.total)} ms traced vs ${Math.round(plain.total)} ms plain`);
  assert.ok(traced.firstAt < plain.firstAt + 300, "first byte not delayed");
  assert.equal(await zoroval.flush(25_000), true, "the trace goes out over the slow link too");
  const [g] = gens(gateway);
  assert.equal(parsed(g.attrs["gen_ai.output.messages"])[0].parts[0].content.length, BIG_CHUNKS * BIG_CHUNK_TEXT.length, "the whole answer is in the span");
  assert.equal(g.attrs["gen_ai.response.finish_reasons"][0], "stop");
  await gateway.close();
  await slow.close();
});

test("a streamed tool call is linked to a tool() that runs the moment the app has read the stream", async () => {
  const gateway = await setup();
  const tracedFetch = zoroval.wrapFetch(globalThis.fetch, { baseURLs: [fake.url] });
  for (let i = 0; i < 20; i++) {
    await zoroval.conversation(`race-${i}`, () => zoroval.turn({}, async () => {
      const response = await post(tracedFetch, "/chat/completions", { model: "gpt-test", stream: true, messages: [{ role: "user", content: "weather?" }] });
      for await (const chunk of response.body) void chunk;
      zoroval.tool("get_weather", {}, () => "22C"); // synchronous, straight after the last chunk
    }));
  }
  await zoroval.flush(5000);
  const tools = gateway.spans().filter((s) => s.name === "execute_tool get_weather");
  assert.equal(tools.length, 20);
  assert.ok(tools.every((t) => t.attrs["gen_ai.tool.call.id"] === "call_abc123"), "all 20 linked");
  await gateway.close();
});
