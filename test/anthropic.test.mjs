// wrapAnthropic with the real `@anthropic-ai/sdk` against a local fake Messages API (no real calls).
import assert from "node:assert/strict";
import { test, afterEach, before, after } from "node:test";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway } from "./gateway.mjs";
import { CITATION, SEARCH_RESULT, startFakeAnthropic } from "./fake-anthropic.mjs";

// The SDK is loaded where it runs; on a Node it does not support, the tests say so and skip.
let Anthropic = null;
let loadError = null;
try {
  Anthropic = (await import("@anthropic-ai/sdk")).default;
} catch (error) {
  loadError = error;
}
const sdkTest = (name, fn) => test(name, { skip: Anthropic ? false : `@anthropic-ai/sdk does not load on Node ${process.versions.node}: ${loadError?.message}` }, fn);

let fake;
before(async () => { fake = await startFakeAnthropic(); });
after(async () => { await fake.close(); });
afterEach(async () => { await zoroval.shutdown(1000); });

const fast = { flushIntervalMs: 20 };
const gens = (gateway) => gateway.spans().filter((s) => s.attrs["zoroval.observation.type"] === "generation")
  .sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
const parsed = (text) => JSON.parse(text);
const client = () => new Anthropic({ apiKey: "sk-ant-test", baseURL: fake.url, maxRetries: 0 });

async function setup(options = {}) {
  const gateway = await startGateway();
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast, ...options });
  return gateway;
}

const SYSTEM = [{ type: "text", text: "You are Wanderly.", cache_control: { type: "ephemeral" } }];
const TOOLS = [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }, { type: "web_search_20250305", name: "web_search" }];

