// A local fake OpenAI API for tests: realistic JSON and SSE for /v1/chat/completions and /v1/responses,
// including tool calls, usage (cached and reasoning tokens), errors and a slow link. No real OpenAI call.
//
// The model name picks the behaviour: "...-429" (rate limit), "...-midfail" (stream that dies after two
// chunks), "...-big" (a long streamed answer). A user message that mentions "weather" makes the model ask
// for the get_weather tool, and a tool message in the history makes it answer.
import { createServer } from "node:http";

export const BIG_CHUNKS = 400;
export const BIG_CHUNK_TEXT = "lorem ipsum dolor sit amet, ".repeat(8);

const sse = (res, event, data) => res.write((event ? `event: ${event}\n` : "") + `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function chatPlan(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const wantsWeather = messages.some((m) => typeof m.content === "string" && /weather/i.test(m.content));
  if (last?.role !== "tool" && wantsWeather) {
    return { content: null, finish: "tool_calls", calls: [{ id: "call_abc123", name: "get_weather", arguments: '{"city":"Paris"}' }] };
  }
  if (last?.role === "tool") return { content: `It is sunny: ${last.content}`, finish: "stop", calls: [] };
  if (String(body.model).endsWith("-big")) return { content: BIG_CHUNK_TEXT.repeat(BIG_CHUNKS), finish: "stop", calls: [] };
  const text = typeof last?.content === "string" ? last.content : "hello";
  return { content: `You said: ${text}`, finish: "stop", calls: [] };
}

const usage = { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 3 } };

async function chat(body, res, options) {
  const model = String(body.model);
  const plan = chatPlan(body);
  const id = "chatcmpl-test123";
  if (!body.stream) {
    const message = { role: "assistant", content: plan.content };
    if (plan.calls.length) message.tool_calls = plan.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_test" });
    return res.end(JSON.stringify({ id, object: "chat.completion", created: 1700000000, model: `${model}-2026-01-01`, choices: [{ index: 0, message, finish_reason: plan.finish }], usage }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, finish = null, extra = {}) => ({ id, object: "chat.completion.chunk", created: 1700000000, model: `${model}-2026-01-01`, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  sse(res, null, chunk({ role: "assistant", content: "" }));
  if (plan.calls.length) {
    const [call] = plan.calls;
    sse(res, null, chunk({ tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }));
    for (const part of [call.arguments.slice(0, 5), call.arguments.slice(5)]) {
      sse(res, null, chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
    }
  } else {
    const words = model.endsWith("-big") ? Array.from({ length: BIG_CHUNKS }, () => BIG_CHUNK_TEXT) : plan.content.match(/\S+\s*/g);
    let sent = 0;
    for (const word of words) {
      sse(res, null, chunk({ content: word }));
      sent += 1;
      if (model.endsWith("-midfail") && sent === 2) {
        await pause(10);
        return res.destroy(); // the connection dies mid-stream
      }
      if (options.chunkDelayMs) await pause(options.chunkDelayMs);
      if (options.bytesPerSecond) await pause((word.length / options.bytesPerSecond) * 1000);
    }
  }
  sse(res, null, chunk({}, plan.finish));
  if (body.stream_options?.include_usage) sse(res, null, { id, object: "chat.completion.chunk", created: 1700000000, model: `${model}-2026-01-01`, choices: [], usage });
  sse(res, null, "[DONE]");
  res.end();
}

async function responses(body, res, options) {
  const model = String(body.model);
  const id = "resp_test123";
  const inputText = typeof body.input === "string" ? body.input : JSON.stringify(body.input);
  const calls = /weather/i.test(inputText) && !/function_call_output/.test(inputText);
  const output = calls
    ? [{ id: "fc_1", type: "function_call", call_id: "call_resp1", name: "get_weather", arguments: '{"city":"Paris"}', status: "completed" }]
    : [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `Echo: ${inputText.slice(0, 40)}`, annotations: [] }] }];
  const full = { id, object: "response", created_at: 1700000000, status: "completed", model: `${model}-2026-01-01`, output,
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } } };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(full));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  let seq = 0;
  const ev = (type, data) => sse(res, type, { type, sequence_number: seq++, ...data });
  ev("response.created", { response: { ...full, status: "in_progress", output: [], usage: null } });
  if (calls) {
    ev("response.output_item.added", { output_index: 0, item: { ...output[0], arguments: "", status: "in_progress" } });
    ev("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: output[0].arguments });
    ev("response.output_item.done", { output_index: 0, item: output[0] });
  } else {
    const text = output[0].content[0].text;
    ev("response.output_item.added", { output_index: 0, item: { ...output[0], status: "in_progress", content: [] } });
    ev("response.content_part.added", { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    for (const word of text.match(/\S+\s*/g)) ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: word });
    ev("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text });
    ev("response.content_part.done", { item_id: "msg_1", output_index: 0, content_index: 0, part: output[0].content[0] });
    ev("response.output_item.done", { output_index: 0, item: output[0] });
  }
  ev("response.completed", { response: full });
  res.end();
}

export async function startFakeOpenAI(options = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    requests.push({ url: req.url, method: req.method, headers: req.headers, raw, body });
    if (String(body.model).endsWith("-429")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      return res.end(JSON.stringify({ error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } }));
    }
    const path = (req.url ?? "").split("?")[0];
    try {
      if (path === "/v1/chat/completions") return await chat(body, res, options);
      if (path === "/v1/responses") return await responses(body, res, options);
    } catch { /* client went away */ }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route ${path}`, type: "invalid_request_error" } }));
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  server.unref(); // a failing test must end the run, not leave a listening server holding it open
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
