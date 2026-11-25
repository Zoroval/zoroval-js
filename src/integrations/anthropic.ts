/**
 * Anthropic capture: Messages `create`, `parse` and `stream()` of `@anthropic-ai/sdk`, streaming or not,
 * with tool_use ids, thinking, server tools (web search, web fetch, code execution, MCP) and citations.
 * Mirrors `integrations/anthropic.py`: the same span name, attribute keys, and message and parts shapes.
 *
 * Deviations from `anthropic.py`:
 * - `wrapAnthropic(client)` is explicit, like `wrapOpenAI`, and patches `messages.create` (and
 *   `beta.messages.create`) of that one client. `parse()` and `stream()` call `create` on the same object,
 *   so they need no patch of their own; the returned `APIPromise` and stream are the library's own.
 * - Server tool results are `tool_call_response` parts in the assistant message, with the id of their
 *   `server_tool_use` call, without the opaque `encrypted_*` fields and with inline base64 replaced; text
 *   parts keep `citations`.
 * - `gen_ai.usage.input_tokens` is the whole prompt: input plus cache reads plus cache writes (Anthropic's
 *   `input_tokens` counts only the uncached part); the cache counts are kept beside it.
 * - A `tool_result` given as a list of blocks is one string: the text blocks joined with a newline.
 */

import { toPlain } from "../json.js";
import { tracingOff } from "../state.js";
import type { AttrValue } from "../span.js";
import { internalError } from "../util.js";
import { Generation, get, given, hostOf, mediaPart, textPart, stripInlineMedia, wrapMethod } from "./common.js";
import type { CallMapper, Json, StreamState } from "./common.js";

const REQUEST_PARAMS: Record<string, string> = {
  temperature: "gen_ai.request.temperature",
  top_p: "gen_ai.request.top_p",
  top_k: "gen_ai.request.top_k",
  max_tokens: "gen_ai.request.max_tokens",
};

const args = (input: Json): string => (typeof input === "string" ? input : JSON.stringify(toPlain(input ?? {})));

/** The text of a `tool_result` content: a string as is, a list of blocks as one string. */
function resultText(content: Json): Json {
  if (!Array.isArray(content)) return toPlain(content);
  return content.map((b: Json) => (get(b, "type") === "text" ? String(get(b, "text") ?? "") : `[${get(b, "type")} omitted]`)).join("\n");
}

export function blockParts(content: Json): Json[] {
  if (!given(content)) return [];
  if (typeof content === "string") return [textPart(content)];
  const parts: Json[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    const kind = String(get(block, "type") ?? "");
    if (kind === "text") {
      const part = textPart(get(block, "text"));
      const citations = get(block, "citations");
      if (Array.isArray(citations) && citations.length) part.citations = stripInlineMedia(toPlain(citations));
      parts.push(part);
    } else if (kind === "tool_use" || kind.endsWith("_tool_use")) {
      // tool_use runs in the app; server_tool_use and mcp_tool_use run at Anthropic. All are tool calls.
      parts.push({ type: "tool_call", id: get(block, "id"), name: get(block, "name"), arguments: args(get(block, "input")) });
    } else if (kind === "tool_result" || kind.endsWith("_tool_result")) {
      const inner = get(block, "content");
      const server = kind !== "tool_result";
      const part: Json = { type: "tool_call_response", id: get(block, "tool_use_id"), response: server ? stripInlineMedia(toPlain(inner)) : resultText(inner) };
      if (get(block, "is_error") || (server && String(get(inner, "type") ?? "").endsWith("_error"))) part.is_error = true;
      parts.push(part);
    } else if (kind === "thinking") parts.push({ type: "reasoning", content: get(block, "thinking") });
    else if (kind === "redacted_thinking") parts.push({ type: "reasoning", content: "[redacted]" });
    else if (kind === "image" || kind === "document") parts.push(mediaPart(kind, get(get(block, "source"), "url")));
    else parts.push({ type: kind || "unknown" });
  }
  return parts;
}

export function inputMessages(messages: Json): Json[] {
  return (Array.isArray(messages) ? messages : []).map((m: Json) => ({ role: get(m, "role"), parts: blockParts(get(m, "content")) }));
}

/** The calls the app runs itself (`tool_use`); server tools are run by Anthropic and need no tool(). */
function toolCalls(content: Json): Json[] {
  return (Array.isArray(content) ? content : []).filter((b: Json) => get(b, "type") === "tool_use")
    .map((b: Json) => ({ id: get(b, "id"), name: get(b, "name"), arguments: args(get(b, "input")) }));
}

function usageOf(usage: Json): Record<string, unknown> {
  if (!given(usage)) return {};
  const read = Number(get(usage, "cache_read_input_tokens", 0)) || 0;
  const written = Number(get(usage, "cache_creation_input_tokens", 0)) || 0;
  const input = get(usage, "input_tokens");
  const out: Record<string, unknown> = { input_tokens: typeof input === "number" ? input + read + written : input, output_tokens: get(usage, "output_tokens") };
  if (read) out["cache_read.input_tokens"] = read;
  if (written) out["cache_creation.input_tokens"] = written;
  return out;
}