sdkTest("a tool loop in one conversation: model, tokens with cache, system, tool_use, tool_result history, linked tool", async () => {
  const gateway = await setup();
  const anthropic = zoroval.wrapAnthropic(client());
  await zoroval.conversation("chat-a1", { userId: "u1" }, async () => {
    await zoroval.turn({ input: "Weather in Paris?" }, async (turn) => {
      const messages = [{ role: "user", content: "Weather in Paris?" }];
      const first = await anthropic.messages.create({ model: "claude-test-tools", max_tokens: 100, temperature: 0.2, top_k: 5, stop_sequences: ["END"], system: SYSTEM, tools: TOOLS, messages });
      const call = first.content.find((b) => b.type === "tool_use");
      await zoroval.tool("get_weather", {}, async (t) => t.setOutput("18C"));
      messages.push({ role: "assistant", content: first.content }, { role: "user", content: [
        { type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: "18C" }, { type: "text", text: "light rain" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
      ] });
      const second = await anthropic.messages.create({ model: "claude-test", max_tokens: 100, system: SYSTEM, messages });
      turn.setOutput(second.content[0].text);
    });
  });
  await zoroval.flush(3000);
  const [a, b] = gens(gateway);
  assert.equal(a.name, "chat claude-test-tools");
  assert.equal(a.attrs["gen_ai.provider.name"], "anthropic");
  assert.equal(a.attrs["gen_ai.response.model"], "claude-test-tools-20261101");
  assert.equal(a.attrs["gen_ai.response.id"], "msg_test1");
  assert.deepEqual(a.attrs["gen_ai.response.finish_reasons"], ["tool_use"]);
  assert.equal(a.attrs["server.address"], "127.0.0.1");
  assert.equal(a.attrs["gen_ai.request.temperature"], 0.2);
  assert.equal(a.attrs["gen_ai.request.top_k"], 5);
  assert.equal(a.attrs["gen_ai.request.max_tokens"], 100);
  assert.deepEqual(a.attrs["gen_ai.request.stop_sequences"], ["END"]);
  assert.equal(a.attrs["gen_ai.conversation.id"], "chat-a1");
  // The whole prompt: 10 uncached + 100 read from cache + 5 written to it.
  assert.equal(a.attrs["gen_ai.usage.input_tokens"], 115);
  assert.equal(a.attrs["gen_ai.usage.output_tokens"], 20);
  assert.equal(a.attrs["gen_ai.usage.cache_read.input_tokens"], 100);
  assert.equal(a.attrs["gen_ai.usage.cache_creation.input_tokens"], 5);
  assert.deepEqual(parsed(a.attrs["gen_ai.system_instructions"]), [{ type: "text", content: "You are Wanderly." }]);
  assert.equal(parsed(a.attrs["gen_ai.tool.definitions"]).length, 2);
  assert.deepEqual(parsed(a.attrs["gen_ai.output.messages"]), [{ role: "assistant", finish_reason: "tool_use", parts: [
    { type: "text", content: "Checking." }, { type: "tool_call", id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' },
  ] }]);
  assert.deepEqual(parsed(a.attrs["zoroval.tool_calls"]), [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' }]);
  const history = parsed(b.attrs["gen_ai.input.messages"]);
  assert.deepEqual(history[1].parts, parsed(a.attrs["gen_ai.output.messages"])[0].parts, "the reply sent back as history maps the same");
  assert.deepEqual(history[2], { role: "user", parts: [{ type: "tool_call_response", id: "toolu_1", response: "18C\nlight rain\n[image omitted]" }] });
  const tool = gateway.spans().find((s) => s.name === "execute_tool get_weather");
  assert.equal(tool.attrs["gen_ai.tool.call.id"], "toolu_1");
  await gateway.close();
});

sdkTest("server tools and citations: web search and web fetch calls with their results (error flagged), citations kept, no encrypted fields", async () => {
  const gateway = await setup();
  const anthropic = zoroval.wrapAnthropic(client());
  const reply = await zoroval.turn({}, () => anthropic.messages.create({ model: "claude-test-server", max_tokens: 100, tools: TOOLS, messages: [{ role: "user", content: "Louvre hours?" }] }));
  await anthropic.messages.create({ model: "claude-test", max_tokens: 100, messages: [{ role: "user", content: "Louvre hours?" }, { role: "assistant", content: reply.content }, { role: "user", content: "Thanks" }] });
  await zoroval.flush(3000);
  const [a, b] = gens(gateway);
  const { encrypted_content, ...result } = SEARCH_RESULT;
  const { encrypted_index, ...citation } = CITATION;
  const expected = [
    { type: "tool_call", id: "srvtoolu_1", name: "web_search", arguments: '{"query":"Louvre hours"}' },
    { type: "tool_call_response", id: "srvtoolu_1", response: [result] },
    { type: "tool_call", id: "srvtoolu_2", name: "web_fetch", arguments: '{"url":"https://louvre.fr/closed"}' },
    { type: "tool_call_response", id: "srvtoolu_2", response: { type: "web_fetch_tool_error", error_code: "url_not_accessible" }, is_error: true },
    { type: "text", content: "It opens at 9.", citations: [citation] },
  ];
  assert.deepEqual(parsed(a.attrs["gen_ai.output.messages"])[0].parts, expected);
  assert.equal(a.attrs["zoroval.tool_calls"], undefined, "server tools are run by Anthropic, not by the app");
  assert.doesNotMatch(a.attrs["gen_ai.output.messages"], /encrypted/);
  assert.deepEqual(parsed(b.attrs["gen_ai.input.messages"])[1].parts, expected);
  await gateway.close();
});

sdkTest("stream() with thinking and server tools, and create({ stream: true }) with a tool call: rebuilt the same as the JSON reply", async () => {
  const gateway = await setup();
  const anthropic = zoroval.wrapAnthropic(client());
  await zoroval.turn({}, async () => {
    const helper = anthropic.messages.stream({ model: "claude-test-server", max_tokens: 100, thinking: { type: "enabled", budget_tokens: 50 }, messages: [{ role: "user", content: "Louvre?" }] });
    const final = await helper.finalMessage();
    assert.equal(final.content.at(-1).text, "It opens at 9.");
    const raw = await anthropic.messages.create({ model: "claude-test-tools", max_tokens: 100, stream: true, messages: [{ role: "user", content: "Paris?" }] });
    const events = [];
    for await (const event of raw) events.push(event.type);
    assert.equal(events.at(-1), "message_stop");
    await anthropic.messages.create({ model: "claude-test-server", max_tokens: 100, thinking: { type: "enabled", budget_tokens: 50 }, messages: [{ role: "user", content: "Louvre?" }] });
  });
  await zoroval.flush(3000);
  const [streamedServer, streamedTools, json] = gens(gateway);
  assert.equal(gens(gateway).length, 3, "stream() makes one span, not two");
  assert.equal(streamedServer.attrs["gen_ai.request.stream"], true);
  const parts = parsed(streamedServer.attrs["gen_ai.output.messages"])[0].parts;
  assert.deepEqual(parts[0], { type: "reasoning", content: "The user wants the hours." });
  assert.deepEqual(parts, parsed(json.attrs["gen_ai.output.messages"])[0].parts);
  assert.equal(streamedServer.attrs["gen_ai.usage.input_tokens"], 115);
  assert.equal(streamedServer.attrs["gen_ai.usage.output_tokens"], 20);
  assert.equal(typeof streamedServer.attrs["gen_ai.response.time_to_first_chunk"], "number");
  assert.deepEqual(parsed(streamedTools.attrs["zoroval.tool_calls"]), [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' }]);
  assert.deepEqual(streamedTools.attrs["gen_ai.response.finish_reasons"], ["tool_use"]);
  await gateway.close();
});

sdkTest("errors and raw responses: a 429 is RateLimitError with an exception event; withResponse and asResponse work", async () => {
  const gateway = await setup();
  const anthropic = zoroval.wrapAnthropic(client());
  await assert.rejects(() => anthropic.messages.create({ model: "claude-test-429", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), (e) => e.status === 429);
  const { data, response } = await anthropic.messages.create({ model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }).withResponse();
  assert.equal(data.content[0].text, "Hello there.");
  assert.equal(response.status, 200);
  const rawResponse = await anthropic.messages.create({ model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }).asResponse();
  assert.equal((await rawResponse.json()).content[0].text, "Hello there.");
  await zoroval.flush(3000);
  const [failed, withResponse, asResponse] = gens(gateway);
  assert.equal(failed.status.code, 2);
  assert.equal(failed.attrs["error.type"], "RateLimitError");
  assert.deepEqual(failed.events.map((e) => e.name), ["exception"]);
  assert.equal(parsed(withResponse.attrs["gen_ai.output.messages"])[0].parts[0].content, "Hello there.");
  assert.equal(asResponse.attrs["gen_ai.output.messages"], undefined, "the app reads the raw body itself");
  await gateway.close();
});

sdkTest("with no key the client is untouched and nothing is sent; init() after wrapAnthropic() starts tracing", async () => {
  const gateway = await startGateway();
  const anthropic = zoroval.wrapAnthropic(client()); // wrapped before init
  const reply = await anthropic.messages.create({ model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.equal(reply.content[0].text, "Hello there.");
  assert.equal(zoroval.init({ ingestUrl: gateway.url }), false);
  await anthropic.messages.create({ model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.equal(await zoroval.flush(500), true);
  assert.equal(gateway.requests.length, 0);
  const untouched = client();
  const before = untouched.messages.create;
  assert.equal(zoroval.wrapAnthropic(untouched), untouched);
  assert.equal(untouched.messages.create, before, "init() left tracing off: the client is not patched");
  zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
  await anthropic.messages.create({ model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "again" }] });
  await zoroval.flush(3000);
  assert.equal(gens(gateway).length, 1);
  await gateway.close();
});

test("a client that is not an Anthropic client is returned as is and never throws", async () => {
  const gateway = await setup();
  for (const odd of [{}, { messages: null }, { messages: { create: 1 } }, Object.freeze({ messages: Object.freeze({ create() {} }) })]) {
    assert.equal(zoroval.wrapAnthropic(odd), odd);
  }
  await gateway.close();
});

sdkTest("a web_fetch result holding a PDF keeps the document's shape with the base64 data replaced; beta.messages is traced too", async () => {
  const gateway = await setup();
  const anthropic = zoroval.wrapAnthropic(client());
  const pdf = { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_9", content: { type: "web_fetch_result", url: "https://x.org/a.pdf",
    content: { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK".repeat(50) }, title: "A" } } };
  await anthropic.beta.messages.create({ model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "read it" }, { role: "assistant", content: [pdf] }, { role: "user", content: "and?" }] });
  await zoroval.flush(3000);
  const [gen] = gens(gateway);
  assert.equal(gen.attrs["gen_ai.provider.name"], "anthropic");
  const part = parsed(gen.attrs["gen_ai.input.messages"])[1].parts[0];
  assert.deepEqual(part.response.content.source, { type: "base64", media_type: "application/pdf", data: "[application/pdf omitted]" });
  assert.doesNotMatch(gen.attrs["gen_ai.input.messages"], /JVBERi0/);
  await gateway.close();
});
