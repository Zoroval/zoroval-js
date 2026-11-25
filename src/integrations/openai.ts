/**
 * OpenAI capture: Chat Completions and Responses, streaming and not, tool-call ids. Mirrors
 * `integrations/openai.py`: the same span name, attribute keys, and message and parts shapes. The
 * request and response mappers work on plain JSON, so `wrapFetch` (fetch.ts) reuses them for raw HTTP.
 *
 * Deviations from `openai.py`:
 * - `wrapOpenAI(client)` is explicit and patches the resource objects of that one client in place
 *   (`client.chat.completions.create`/`parse`, `client.responses.create`/`parse`); Python patches the
 *   library's classes on `init()`. `stream()` helpers and `runTools` need no patch: they call `create`.
 * - The wrap is installed even when the SDK is off at that moment, and each call checks the SDK state:
 *   `init()` may run after a module-level `wrapOpenAI()` (ES module order), and a no-key call then
 *   goes straight to the original method. With no key the client's behaviour is unchanged.
 * - `create()` returns the library's `APIPromise`, which has `withResponse()` and `asResponse()`. It
 *   is returned as is: its `parse()` is hooked (everything that reads the body goes through it) and
 *   `asResponse()` ends the span without content, like Python's raw-response branch.
 * - No `_client_request_wrapped` check (OpenInference is not a JavaScript thing here).
 * - Responses `parse()` is wrapped; `gen_ai.provider.name` is `azure.ai.openai` for `AzureOpenAI`, and for other
 *   clients comes from the base URL host (Groq, DeepSeek, OpenRouter, ...; `openai` for any host not listed).
 * - `server.port` only when the base URL names one (the same as Python's `base_url.port`).
 */

import { currentConversationId, noteResponseChain } from "../context.js";
import { toPlain } from "../json.js";
import { getState, tracingOff } from "../state.js";
import type { AttrValue } from "../span.js";
import { internalError } from "../util.js";
import { Generation, get, given, hostOf, mediaPart, textPart, wrapMethod } from "./common.js";
import type { CallMapper, Json, StreamState } from "./common.js";

const REQUEST_PARAMS: Record<string, string> = {
  temperature: "gen_ai.request.temperature",
  top_p: "gen_ai.request.top_p",
  max_tokens: "gen_ai.request.max_tokens",
  max_completion_tokens: "gen_ai.request.max_tokens",
  max_output_tokens: "gen_ai.request.max_tokens",
  frequency_penalty: "gen_ai.request.frequency_penalty",
  presence_penalty: "gen_ai.request.presence_penalty",
  seed: "gen_ai.request.seed",
  n: "gen_ai.request.choice.count",
};

export type Api = "chat" | "responses";

export interface Endpoint {
  api: Api;
  provider: string;
  host?: string;
  port?: number;
}

function requestAttributes(endpoint: Endpoint, body: Json): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = { "gen_ai.request.stream": Boolean(get(body, "stream", false)) };
  if (endpoint.host) attrs["server.address"] = endpoint.host;
  if (endpoint.port) attrs["server.port"] = endpoint.port;
  for (const [key, name] of Object.entries(REQUEST_PARAMS)) {
    const value = get(body, key);
    if (typeof value === "number") attrs[name] = value;
  }
  const stop = get(body, "stop");
  if (stop && stop.length !== 0) attrs["gen_ai.request.stop_sequences"] = typeof stop === "string" ? [stop] : [...stop].map(String);
  return attrs;
}

/** A text part, with the provider's annotations (url_citation, file_citation, ...) when it sent any. */
function noted(text: unknown, notes: Json): Json {
  const part = textPart(text);
  if (Array.isArray(notes) && notes.length) part.annotations = toPlain(notes);
  return part;
}