interface Endpoint {
  provider: string;
  host?: string;
  port?: number;
}

function start(endpoint: Endpoint, body: Json): Generation {
  const attrs: Record<string, AttrValue> = { "gen_ai.request.stream": Boolean(get(body, "stream", false)) };
  if (endpoint.host) attrs["server.address"] = endpoint.host;
  if (endpoint.port) attrs["server.port"] = endpoint.port;
  for (const [key, name] of Object.entries(REQUEST_PARAMS)) {
    const value = get(body, key);
    if (typeof value === "number") attrs[name] = value;
  }
  const stop = get(body, "stop_sequences");
  if (Array.isArray(stop) && stop.length) attrs["gen_ai.request.stop_sequences"] = stop.map(String);
  const gen = new Generation(endpoint.provider, get(body, "model"), attrs);
  if (gen.active) {
    const system = get(body, "system");
    if (system) gen.content("gen_ai.system_instructions", blockParts(system));
    gen.content("gen_ai.input.messages", inputMessages(get(body, "messages")));
    const tools = get(body, "tools");
    if (tools) gen.content("gen_ai.tool.definitions", toPlain(tools));
  }
  return gen;
}

function finish(gen: Generation, message: Json, error?: unknown): void {
  const content = get(message, "content");
  const reason = get(message, "stop_reason");
  gen.finish({
    responseId: get(message, "id"), model: get(message, "model"), finishReasons: [reason],
    outputMessages: [{ role: "assistant", parts: blockParts(content), finish_reason: reason }],
    toolCalls: toolCalls(content), usage: usageOf(get(message, "usage")), error,
  });
}

/** Rebuilds the message from the raw stream events. */
function stream(gen: Generation): StreamState {
  let id: Json = null, model: Json = null, stopReason: Json = null;
  const usage: Json = {};
  const blocks = new Map<number, Json>();
  const takeUsage = (u: Json) => {
    for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
      if (typeof get(u, key) === "number") usage[key] = get(u, key);
    }
  };
  return {
    observe(event) {
      const kind = get(event, "type");
      const index = get(event, "index", 0) || 0;
      if (kind === "message_start") {
        const message = get(event, "message");
        id = get(message, "id");
        model = get(message, "model");
        takeUsage(get(message, "usage"));
      } else if (kind === "content_block_start") {
        // Server tool results arrive whole here; tool inputs and text arrive as deltas.
        blocks.set(index, { ...(toPlain(get(event, "content_block")) as Json), json: "" });
      } else if (kind === "content_block_delta") {
        let slot = blocks.get(index);
        if (!slot) blocks.set(index, (slot = { type: "text", text: "", json: "" }));
        const delta = get(event, "delta");
        const type = get(delta, "type");
        if (type === "text_delta") slot.text = (slot.text ?? "") + (get(delta, "text") ?? "");
        else if (type === "input_json_delta") slot.json += get(delta, "partial_json") ?? "";
        else if (type === "thinking_delta") slot.thinking = (slot.thinking ?? "") + (get(delta, "thinking") ?? "");
        else if (type === "citations_delta") (slot.citations ??= []).push(toPlain(get(delta, "citation")));
      } else if (kind === "message_delta") {
        const reason = get(get(event, "delta"), "stop_reason");
        if (reason) stopReason = reason;
        takeUsage(get(event, "usage"));
      }
    },
    finish(error) {
      const content = [...blocks.keys()].sort((a, b) => a - b).map((at) => {
        const { json, ...block } = blocks.get(at)!;
        if (json) {
          try {
            block.input = JSON.parse(json);
          } catch {
            block.input = json; // cut off mid-way: the text that arrived
          }
        }
        return block;
      });
      finish(gen, { id, model, content, stop_reason: stopReason, usage }, error);
    },
  };
}

function providerName(client: Json): string {
  const name = String(client?.constructor?.name ?? "");
  return name.includes("Bedrock") ? "aws.bedrock" : name.includes("Vertex") ? "gcp.vertex_ai" : "anthropic";
}

/**
 * Trace the Messages calls of an Anthropic client (`create`, `parse`, `stream()`), streaming or not.
 * Returns the same client. Calling it twice on one client is safe.
 *
 *     const anthropic = zoroval.wrapAnthropic(new Anthropic());
 */
export function wrapAnthropic<T extends object>(client: T): T {
  if (tracingOff()) return client; // init() left tracing off: the client is not touched
  try {
    const c = client as Json;
    const mapper: CallMapper = {
      start: (body) => start({ provider: providerName(c), ...hostOf(c?.baseURL) }, body),
      finish: (gen, message) => finish(gen, message),
      stream,
    };
    wrapMethod(c?.messages, "create", mapper, "anthropic");
    wrapMethod(c?.beta?.messages, "create", mapper, "anthropic");
  } catch (error) {
    internalError("wrapAnthropic", error);
  }
  return client;
}
