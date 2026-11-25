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

test("responses: one assistant message per output item; built-in tools carry their query and result; annotations stay; history maps the same", async () => {
  const gateway = await setup();
  const cite = { type: "url_citation", url: "https://lords.org/events", title: "Events", start_index: 0, end_index: 5 };
  const output = [
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Search first." }] },
    { type: "web_search_call", id: "ws_1", status: "completed",
      action: { type: "search", query: "Lord's stadium events", sources: [{ type: "url", url: "https://lords.org/events" }] } },
    { type: "file_search_call", id: "fs_1", status: "completed", queries: ["ticket policy"], results: [{ filename: "policy.md", score: 0.9, text: "No refunds." }] },
    { type: "code_interpreter_call", id: "ci_1", status: "completed", code: "print(1)", outputs: [{ type: "logs", logs: "1" }, { type: "image", url: "data:image/png;base64,AAAA" }] },
    { type: "mcp_call", id: "mcp_1", name: "lookup", arguments: '{"q":"x"}', server_label: "s", error: { message: "server down" } },
    { type: "image_generation_call", id: "ig_1", status: "completed", result: "iVBORw0KGgo" },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "book", arguments: '{"seat":"A1"}' },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Check with the organiser.", annotations: [cite] }] },
  ];
  const body = { id: "resp_ws", model: "gpt-test", status: "completed", usage: { input_tokens: 5, output_tokens: 7 }, output };
  const inner = async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const tracedFetch = zoroval.wrapFetch(inner);
  await zoroval.turn({}, async () => {
    // The app sends the previous reply back as history, the way the Responses docs show.
    const history = [{ role: "user", content: "hi" }, ...output, { type: "function_call_output", call_id: "call_1", output: "booked" }];
    await (await tracedFetch("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-test", input: history, tools: [{ type: "web_search" }] }) })).json();
  });
  await zoroval.flush(3000);
  const [gen] = gens(gateway);
  const out = parsed(gen.attrs["gen_ai.output.messages"]);
  assert.equal(out.length, output.length, "one message per output item");
  assert.ok(out.every((m) => m.role === "assistant"));
  assert.deepEqual(out.map((m) => m.finish_reason ?? null), [null, null, null, null, null, null, null, "completed"]);
  assert.deepEqual(out[0].parts, [{ type: "reasoning", content: "Search first." }]);
  assert.deepEqual(out[1].parts, [
    { type: "tool_call", id: "ws_1", name: "web_search", arguments: '{"query":"Lord\'s stadium events"}' },
    { type: "tool_call_response", id: "ws_1", response: [{ type: "url", url: "https://lords.org/events" }] },
  ]);
  assert.deepEqual(out[2].parts, [
    { type: "tool_call", id: "fs_1", name: "file_search", arguments: '["ticket policy"]' },
    { type: "tool_call_response", id: "fs_1", response: [{ filename: "policy.md", score: 0.9, text: "No refunds." }] },
  ]);
  assert.deepEqual(out[3].parts[1], { type: "tool_call_response", id: "ci_1", response: [{ type: "logs", logs: "1" }, "[image omitted]"] });
  assert.deepEqual(out[4].parts[1], { type: "tool_call_response", id: "mcp_1", response: { message: "server down" }, is_error: true });
  assert.deepEqual(out[5].parts, [{ type: "tool_call", id: "ig_1", name: "image_generation", arguments: "{}" }, { type: "tool_call_response", id: "ig_1", response: "[image omitted]" }]);
  assert.deepEqual(out[6].parts, [{ type: "tool_call", id: "call_1", name: "book", arguments: '{"seat":"A1"}' }]);
  assert.deepEqual(out[7].parts, [{ type: "text", content: "Check with the organiser.", annotations: [cite] }]);
  assert.deepEqual(parsed(gen.attrs["zoroval.tool_calls"]).map((c) => c.name), ["web_search", "file_search", "code_interpreter", "lookup", "image_generation", "book"]);
  // The same items sent back as history give the same messages, so the reader can match them.
  const input = parsed(gen.attrs["gen_ai.input.messages"]);
  assert.deepEqual(input.slice(1, 1 + output.length), out.map(({ finish_reason, ...m }) => m));
  assert.deepEqual(input.at(-1), { role: "tool", parts: [{ type: "tool_call_response", id: "call_1", response: "booked" }] });
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
  // Named by the HTTP status the way the openai package names its error, not by the body's `type` ("requests").
  assert.equal(limited.status.message, "RateLimitError: 429 Rate limit reached");
  assert.equal(limited.attrs["error.type"], "RateLimitError");
  assert.deepEqual(limited.events.map((e) => [e.name, e.attributes.find((a) => a.key === "exception.type").value.stringValue]), [["exception", "RateLimitError"]]);
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