function contentParts(content: Json): Json[] {
  if (!given(content)) return [];
  if (typeof content === "string") return [textPart(content)];
  const parts: Json[] = [];
  for (const item of Array.isArray(content) ? content : []) {
    const kind = get(item, "type");
    if (kind === "text" || kind === "input_text" || kind === "output_text") parts.push(noted(get(item, "text"), get(item, "annotations")));
    else if (kind === "refusal") parts.push({ type: "refusal", content: get(item, "refusal") });
    else if (kind === "image_url" || kind === "input_image") {
      const image = get(item, "image_url");
      parts.push(mediaPart("image", typeof image === "string" ? image : get(image, "url")));
    } else if (kind === "input_audio" || kind === "audio") parts.push(mediaPart("audio"));
    else if (kind === "file" || kind === "input_file") parts.push(mediaPart("file"));
    else parts.push({ type: String(kind || "unknown") });
  }
  return parts;
}

// ---------------------------------------------------------------------------- Chat Completions

/** Reasoning text of OpenAI-compatible providers: DeepSeek `reasoning_content`, OpenRouter `reasoning` or `reasoning_details`. */
function reasoningText(source: Json): string {
  for (const key of ["reasoning_content", "reasoning"]) {
    const value = get(source, key);
    if (typeof value === "string" && value) return value;
  }
  const details = get(source, "reasoning_details");
  return Array.isArray(details) ? details.map((d: Json) => get(d, "text") || get(d, "summary") || "").filter((t: unknown) => typeof t === "string").join("") : "";
}

/** The content parts of one chat message, with its annotations on the first text part. */
function chatParts(msg: Json): Json[] {
  const parts = contentParts(get(msg, "content"));
  const notes = get(msg, "annotations");
  const first = parts.find((p) => p.type === "text");
  if (first && Array.isArray(notes) && notes.length && !first.annotations) first.annotations = toPlain(notes);
  return parts;
}

/**
 * An assistant message, with its reasoning as a message of its own before it (as a Responses reasoning item
 * is). DeepSeek refuses `reasoning_content` in the history, so the reply sent back is the text message alone,
 * and it still matches what was recorded.
 */
function withReasoning(msg: Json, message: Json): Json[] {
  const reasoning = reasoningText(msg);
  return reasoning ? [{ role: "assistant", parts: [{ type: "reasoning", content: reasoning }] }, message] : [message];
}

export function chatInputMessages(messages: Json): Json[] {
  const out: Json[] = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = get(msg, "role");
    let parts: Json[];
    if (role === "tool" || role === "function") {
      parts = [{ type: "tool_call_response", id: get(msg, "tool_call_id"), response: get(msg, "content") }];
    } else {
      parts = chatParts(msg);
      for (const call of get(msg, "tool_calls", [])) {
        const fn = get(call, "function");
        parts.push({ type: "tool_call", id: get(call, "id"), name: get(fn, "name"), arguments: get(fn, "arguments") });
      }
    }
    const item: Json = { role, parts };
    if (get(msg, "name")) item.name = get(msg, "name");
    out.push(...(role === "assistant" ? withReasoning(msg, item) : [item]));
  }
  return out;
}

function chatToolCalls(message: Json): Json[] {
  return get(message, "tool_calls", []).map((call: Json) => {
    const fn = get(call, "function");
    return { id: get(call, "id"), name: get(fn, "name") || get(call, "name"), arguments: get(fn, "arguments") };
  });
}

function usageOf(usage: Json, input: string, output: string, inputDetails: string, outputDetails: string): Record<string, unknown> {
  if (!given(usage)) return {};
  const out: Record<string, unknown> = { input_tokens: get(usage, input), output_tokens: get(usage, output) };
  const cached = get(get(usage, inputDetails), "cached_tokens");
  if (cached) out["cache_read.input_tokens"] = cached;
  const reasoning = get(get(usage, outputDetails), "reasoning_tokens");
  if (reasoning) out["reasoning.output_tokens"] = reasoning;
  return out;
}

const chatUsage = (usage: Json) => usageOf(usage, "prompt_tokens", "completion_tokens", "prompt_tokens_details", "completion_tokens_details");
const responsesUsage = (usage: Json) => usageOf(usage, "input_tokens", "output_tokens", "input_tokens_details", "output_tokens_details");

