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
 * - Responses `parse()` is wrapped; `gen_ai.provider.name` is `azure.ai.openai` for `AzureOpenAI`.
 * - `server.port` only when the base URL names one (the same as Python's `base_url.port`).
 */

import { currentConversationId, noteResponseChain } from "../context.js";
import { toPlain } from "../json.js";
import { getState, tracingOff } from "../state.js";
import type { AttrValue } from "../span.js";
import { internalError } from "../util.js";
import { Generation, get, given, mediaPart, safe, textPart, watchIterator } from "./common.js";
import type { Json } from "./common.js";

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

function contentParts(content: Json): Json[] {
  if (!given(content)) return [];
  if (typeof content === "string") return [textPart(content)];
  const parts: Json[] = [];
  for (const item of Array.isArray(content) ? content : []) {
    const kind = get(item, "type");
    if (kind === "text" || kind === "input_text" || kind === "output_text") parts.push(textPart(get(item, "text")));
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

export function chatInputMessages(messages: Json): Json[] {
  const out: Json[] = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = get(msg, "role");
    let parts: Json[];
    if (role === "tool" || role === "function") {
      parts = [{ type: "tool_call_response", id: get(msg, "tool_call_id"), response: get(msg, "content") }];
    } else {
      parts = contentParts(get(msg, "content"));
      for (const call of get(msg, "tool_calls", [])) {
        const fn = get(call, "function");
        parts.push({ type: "tool_call", id: get(call, "id"), name: get(fn, "name"), arguments: get(fn, "arguments") });
      }
    }
    const item: Json = { role, parts };
    if (get(msg, "name")) item.name = get(msg, "name");
    out.push(item);
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
    const parts = contentParts(get(message, "content"));
    if (get(message, "refusal")) parts.push({ type: "refusal", content: get(message, "refusal") });
    parts.push(...choiceCalls.map((c) => ({ type: "tool_call", ...c })));
    const reason = get(choice, "finish_reason");
    outputs.push({ role: "assistant", parts, finish_reason: reason });
    calls.push(...choiceCalls);
    reasons.push(reason);
  }
  gen.finish({
    responseId: get(result, "id"), model: get(result, "model"), finishReasons: reasons, outputMessages: outputs,
    toolCalls: calls, usage: chatUsage(get(result, "usage")),
  });
}

interface StreamState {
  observe(event: Json): void;
  finish(error?: unknown): void;
}

function chatStream(gen: Generation): StreamState {
  let id: Json = null, model: Json = null, usage: Json = null;
  const choices = new Map<number, { text: string[]; refusal: string[]; calls: Map<number, Json>; finish: Json }>();
  return {
    observe(chunk) {
      id = id || get(chunk, "id");
      model = model || get(chunk, "model");
      if (get(chunk, "usage")) usage = get(chunk, "usage");
      for (const choice of get(chunk, "choices", [])) {
        const index = get(choice, "index", 0) || 0;
        let slot = choices.get(index);
        if (!slot) choices.set(index, (slot = { text: [], refusal: [], calls: new Map(), finish: null }));
        const delta = get(choice, "delta");
        if (delta !== null) {
          if (get(delta, "content")) slot.text.push(get(delta, "content"));
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
        const parts: Json[] = slot.text.length ? [textPart(slot.text.join(""))] : [];
        if (slot.refusal.length) parts.push({ type: "refusal", content: slot.refusal.join("") });
        parts.push(...choiceCalls.map((c) => ({ type: "tool_call", ...c })));
        outputs.push({ role: "assistant", parts, finish_reason: slot.finish });
        calls.push(...choiceCalls);
        reasons.push(slot.finish);
      }
      gen.finish({ responseId: id, model, finishReasons: reasons, outputMessages: outputs, toolCalls: calls, usage: chatUsage(usage), error });
    },
  };
}

// ---------------------------------------------------------------------------- Responses

export function responsesInputMessages(value: Json): Json[] {
  if (!given(value)) return [];
  if (typeof value === "string") return [{ role: "user", parts: [textPart(value)] }];
  const out: Json[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const kind = get(item, "type");
    if (kind === "function_call") {
      out.push({ role: "assistant", parts: [{ type: "tool_call", id: get(item, "call_id"), name: get(item, "name"), arguments: get(item, "arguments") }] });
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      out.push({ role: "tool", parts: [{ type: "tool_call_response", id: get(item, "call_id"), response: toPlain(get(item, "output")) }] });
    } else if (kind === "custom_tool_call") {
      out.push({ role: "assistant", parts: [{ type: "tool_call", id: get(item, "call_id"), name: get(item, "name"), arguments: get(item, "input") }] });
    } else if (kind === null || kind === "message" || get(item, "role")) {
      out.push({ role: get(item, "role", "user"), parts: contentParts(get(item, "content")) });
    } else if (kind !== "reasoning") {
      out.push({ role: "unknown", parts: [{ type: String(kind) }] });
    }
  }
  return out;
}

function responsesOutput(response: Json): [Json[], Json[]] {
  const parts: Json[] = [], calls: Json[] = [];
  for (const item of get(response, "output", [])) {
    const kind = get(item, "type");
    if (kind === "message") parts.push(...contentParts(get(item, "content")));
    else if (kind === "function_call" || kind === "custom_tool_call") {
      const call = { id: get(item, "call_id"), name: get(item, "name"), arguments: get(item, kind === "function_call" ? "arguments" : "input") };
      calls.push(call);
      parts.push({ type: "tool_call", ...call });
    } else if (kind === "reasoning") {
      const summary = get(item, "summary", []).map((s: Json) => get(s, "text") || "").join(" ");
      if (summary) parts.push({ type: "reasoning", content: summary });
    } else if (kind) parts.push({ type: String(kind) });
  }
  return [parts, calls];
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

function responsesFinish(gen: Generation, response: Json, error?: unknown): void {
  const [parts, calls] = responsesOutput(response);
  const status = get(response, "status");
  const reason = get(get(response, "incomplete_details"), "reason") || status;
  const outputs = parts.length || reason ? [{ role: "assistant", parts, finish_reason: reason }] : [];
  if (status === "failed" && !given(error)) {
    const err = get(response, "error");
    gen.set("error.type", String(get(err, "code") || "response_failed"));
    gen.setError(String(get(err, "message") || "response failed"));
  }
  gen.finish({
    responseId: get(response, "id"), model: get(response, "model"), finishReasons: reason ? [reason] : [],
    outputMessages: outputs, toolCalls: calls, usage: responsesUsage(get(response, "usage")), error,
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
      let parts: Json[] = [], calls: Json[] = [];
      if (items.length) [parts, calls] = responsesOutput({ output: items });
      else if (text.length) parts = [textPart(text.join(""))];
      if (failure !== null && !given(error)) gen.setError(String(get(failure, "message") || "stream error"));
      gen.finish({
        responseId: id, model, finishReasons: ["incomplete"],
        outputMessages: [{ role: "assistant", parts, finish_reason: "incomplete" }], toolCalls: calls, error,
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

const WRAPPED = Symbol.for("zoroval.wrapped");
type Fn = (this: unknown, ...args: unknown[]) => unknown;

function providerName(client: Json): string {
  return String(client?.constructor?.name ?? "").includes("Azure") ? "azure.ai.openai" : "openai";
}

function endpointOf(api: Api, client: Json): Endpoint {
  const endpoint: Endpoint = { api, provider: providerName(client) };
  try {
    const base = new URL(String(client?.baseURL));
    endpoint.host = base.hostname;
    if (base.port) endpoint.port = Number(base.port);
  } catch {
    /* no usable base URL */
  }
  return endpoint;
}

const isStream = (value: Json): boolean =>
  value !== null && typeof value === "object" && !("choices" in value) && !("output" in value) &&
  (typeof value[Symbol.asyncIterator] === "function" || typeof value.iterator === "function");

/** Watch the events of the provider's stream object in place; the app keeps reading the same object. */
function watchStream(stream: Json, gen: Generation, state: StreamState): void {
  const watch = (make: () => Json) => () => watchIterator(make(), gen, state.observe, state.finish);
  // openai's Stream keeps its generator in `iterator`; `tee()` calls it directly, `for await` goes
  // through Symbol.asyncIterator, which calls it too.
  if (typeof stream.iterator === "function") {
    const original = stream.iterator;
    stream.iterator = watch(() => original.call(stream));
  } else {
    const original = stream[Symbol.asyncIterator];
    stream[Symbol.asyncIterator] = watch(() => original.call(stream));
  }
}

/**
 * Attach the span to the provider's returned promise without changing it. The openai `APIPromise`
 * reads the body only through `parse()`, so that is where the parsed value is seen; `asResponse()`
 * (raw body for the app) ends the span without content. The library's helpers derive new promises
 * with `_thenUnwrap()`: those are hooked the same way. Any other promise is observed with `then`.
 */
function observeCall(call: Json, gen: Generation, api: Api): void {
  let seen = false;
  const onValue = (value: Json) => {
    if (seen) return;
    seen = true;
    try {
      if (value === null) gen.finish(); // raw response: the app reads the bytes itself
      else if (isStream(value)) watchStream(value, gen, streamState(gen, api));
      else finishResult(gen, api, value);
    } catch (error) {
      internalError("openai.finish", error);
      gen.finish();
    }
  };
  const onError = (error: unknown) => {
    if (seen) return;
    seen = true;
    gen.fail(error);
  };
  const hook = (promise: Json): void => {
    const { parse, asResponse, _thenUnwrap } = promise;
    let requested = false;
    promise.parse = function (this: unknown, ...args: unknown[]) {
      const result = parse.apply(this, args);
      if (!requested) {
        requested = true;
        (result as Promise<unknown>).then(onValue, onError);
      }
      return result;
    };
    promise.asResponse = function (this: unknown, ...args: unknown[]) {
      const result = asResponse.apply(this, args);
      if (!requested) {
        requested = true;
        (result as Promise<unknown>).then(() => onValue(null), onError);
      }
      return result;
    };
    if (typeof _thenUnwrap === "function") {
      promise._thenUnwrap = function (this: unknown, ...args: unknown[]) {
        const derived = _thenUnwrap.apply(this, args);
        if (derived && typeof derived.parse === "function") hook(derived);
        return derived;
      };
    }
  };
  if (call && typeof call.parse === "function" && typeof call.asResponse === "function") hook(call);
  else if (call && typeof call.then === "function") call.then(onValue, onError);
}

function wrapMethod(owner: Json, method: string, api: Api, client: Json): void {
  const original = owner?.[method] as Fn | undefined;
  if (typeof original !== "function" || (original as Json)[WRAPPED]) return;
  const wrapper: Fn = function (this: unknown, ...args) {
    if (!getState()) return original.apply(this, args);
    let gen: Generation | undefined;
    try {
      gen = startCall(endpointOf(api, client), args[0]);
    } catch (error) {
      internalError("openai.start", error);
    }
    if (!gen || !gen.active) return original.apply(this, args);
    let call: unknown;
    try {
      call = gen.run(() => original.apply(this, args));
    } catch (error) {
      gen.fail(error);
      throw error;
    }
    safe("openai.observe", () => observeCall(call, gen!, api));
    return call;
  };
  (wrapper as Json)[WRAPPED] = true;
  owner[method] = wrapper;
}

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
      wrapMethod(c?.chat?.completions, method, "chat", c);
      wrapMethod(c?.responses, method, "responses", c);
    }
  } catch (error) {
    internalError("wrapOpenAI", error);
  }
  return client;
}
