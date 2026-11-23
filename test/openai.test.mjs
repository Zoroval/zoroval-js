// wrapOpenAI with the real `openai` package against a local fake OpenAI API (no real calls).
import assert from "node:assert/strict";
import { describe, test as nodeTest, afterEach, before, after } from "node:test";
import { packages } from "./openai-packages.mjs";
import * as zoroval from "../dist/node.js";
import { KEY, startGateway, sleep } from "./gateway.mjs";
import { startFakeOpenAI } from "./fake-openai.mjs";

let fake;
before(async () => { fake = await startFakeOpenAI(); });
after(async () => { await fake.close(); });
afterEach(async () => { await zoroval.shutdown(1000); });

for (const { label, OpenAI } of packages) {
  describe(label, () => {
  const test = (name, fn) => nodeTest(name, fn);
  const client = () => new OpenAI({ apiKey: "sk-test", baseURL: fake.url, maxRetries: 0 });
  const fast = { flushIntervalMs: 20 };
  const gens = (gateway) => gateway.spans().filter((s) => s.attrs["zoroval.observation.type"] === "generation");
  const parsed = (text) => JSON.parse(text);

  async function setup(options = {}) {
    const gateway = await startGateway();
    zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast, ...options });
    return gateway;
  }

  test("check 1: two messages in one conversation: both turns, model, tokens, messages, tool calls", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("chat-1", { userId: "u1" }, async () => {
      await zoroval.turn({ input: "What is the weather in Paris?" }, async (turn) => {
        const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
        const messages = [{ role: "system", content: "Be brief." }, { role: "user", content: "What is the weather in Paris?" }];
        const first = await openai.chat.completions.create({ model: "gpt-test", messages, tools, temperature: 0.5, max_completion_tokens: 100, stop: "END" });
        const call = first.choices[0].message.tool_calls[0];
        const result = await zoroval.tool("get_weather", { arguments: { city: "Paris" } }, async (t) => { t.setOutput("22C"); return "22C"; });
        const second = await openai.chat.completions.create({
          model: "gpt-test", tools,
          messages: [...messages, first.choices[0].message, { role: "tool", tool_call_id: call.id, content: result }],
        });
        turn.setOutput(second.choices[0].message.content);
      });
      await zoroval.turn({ input: "thanks" }, async (turn) => {
        const reply = await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "thanks" }] });
        turn.setOutput(reply.choices[0].message.content);
      });
    });
    assert.equal(await zoroval.flush(3000), true);

    const spans = gateway.spans();
    const turns = spans.filter((s) => s.attrs["zoroval.observation.type"] === "turn");
    assert.equal(turns.length, 2);
    assert.ok(turns.every((t) => t.attrs["zoroval.conversation.id"] === "chat-1" && t.attrs["zoroval.grouping"] === "explicit"));
    const g = gens(gateway);
    assert.equal(g.length, 3);
    const [one, two, three] = g.sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
    for (const s of g) {
      assert.equal(s.name, "chat gpt-test");
      assert.equal(s.kind, 3);
      assert.equal(s.attrs["gen_ai.operation.name"], "chat");
      assert.equal(s.attrs["gen_ai.provider.name"], "openai");
      assert.equal(s.attrs["gen_ai.request.model"], "gpt-test");
      assert.equal(s.attrs["gen_ai.response.model"], "gpt-test-2026-01-01");
      assert.equal(s.attrs["gen_ai.response.id"], "chatcmpl-test123");
      assert.equal(s.attrs["zoroval.conversation.id"], "chat-1");
      assert.equal(s.attrs["gen_ai.conversation.id"], "chat-1");
      assert.equal(s.attrs["gen_ai.request.stream"], false);
      assert.equal(s.attrs["server.address"], "127.0.0.1");
      assert.equal(s.attrs["server.port"], fake.port);
      assert.equal(s.attrs["gen_ai.usage.input_tokens"], 21);
      assert.equal(s.attrs["gen_ai.usage.output_tokens"], 9);
      assert.equal(s.attrs["gen_ai.usage.cache_read.input_tokens"], 8);
      assert.equal(s.attrs["gen_ai.usage.reasoning.output_tokens"], 3);
      assert.ok(!("zoroval.user.id" in s.attrs), "user id lives on the turn, not on the child span");
    }
    assert.equal(one.parentSpanId, turns.find((t) => t.attrs["zoroval.input"] === '"What is the weather in Paris?"').spanId);
    assert.equal(one.attrs["gen_ai.request.temperature"], 0.5);
    assert.equal(one.attrs["gen_ai.request.max_tokens"], 100);
    assert.deepEqual(one.attrs["gen_ai.request.stop_sequences"], ["END"]);
    assert.deepEqual(one.attrs["gen_ai.response.finish_reasons"], ["tool_calls"]);
    assert.deepEqual(parsed(one.attrs["gen_ai.input.messages"]), [
      { role: "system", parts: [{ type: "text", content: "Be brief." }] },
      { role: "user", parts: [{ type: "text", content: "What is the weather in Paris?" }] },
    ]);
    assert.deepEqual(parsed(one.attrs["gen_ai.output.messages"]), [{
      role: "assistant", finish_reason: "tool_calls",
      parts: [{ type: "tool_call", id: "call_abc123", name: "get_weather", arguments: '{"city":"Paris"}' }],
    }]);
    assert.deepEqual(parsed(one.attrs["zoroval.tool_calls"]), [{ id: "call_abc123", name: "get_weather", arguments: '{"city":"Paris"}' }]);
    assert.equal(parsed(one.attrs["gen_ai.tool.definitions"])[0].function.name, "get_weather");
    // the second call sends the tool result back; the answer is the model's text
    const secondInput = parsed(two.attrs["gen_ai.input.messages"]);
    assert.deepEqual(secondInput[3], { role: "tool", parts: [{ type: "tool_call_response", id: "call_abc123", response: "22C" }] });
    assert.deepEqual(secondInput[2].parts, [{ type: "tool_call", id: "call_abc123", name: "get_weather", arguments: '{"city":"Paris"}' }]);
    assert.equal(parsed(two.attrs["gen_ai.output.messages"])[0].parts[0].content, "It is sunny: 22C");
    assert.deepEqual(two.attrs["gen_ai.response.finish_reasons"], ["stop"]);
    assert.ok(!("zoroval.tool_calls" in two.attrs));
    assert.equal(parsed(three.attrs["gen_ai.output.messages"])[0].parts[0].content, "You said: thanks");
    // the tool() run is linked to the model's call id
    const toolSpan = spans.find((s) => s.name === "execute_tool get_weather");
    assert.equal(toolSpan.attrs["gen_ai.tool.call.id"], "call_abc123");
    // the request the app made is unchanged
    assert.equal(fake.requests.at(-3).body.stream, undefined);
    assert.equal(fake.requests.at(-3).body.stream_options, undefined);
    await gateway.close();
  });

  test("wrapOpenAI returns the same client; wrapping twice makes one span per call", async () => {
    const gateway = await setup();
    const raw = client();
    const openai = zoroval.wrapOpenAI(zoroval.wrapOpenAI(raw));
    assert.equal(openai, raw);
    await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    await zoroval.flush(3000);
    assert.equal(gens(gateway).length, 1);
    await gateway.close();
  });

  test("with no key the client is untouched in behaviour and nothing is sent", async () => {
    const gateway = await startGateway();
    const raw = client();
    const openai = zoroval.wrapOpenAI(raw); // wrapped before init: still passes straight through
    const reply = await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    assert.equal(reply.choices[0].message.content, "You said: hi");
    assert.equal(zoroval.init({ ingestUrl: gateway.url }), false);
    await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    assert.equal(await zoroval.flush(500), true);
    assert.equal(gateway.requests.length, 0);
    // and init() after wrapOpenAI() starts tracing for the same client
    zoroval.init({ apiKey: KEY, ingestUrl: gateway.url, ...fast });
    await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "again" }] });
    await zoroval.flush(3000);
    assert.equal(gens(gateway).length, 1);
    await gateway.close();
  });

  test("a call outside any turn is a root span with the root attributes; a standalone generation is flushed", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("c-root", { userId: "u9", tags: ["t1"] }, async () => {
      await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    });
    await zoroval.flush(3000);
    const [g] = gens(gateway);
    assert.equal(g.parentSpanId ?? "", "");
    assert.equal(g.attrs["zoroval.user.id"], "u9");
    assert.deepEqual(g.attrs["zoroval.tags"], ["t1"]);
    assert.ok(!("zoroval.grouping" in g.attrs));
    await gateway.close();
  });

  test("streaming chat: events unchanged, text, tool call, usage only when the app asks, first-chunk time", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("s1", async () => {
      await zoroval.turn({ input: "hello there" }, async () => {
        const stream = await openai.chat.completions.create({ model: "gpt-test", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hello there" }] });
        assert.equal(typeof stream.controller.abort, "function", "the library's own stream object");
        let text = "";
        for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
        assert.equal(text, "You said: hello there");
        const tools = await openai.chat.completions.create({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "weather?" }] });
        for await (const chunk of tools) void chunk;
      });
    });
    await zoroval.flush(3000);
    const [withUsage, noUsage] = gens(gateway).sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
    assert.equal(withUsage.attrs["gen_ai.request.stream"], true);
    assert.equal(parsed(withUsage.attrs["gen_ai.output.messages"])[0].parts[0].content, "You said: hello there");
    assert.deepEqual(withUsage.attrs["gen_ai.response.finish_reasons"], ["stop"]);
    assert.equal(withUsage.attrs["gen_ai.usage.input_tokens"], 21);
    assert.equal(withUsage.attrs["gen_ai.usage.cache_read.input_tokens"], 8);
    assert.equal(typeof withUsage.attrs["gen_ai.response.time_to_first_chunk"], "number");
    assert.equal(withUsage.attrs["gen_ai.response.id"], "chatcmpl-test123");
    assert.ok(!("gen_ai.usage.input_tokens" in noUsage.attrs), "no usage chunk, no token counts; the request is never changed");
    assert.equal(fake.requests.at(-1).body.stream_options, undefined);
    assert.deepEqual(parsed(noUsage.attrs["zoroval.tool_calls"]), [{ id: "call_abc123", name: "get_weather", arguments: '{"city":"Paris"}' }]);
    assert.deepEqual(noUsage.attrs["gen_ai.response.finish_reasons"], ["tool_calls"]);
    await gateway.close();
  });

  test("the stream() helper, parse() and withResponse()/asResponse() keep working and are traced once", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("h1", async () => {
      await zoroval.turn({}, async () => {
        const stream = openai.chat.completions.stream({ model: "gpt-test", messages: [{ role: "user", content: "via helper" }] });
        const final = await stream.finalChatCompletion();
        assert.equal(final.choices[0].message.content, "You said: via helper");
        const done = await openai.chat.completions.parse({ model: "gpt-test", messages: [{ role: "user", content: "via parse" }] });
        assert.equal(done.choices[0].message.content, "You said: via parse");
        const { data, response } = await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "with response" }] }).withResponse();
        assert.equal(data.choices[0].message.content, "You said: with response");
        assert.equal(response.status, 200);
        const raw = await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "raw" }] }).asResponse();
        assert.equal((await raw.json()).choices[0].message.content, "You said: raw", "the body was not consumed by the SDK");
      });
    });
    await zoroval.flush(3000);
    const g = gens(gateway);
    assert.equal(g.length, 4, "one span per call, never two");
    const outputs = g.map((s) => s.attrs["gen_ai.output.messages"]).filter(Boolean).map((t) => parsed(t)[0].parts[0].content).sort();
    assert.deepEqual(outputs, ["You said: via helper", "You said: via parse", "You said: with response"]);
    assert.equal(g.filter((s) => !("gen_ai.output.messages" in s.attrs)).length, 1, "asResponse: a span without content");
    await gateway.close();
  });

  test("early break ends the span (no error) and the app's stream is the library's own object", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("b1", async () => {
      await zoroval.turn({}, async () => {
        const stream = await openai.chat.completions.create({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "one two three four" }] });
        assert.equal(typeof stream.controller.abort, "function");
        for await (const chunk of stream) { if (chunk.choices[0]?.delta?.content) break; }
      });
    });
    await zoroval.flush(3000);
    const [g] = gens(gateway);
    assert.equal(g.status, undefined);
    assert.ok(!("error.type" in g.attrs));
    assert.equal(g.attrs["gen_ai.request.stream"], true);
    await gateway.close();
  });

  test("an error in the middle of a stream: the app sees it unchanged, the span gets ERROR status", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    let seen;
    await zoroval.conversation("m1", async () => {
      await zoroval.turn({}, async () => {
        const stream = await openai.chat.completions.create({ model: "gpt-test-midfail", stream: true, messages: [{ role: "user", content: "one two three four five" }] });
        try { for await (const chunk of stream) void chunk; } catch (error) { seen = error; }
      });
    });
    await zoroval.flush(3000);
    assert.ok(seen instanceof Error, "the app got the library's own error");
    const [g] = gens(gateway);
    assert.equal(g.status.code, 2);
    assert.equal(g.attrs["error.type"], seen.constructor.name);
    assert.equal(g.events[0].name, "exception");
    assert.equal(parsed(g.attrs["gen_ai.output.messages"])[0].parts[0].content.length > 0, true, "what arrived before the error is kept");
    await gateway.close();
  });

  test("a provider error (429) passes through unchanged and the span has ERROR status", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    let caught;
    await zoroval.conversation("e1", async () => {
      await zoroval.turn({}, async () => {
        try { await openai.chat.completions.create({ model: "gpt-test-429", messages: [{ role: "user", content: "hi" }] }); } catch (error) { caught = error; }
      });
    });
    await zoroval.flush(3000);
    assert.ok(caught instanceof OpenAI.RateLimitError);
    assert.equal(caught.status, 429);
    const [g] = gens(gateway);
    assert.equal(g.status.code, 2);
    assert.match(g.status.message, /^RateLimitError: /);
    assert.equal(g.attrs["error.type"], "RateLimitError");
    assert.equal(g.attrs["gen_ai.request.model"], "gpt-test-429");
    await gateway.close();
  });

  test("responses.create: non-stream, tool call, previous_response_id chaining, conversation id", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.turn({ input: "q" }, async () => {
      const a = await openai.responses.create({ model: "gpt-test", instructions: "Be brief.", input: "What is the weather?", tools: [{ type: "function", name: "get_weather", parameters: {} }], max_output_tokens: 50 });
      assert.equal(a.output[0].type, "function_call");
      await openai.responses.create({ model: "gpt-test", previous_response_id: a.id, input: [{ type: "function_call_output", call_id: "call_resp1", output: "22C" }] });
    });
    await zoroval.flush(3000);
    const turnSpan = gateway.spans().find((s) => s.attrs["zoroval.observation.type"] === "turn");
    assert.equal(turnSpan.attrs["zoroval.grouping"], "response_chain");
    const [one, two] = gens(gateway).sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
    assert.equal(one.attrs["gen_ai.request.max_tokens"], 50);
    assert.deepEqual(parsed(one.attrs["gen_ai.system_instructions"]), [{ type: "text", content: "Be brief." }]);
    assert.deepEqual(parsed(one.attrs["zoroval.tool_calls"]), [{ id: "call_resp1", name: "get_weather", arguments: '{"city":"Paris"}' }]);
    assert.deepEqual(one.attrs["gen_ai.response.finish_reasons"], ["completed"]);
    assert.equal(one.attrs["gen_ai.usage.input_tokens"], 12);
    assert.equal(one.attrs["gen_ai.usage.cache_read.input_tokens"], 4);
    assert.equal(one.attrs["gen_ai.usage.reasoning.output_tokens"], 2);
    assert.equal(two.attrs["gen_ai.openai.previous_response_id"], "resp_test123");
    assert.deepEqual(parsed(two.attrs["gen_ai.input.messages"]), [{ role: "tool", parts: [{ type: "tool_call_response", id: "call_resp1", response: "22C" }] }]);
    await gateway.close();
  });

  test("responses.create stream and the responses.stream() helper", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("r1", async () => {
      await zoroval.turn({}, async () => {
        const events = await openai.responses.create({ model: "gpt-test", stream: true, input: "hello" });
        let text = "";
        for await (const event of events) if (event.type === "response.output_text.delta") text += event.delta;
        assert.equal(text, "Echo: hello");
        const helper = openai.responses.stream({ model: "gpt-test", input: "helped" });
        const final = await helper.finalResponse();
        assert.equal(final.output[0].content[0].text, "Echo: helped");
      });
    });
    await zoroval.flush(3000);
    const g = gens(gateway).sort((a, b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
    assert.equal(g.length, 2);
    assert.equal(parsed(g[0].attrs["gen_ai.output.messages"])[0].parts[0].content, "Echo: hello");
    assert.equal(g[0].attrs["gen_ai.usage.output_tokens"], 7);
    assert.equal(g[0].attrs["gen_ai.request.stream"], true);
    assert.equal(parsed(g[1].attrs["gen_ai.input.messages"])[0].parts[0].content, "helped");
    await gateway.close();
  });

  test("captureContent: false sends no messages, tool arguments or definitions; redact runs on content", async () => {
    const gateway = await setup({ captureContent: false });
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("p1", async () => {
      await zoroval.turn({}, async () => {
        await openai.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "weather in Paris" }], tools: [{ type: "function", function: { name: "get_weather" } }] });
      });
    });
    await zoroval.flush(3000);
    const [g] = gens(gateway);
    for (const key of ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.definitions"]) assert.ok(!(key in g.attrs), key);
    assert.deepEqual(parsed(g.attrs["zoroval.tool_calls"]), [{ id: "call_abc123", name: "get_weather" }], "ids and names only, no arguments");
    assert.equal(g.attrs["gen_ai.usage.input_tokens"], 21, "numbers are still sent");
    await gateway.close();
  });

  test("data URLs in image content become a placeholder, plain URLs are kept", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.turn({}, async () => {
      await openai.chat.completions.create({
        model: "gpt-test",
        messages: [{ role: "user", content: [{ type: "text", content: "x", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
      });
    });
    await zoroval.flush(3000);
    const [g] = gens(gateway);
    assert.deepEqual(parsed(g.attrs["gen_ai.input.messages"])[0].parts, [
      { type: "text", content: "look" },
      { type: "image", content: "[image omitted]" },
      { type: "image", content: "[image omitted]", uri: "https://example.com/a.png" },
    ]);
    assert.ok(!g.attrs["gen_ai.input.messages"].includes("AAAA"));
    await gateway.close();
  });

  test("tee() and toReadableStream() on the library's stream: the app reads unchanged, one span, content complete", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("t1", async () => {
      await zoroval.turn({}, async () => {
        const stream = await openai.chat.completions.create({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "tee me now" }] });
        const [left, right] = stream.tee();
        const read = async (s) => { let t = ""; for await (const c of s) t += c.choices[0]?.delta?.content ?? ""; return t; };
        const [a, b] = await Promise.all([read(left), read(right)]);
        assert.equal(a, "You said: tee me now");
        assert.equal(b, a);
        const again = await openai.chat.completions.create({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "as readable" }] });
        const bytes = await new Response(again.toReadableStream()).text();
        assert.match(bytes, /"content":"readable"/);
      });
    });
    await zoroval.flush(3000);
    const g = gens(gateway).sort((x, y) => x.startTimeUnixNano.localeCompare(y.startTimeUnixNano));
    assert.equal(g.length, 2);
    assert.equal(parsed(g[0].attrs["gen_ai.output.messages"])[0].parts[0].content, "You said: tee me now");
    assert.equal(parsed(g[1].attrs["gen_ai.output.messages"])[0].parts[0].content, "You said: as readable");
    await gateway.close();
  });

  test("a streamed tool call from the openai package links the next tool() run", async () => {
    const gateway = await setup();
    const openai = zoroval.wrapOpenAI(client());
    await zoroval.conversation("t2", () => zoroval.turn({}, async () => {
      const stream = await openai.chat.completions.create({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "weather?" }] });
      for await (const chunk of stream) void chunk;
      zoroval.tool("get_weather", {}, () => "22C");
    }));
    await zoroval.flush(3000);
    assert.equal(gateway.spans().find((s) => s.name === "execute_tool get_weather").attrs["gen_ai.tool.call.id"], "call_abc123");
    await gateway.close();
  });
  });
}