function chatStart(endpoint: Endpoint, body: Json): Generation {
  const gen = new Generation(endpoint.provider, get(body, "model"), requestAttributes(endpoint, body));
  if (gen.active) {
    gen.content("gen_ai.input.messages", chatInputMessages(get(body, "messages")));
    const tools = get(body, "tools");
    if (tools) gen.content("gen_ai.tool.definitions", toPlain(tools));
  }
  return gen;
}

function chatFinish(gen: Generation, result: Json): void {
  const outputs: Json[] = [], calls: Json[] = [], reasons: unknown[] = [];
  for (const choice of get(result, "choices", [])) {
    const message = get(choice, "message");
    const choiceCalls = chatToolCalls(message);
    const parts = chatParts(message);
    if (get(message, "refusal")) parts.push({ type: "refusal", content: get(message, "refusal") });
    parts.push(...choiceCalls.map((c) => ({ type: "tool_call", ...c })));
    const reason = get(choice, "finish_reason");
    outputs.push(...withReasoning(message, { role: "assistant", parts, finish_reason: reason }));
    calls.push(...choiceCalls);
    reasons.push(reason);
  }
  gen.finish({
    responseId: get(result, "id"), model: get(result, "model"), finishReasons: reasons, outputMessages: outputs,
    toolCalls: calls, usage: chatUsage(get(result, "usage")),
  });
}

interface ChatSlot {
  text: string[];
  reasoning: string[];
  details: string[];
  notes: Json[];
  refusal: string[];
  calls: Map<number, Json>;
  finish: Json;
}

function chatStream(gen: Generation): StreamState {
  let id: Json = null, model: Json = null, usage: Json = null;
  const choices = new Map<number, ChatSlot>();
  return {
    observe(chunk) {
      id = id || get(chunk, "id");
      model = model || get(chunk, "model");
      // Groq sends the usage of a stream in `x_groq.usage` on the last chunk.
      const seen = get(chunk, "usage") || get(get(chunk, "x_groq"), "usage");
      if (seen) usage = seen;
      for (const choice of get(chunk, "choices", [])) {
        const index = get(choice, "index", 0) || 0;
        let slot = choices.get(index);
        if (!slot) choices.set(index, (slot = { text: [], reasoning: [], details: [], notes: [], refusal: [], calls: new Map(), finish: null }));
        const delta = get(choice, "delta");
        if (delta !== null) {
          if (get(delta, "content")) slot.text.push(get(delta, "content"));
          for (const key of ["reasoning_content", "reasoning"]) if (typeof get(delta, key) === "string") slot.reasoning.push(get(delta, key));
          const details = get(delta, "reasoning_details");
          if (Array.isArray(details)) slot.details.push(reasoningText({ reasoning_details: details }));
          const notes = get(delta, "annotations");
          if (Array.isArray(notes)) slot.notes.push(...notes);
          if (get(delta, "refusal")) slot.refusal.push(get(delta, "refusal"));
          for (const call of get(delta, "tool_calls", [])) {
            const at = get(call, "index", 0) || 0;
            let entry = slot.calls.get(at);
            if (!entry) slot.calls.set(at, (entry = { id: null, name: null, arguments: "" }));
            if (get(call, "id")) entry.id = get(call, "id");
            const fn = get(call, "function");
            if (get(fn, "name")) entry.name = get(fn, "name");
            if (get(fn, "arguments")) entry.arguments += get(fn, "arguments");
          }
        }
        if (get(choice, "finish_reason")) slot.finish = get(choice, "finish_reason");
      }
    },
    finish(error) {
      const outputs: Json[] = [], calls: Json[] = [], reasons: unknown[] = [];
      for (const index of [...choices.keys()].sort((a, b) => a - b)) {
        const slot = choices.get(index)!;
        const choiceCalls = [...slot.calls.keys()].sort((a, b) => a - b).map((i) => slot.calls.get(i));
        const parts = chatParts({ content: slot.text.length ? slot.text.join("") : null, annotations: slot.notes });
        if (slot.refusal.length) parts.push({ type: "refusal", content: slot.refusal.join("") });
        parts.push(...choiceCalls.map((c) => ({ type: "tool_call", ...c })));
        outputs.push(...withReasoning({ reasoning: slot.reasoning.join("") || slot.details.join("") }, { role: "assistant", parts, finish_reason: slot.finish }));
        calls.push(...choiceCalls);
        reasons.push(slot.finish);
      }
      gen.finish({ responseId: id, model, finishReasons: reasons, outputMessages: outputs, toolCalls: calls, usage: chatUsage(usage), error });
    },
  };
}