const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("OpenAI-compatible providers: reasoning (DeepSeek, OpenRouter) in replies, streams and history; Groq stream usage; provider from the host", async () => {
  const gateway = await setup();
  const replies = {
    "https://api.deepseek.com/chat/completions": json({ id: "ds1", model: "deepseek-reasoner", usage: { prompt_tokens: 3, completion_tokens: 4 },
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Mornings.", reasoning_content: "Peak hours are 8 to 10." } }] }),
    "https://openrouter.ai/api/v1/chat/completions": sse([
      { id: "or1", model: "x", choices: [{ index: 0, delta: { role: "assistant", reasoning: "Think ", reasoning_details: [{ type: "reasoning.text", text: "Think " }] } }] },
      { id: "or1", choices: [{ index: 0, delta: { reasoning: "twice.", reasoning_details: [{ type: "reasoning.text", text: "twice." }] } }] },
      { id: "or1", choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] },
    ]),
    "https://api.groq.com/openai/v1/chat/completions": sse([
      { id: "gq1", model: "llama", choices: [{ index: 0, delta: { content: "Hi" } }] },
      { id: "gq1", choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.summary", summary: "Greeted." }] }, finish_reason: "stop" }], x_groq: { usage: { prompt_tokens: 9, completion_tokens: 2 } } },
    ]),
  };
  const inner = async (url) => replies[String(url)];
  const tracedFetch = zoroval.wrapFetch(inner, { baseURLs: ["https://api.deepseek.com", "https://openrouter.ai/api/v1", "https://api.groq.com/openai/v1"] });
  const history = [{ role: "user", content: "When?" }, { role: "assistant", content: "Mornings.", reasoning_content: "Peak hours are 8 to 10." }, { role: "user", content: "Sure?" }];
  await zoroval.turn({}, async () => {
    await (await post(tracedFetch, "/chat/completions", { model: "deepseek-reasoner", messages: history }, "https://api.deepseek.com")).json();
    await (await post(tracedFetch, "/chat/completions", { model: "x", stream: true, messages: history }, "https://openrouter.ai/api/v1")).text();
    await (await post(tracedFetch, "/chat/completions", { model: "llama", stream: true, messages: history }, "https://api.groq.com/openai/v1")).text();
  });
  await zoroval.flush(3000);
  const [ds, or, gq] = gens(gateway).sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
  assert.deepEqual([ds, or, gq].map((g) => g.attrs["gen_ai.provider.name"]), ["deepseek", "openrouter", "groq"]);
  assert.deepEqual(parsed(ds.attrs["gen_ai.output.messages"])[0].parts, [{ type: "reasoning", content: "Peak hours are 8 to 10." }, { type: "text", content: "Mornings." }]);
  assert.deepEqual(parsed(ds.attrs["gen_ai.input.messages"])[1].parts, [{ type: "reasoning", content: "Peak hours are 8 to 10." }, { type: "text", content: "Mornings." }]);
  // `reasoning` and `reasoning_details` carry the same text on OpenRouter: it is recorded once.
  assert.deepEqual(parsed(or.attrs["gen_ai.output.messages"])[0].parts, [{ type: "reasoning", content: "Think twice." }, { type: "text", content: "Done." }]);
  assert.deepEqual(parsed(gq.attrs["gen_ai.output.messages"])[0].parts, [{ type: "reasoning", content: "Greeted." }, { type: "text", content: "Hi" }]);
  assert.equal(gq.attrs["gen_ai.usage.input_tokens"], 9);
  assert.equal(gq.attrs["gen_ai.usage.output_tokens"], 2);
  await gateway.close();
});

test("chat completions: annotations stay on the text part, in replies and in history", async () => {
  const gateway = await setup();
  const cite = { type: "url_citation", url_citation: { url: "https://example.org", title: "Ex", start_index: 0, end_index: 4 } };
  const message = { role: "assistant", content: "Ex says yes.", annotations: [cite] };
  const inner = async (_, init) => (JSON.parse(init.body).stream
    ? sse([{ id: "c2", choices: [{ index: 0, delta: { content: "Ex says yes.", annotations: [cite] }, finish_reason: "stop" }] }])
    : json({ id: "c1", model: "gpt-4o-search-preview", choices: [{ index: 0, finish_reason: "stop", message }] }));
  const tracedFetch = zoroval.wrapFetch(inner);
  await zoroval.turn({}, async () => {
    await (await post(tracedFetch, "/chat/completions", { model: "m", messages: [{ role: "user", content: "q" }] }, "https://api.openai.com/v1")).json();
    await (await post(tracedFetch, "/chat/completions", { model: "m", stream: true, messages: [{ role: "user", content: "q" }, message] }, "https://api.openai.com/v1")).text();
  });
  await zoroval.flush(3000);
  const [a, b] = gens(gateway).sort((x, y) => x.startTimeUnixNano.localeCompare(y.startTimeUnixNano));
  const part = { type: "text", content: "Ex says yes.", annotations: [cite] };
  assert.deepEqual(parsed(a.attrs["gen_ai.output.messages"])[0].parts, [part]);
  assert.deepEqual(parsed(b.attrs["gen_ai.output.messages"])[0].parts, [part]);
  assert.deepEqual(parsed(b.attrs["gen_ai.input.messages"])[1].parts, [part]);
  assert.equal(a.attrs["gen_ai.provider.name"], "openai");
  await gateway.close();
});

test("wrapOpenAI: the provider comes from the client's base URL host; Azure and unknown hosts as before", async () => {
  const gateway = await setup();
  const toFake = (base) => (url, init) => globalThis.fetch(String(url).replace(base, fake.url), init);
  const groq = zoroval.wrapOpenAI(new OpenAI({ apiKey: "k", maxRetries: 0, baseURL: "https://api.groq.com/openai/v1", fetch: toFake("https://api.groq.com/openai/v1") }));
  const local = zoroval.wrapOpenAI(new OpenAI({ apiKey: "k", maxRetries: 0, baseURL: fake.url }));
  await zoroval.turn({}, async () => {
    await groq.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    await local.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
  });
  await zoroval.flush(3000);
  const [a, b] = gens(gateway).sort((x, y) => x.startTimeUnixNano.localeCompare(y.startTimeUnixNano));
  assert.equal(a.attrs["gen_ai.provider.name"], "groq");
  assert.equal(a.attrs["server.address"], "api.groq.com");
  assert.equal(b.attrs["gen_ai.provider.name"], "openai");
  await gateway.close();
});
