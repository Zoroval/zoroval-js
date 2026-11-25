// A local fake Anthropic Messages API for tests: the documented JSON and SSE shapes, with tool_use, thinking,
// server tools (web search, web fetch) with their results, citations, cache usage and errors. No real call.
//
// The model name picks the reply: "...-tools" (a tool_use), "...-server" (server web search and web fetch
// with citations), "...-429" (rate limit); anything else answers with text. A streamed request gets the
// same message as SSE events, with thinking first when the request turns thinking on.
import { createServer } from "node:http";

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };

export const SEARCH_RESULT = { type: "web_search_result", url: "https://louvre.fr/hours", title: "Hours", encrypted_content: "EqgfCioIAhgB", page_age: "2 days ago" };
export const CITATION = { type: "web_search_result_location", url: "https://louvre.fr/hours", title: "Hours", cited_text: "Open 9 to 6", encrypted_index: "Eo8BCioI" };

function reply(body) {
  const model = String(body.model);
  const content = [];
  let stop = "end_turn";
  if (body.thinking?.type === "enabled") content.push({ type: "thinking", thinking: "The user wants the hours.", signature: "sig" });
  if (model.endsWith("-tools")) {
    content.push({ type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } });
    stop = "tool_use";
  } else if (model.endsWith("-server")) {
    content.push(
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Louvre hours" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [SEARCH_RESULT] },
      { type: "server_tool_use", id: "srvtoolu_2", name: "web_fetch", input: { url: "https://louvre.fr/closed" } },
      { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_fetch_tool_error", error_code: "url_not_accessible" } },
      { type: "text", text: "It opens at 9.", citations: [CITATION] },
    );
  } else {
    content.push({ type: "text", text: "Hello there." });
  }
  return { id: "msg_test1", type: "message", role: "assistant", model: `${model}-20261101`, content, stop_reason: stop, stop_sequence: null, usage };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

function streamed(res, message) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, "message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      sse(res, "content_block_start", { index, content_block: { type: "text", text: "", ...(block.citations ? { citations: null } : {}) } });
      for (const citation of block.citations ?? []) sse(res, "content_block_delta", { index, delta: { type: "citations_delta", citation } });
      for (const piece of block.text.match(/.{1,5}/g)) sse(res, "content_block_delta", { index, delta: { type: "text_delta", text: piece } });
    } else if (block.type === "thinking") {
      sse(res, "content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      sse(res, "content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
      sse(res, "content_block_delta", { index, delta: { type: "signature_delta", signature: "sig" } });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      sse(res, "content_block_start", { index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      sse(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(0, 6) } });
      sse(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(6) } });
    } else {
      sse(res, "content_block_start", { index, content_block: block });
    }
    sse(res, "content_block_stop", { index });
  });
  sse(res, "message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  sse(res, "message_stop", {});
  res.end();
}

export async function startFakeAnthropic() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, body });
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404);
      return res.end();
    }
    if (String(body.model).endsWith("-429")) {
      res.writeHead(429, { "content-type": "application/json", "x-should-retry": "false" });
      return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your rate limit." } }));
    }
    const message = reply(body);
    if (body.stream) return streamed(res, message);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(message));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}