// ---------------------------------------------------------------------------- Responses

/**
 * OpenAI's built-in tools (web search, file search, code interpreter, MCP, ...) run inside OpenAI: one item
 * per call, holding the query or code and, when OpenAI returns it, the result. The call and its result are
 * one assistant message: a `tool_call` and a `tool_call_response` with the same id.
 */
const BUILTIN_ARGS: Record<string, string> = {
  web_search_call: "action", file_search_call: "queries", code_interpreter_call: "code", computer_call: "action",
  local_shell_call: "action", mcp_call: "arguments", image_generation_call: "",
};
const BUILTIN_RESULT: Record<string, string> = {
  file_search_call: "results", code_interpreter_call: "outputs", mcp_call: "output", image_generation_call: "result",
};
const asText = (value: Json): string => (typeof value === "string" ? value : JSON.stringify(toPlain(value)));

function builtinParts(kind: unknown, item: Json): Json[] | null {
  if (typeof kind !== "string" || !kind.endsWith("_call") || kind === "function_call" || kind === "custom_tool_call") return null;
  const name = kind === "mcp_call" ? String(get(item, "name") || "mcp") : kind.slice(0, -"_call".length);
  const id = get(item, "call_id") || get(item, "id");
  const field = BUILTIN_ARGS[kind] ?? "action";
  let raw = field ? get(item, field) : null;
  let result: Json = null;
  let failed = false;
  if (kind === "web_search_call" && given(raw)) {
    // The query is the argument; the sources OpenAI read are the result.
    const { sources, ...action }: Json = toPlain(raw) ?? {};
    result = Array.isArray(sources) && sources.length ? sources : null;
    raw = given(action.query) || given(action.queries)
      ? Object.fromEntries(["query", "queries"].filter((k) => given(action[k])).map((k) => [k, action[k]]))
      : action;
  } else if (kind === "mcp_call" && given(get(item, "error"))) {
    result = toPlain(get(item, "error"));
    failed = true;
  } else if (BUILTIN_RESULT[kind]) {
    result = get(item, BUILTIN_RESULT[kind]!);
    if (kind === "image_generation_call" && given(result)) result = "[image omitted]";
    else if (kind === "code_interpreter_call" && Array.isArray(result)) {
      result = result.map((o: Json) => (get(o, "type") === "image" ? "[image omitted]" : toPlain(o)));
    } else if (given(result)) result = toPlain(result);
  }
  const parts: Json[] = [{ type: "tool_call", id, name, arguments: given(raw) ? asText(raw) : "{}" }];
  if (given(result) && !(Array.isArray(result) && !result.length)) {
    const response: Json = { type: "tool_call_response", id, response: result };
    if (failed) response.is_error = true;
    parts.push(response);
  }
  return parts;
}

/** The messages for one Responses item, the same whether OpenAI returned it or the app sends it back as history. */
function itemMessages(item: Json): Json[] {
  const kind = get(item, "type");
  if (kind === "function_call" || kind === "custom_tool_call") {
    const args = get(item, kind === "function_call" ? "arguments" : "input");
    return [{ role: "assistant", parts: [{ type: "tool_call", id: get(item, "call_id"), name: get(item, "name"), arguments: args }] }];
  }
  if (typeof kind === "string" && kind.endsWith("_call_output")) {
    const output = kind === "computer_call_output" ? "[image omitted]" : toPlain(get(item, "output")); // a screenshot
    return [{ role: "tool", parts: [{ type: "tool_call_response", id: get(item, "call_id"), response: output }] }];
  }
  if (kind === "reasoning") {
    const summary = get(item, "summary", []).map((s: Json) => get(s, "text") || "").join(" ");
    return summary ? [{ role: "assistant", parts: [{ type: "reasoning", content: summary }] }] : [];
  }
  if (kind === null || kind === "message" || get(item, "role")) return [{ role: get(item, "role", "user"), parts: contentParts(get(item, "content")) }];
  const builtin = builtinParts(kind, item);
  return [{ role: "assistant", parts: builtin ?? [{ type: String(kind) }] }];
}

export function responsesInputMessages(value: Json): Json[] {
  if (!given(value)) return [];
  if (typeof value === "string") return [{ role: "user", parts: [textPart(value)] }];
  return (Array.isArray(value) ? value : []).flatMap(itemMessages);
}

/** One assistant message per output item, and the tool calls among them. */
function responsesOutput(response: Json): [Json[], Json[]] {
  const messages: Json[] = (get(response, "output", []) as Json[]).flatMap(itemMessages);
  const calls: Json[] = [];
  for (const message of messages) {
    for (const part of message.parts) if (part.type === "tool_call") calls.push({ id: part.id, name: part.name, arguments: part.arguments });
  }
  return [messages, calls];
}

function responsesStart(endpoint: Endpoint, body: Json): Generation {
  const attrs = requestAttributes(endpoint, body);
  const previous = get(body, "previous_response_id");
  if (previous) {
    attrs["gen_ai.openai.previous_response_id"] = String(previous);
    noteResponseChain();
  }
  const conv = get(body, "conversation");
  const convId = typeof conv === "string" ? conv : get(conv, "id");
  if (convId && currentConversationId() === null) attrs["gen_ai.conversation.id"] = String(convId); // OpenAI Conversations API id: an inherited id
  const gen = new Generation(endpoint.provider, get(body, "model"), attrs);
  if (gen.active) {
    const instructions = get(body, "instructions");
    if (instructions) gen.content("gen_ai.system_instructions", [textPart(instructions)]);
    gen.content("gen_ai.input.messages", responsesInputMessages(get(body, "input")));
    const tools = get(body, "tools");
    if (tools) gen.content("gen_ai.tool.definitions", toPlain(tools));
  }
  return gen;
}

/** The finish reason goes on the last message (an empty assistant message when there is none). */
function withReason(messages: Json[], reason: Json): Json[] {
  if (!reason) return messages;
  if (!messages.length) return [{ role: "assistant", parts: [], finish_reason: reason }];
  return [...messages.slice(0, -1), { ...messages[messages.length - 1], finish_reason: reason }];
}

function responsesFinish(gen: Generation, response: Json, error?: unknown): void {
  const [messages, calls] = responsesOutput(response);
  const status = get(response, "status");
  const reason = get(get(response, "incomplete_details"), "reason") || status;
  if (status === "failed" && !given(error)) {
    const err = get(response, "error");
    gen.set("error.type", String(get(err, "code") || "response_failed"));
    gen.setError(String(get(err, "message") || "response failed"));
  }
  gen.finish({
    responseId: get(response, "id"), model: get(response, "model"), finishReasons: reason ? [reason] : [],
    outputMessages: withReason(messages, reason), toolCalls: calls, usage: responsesUsage(get(response, "usage")), error,
  });
}

function responsesStream(gen: Generation): StreamState {
  let response: Json = null, id: Json = null, model: Json = null, failure: Json = null;
  const text: string[] = [], items: Json[] = [];
  return {
    observe(event) {
      const kind = get(event, "type");
      if (kind === "response.created" || kind === "response.in_progress") {
        const r = get(event, "response");
        id = id || get(r, "id");
        model = model || get(r, "model");
      } else if (kind === "response.output_text.delta") text.push(get(event, "delta") || "");
      else if (kind === "response.output_item.done") items.push(get(event, "item"));
      else if (kind === "response.completed" || kind === "response.incomplete" || kind === "response.failed") response = get(event, "response");
      else if (kind === "error") failure = event;
    },
    finish(error) {
      if (response !== null) return responsesFinish(gen, response, error);
      let messages: Json[] = [], calls: Json[] = [];
      if (items.length) [messages, calls] = responsesOutput({ output: items });
      else if (text.length) messages = [{ role: "assistant", parts: [textPart(text.join(""))] }];
      if (failure !== null && !given(error)) gen.setError(String(get(failure, "message") || "stream error"));
      gen.finish({
        responseId: id, model, finishReasons: ["incomplete"], outputMessages: withReason(messages, "incomplete"), toolCalls: calls, error,
      });
    },
  };
}

// ---------------------------------------------------------------------------- shared entry points

/** Open the span for one request body. Returns the generation (check `.active`). */
export function startCall(endpoint: Endpoint, body: Json): Generation {
  return endpoint.api === "chat" ? chatStart(endpoint, body) : responsesStart(endpoint, body);
}

/** Finish a span from a complete (non-streamed) response object. */
export function finishResult(gen: Generation, api: Api, result: Json): void {
  if (api === "chat") chatFinish(gen, result);
  else responsesFinish(gen, result);
}

/** Observer for the events of a streamed response. */
export function streamState(gen: Generation, api: Api): StreamState {
  return api === "chat" ? chatStream(gen) : responsesStream(gen);
}

// ---------------------------------------------------------------------------- wrapOpenAI

/** OpenAI-compatible hosts, named as GenAI semconv names the provider. Any other host stays `openai`. */
const HOSTS: [RegExp, string][] = [
  [/azure/, "azure.ai.openai"], [/(^|\.)groq\.com$/, "groq"], [/(^|\.)deepseek\.com$/, "deepseek"], [/(^|\.)openrouter\.ai$/, "openrouter"],
  [/(^|\.)anthropic\.com$/, "anthropic"], [/(^|\.)mistral\.ai$/, "mistral_ai"], [/(^|\.)x\.ai$/, "x_ai"],
  [/^generativelanguage\.googleapis\.com$/, "gcp.gemini"], [/(^|\.)perplexity\.ai$/, "perplexity"], [/(^|\.)cohere\.(ai|com)$/, "cohere"],
];

export function providerOfHost(host: string | undefined): string {
  const name = (host ?? "").toLowerCase();
  return HOSTS.find(([pattern]) => pattern.test(name))?.[1] ?? "openai";
}

function endpointOf(api: Api, client: Json): Endpoint {
  const at = hostOf(client?.baseURL);
  const azure = String(client?.constructor?.name ?? "").includes("Azure");
  return { api, provider: azure ? "azure.ai.openai" : providerOfHost(at.host), ...at };
}

const mapper = (api: Api, client: Json): CallMapper => ({
  start: (body) => startCall(endpointOf(api, client), body),
  finish: (gen, result) => finishResult(gen, api, result),
  stream: (gen) => streamState(gen, api),
});

/**
 * Trace the chat completions and responses calls of an OpenAI client, streaming or not. Returns the
 * same client. Calling it twice on one client is safe.
 *
 *     const openai = zoroval.wrapOpenAI(new OpenAI());
 */
export function wrapOpenAI<T extends object>(client: T): T {
  if (tracingOff()) return client; // init() left tracing off: the client is not touched
  try {
    const c = client as Json;
    for (const method of ["create", "parse"]) {
      wrapMethod(c?.chat?.completions, method, mapper("chat", c), "openai");
      wrapMethod(c?.responses, method, mapper("responses", c), "openai");
    }
  } catch (error) {
    internalError("wrapOpenAI", error);
  }
  return client;
}
