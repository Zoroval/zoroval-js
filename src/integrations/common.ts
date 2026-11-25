/**
 * Shared pieces of the provider wrappers: the generation span, stream watching, small helpers.
 * Mirrors `integrations/_common.py`. Rules every wrapper follows:
 * - Never throw into the app. Our code runs inside `safe()`; the provider's own errors pass through
 *   unchanged.
 * - No duplicate spans. If a generation span is already open (`wrapOpenAI` plus `wrapFetch`, or
 *   `parse()` calling `create()`), no second one is made.
 *
 * Deviations from `_common.py`:
 * - No other instrumentation to detect (Langfuse, OpenInference, contrib instrumentors): the only
 *   open generation that can exist here is our own, so "foreign span" becomes "own open span".
 * - The span is the SDK's own `Span`, opened with `startGeneration()` (context.ts); there is no
 *   `attach()`/`detach()`, the provider call runs inside `gen.run()`.
 * - Streams are not wrapped in a proxy class. The stream object the app gets back is the provider's
 *   own, with its iterator watched in place (`watchIterator`), so `instanceof`, `controller`,
 *   `tee()` and `toReadableStream()` keep working. Python's `__del__` has no JavaScript equivalent:
 *   a stream nobody reads ends its span only when `startGeneration()`'s open-work timer lets go.
 * - An app-initiated abort (`AbortError`, `APIUserAbortError`) ends the span without ERROR status.
 * - Counts that Python reads as `int` (`temperature: 1.0`) are integers here: JavaScript has no
 *   float/int distinction, so a whole-number double is sent as an integer.
 */

import {
  REDACTED, addTruncated, contentAllowed, recordError, registerToolCalls, setContent, startGeneration,
} from "../context.js";
import type { GenerationHandle } from "../context.js";
import { applyRedact, dumps, fit } from "../json.js";
import { nowMs } from "../runtime.js";
import { getState } from "../state.js";
import type { AttrValue } from "../span.js";
import { internalError } from "../util.js";

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- provider payloads are untyped JSON

export const given = (value: unknown): boolean => value !== undefined && value !== null;

/** `obj[key]`, or `fallback` (null, like Python's None) when missing or null. */
export function get(obj: Json, key: string, fallback: Json = null): Json {
  const value = obj === null || obj === undefined ? undefined : obj[key];
  return given(value) ? value : fallback;
}

export function safe<T>(where: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    internalError(where, error);
    return undefined;
  }
}

/** The app cancelled the call; that is not a failure of the provider. */
export function cancelled(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" || name === "APIUserAbortError";
}

export interface FinishFields {
  responseId?: unknown;
  model?: unknown;
  finishReasons?: unknown[];
  outputMessages?: unknown[];
  toolCalls?: { id: unknown; name: unknown; arguments?: unknown }[];
  usage?: Record<string, unknown>;
  error?: unknown;
}

/** One LLM call as a GenAI semconv CLIENT span. */
export class Generation {
  private handle: GenerationHandle | null = null;
  private started = nowMs();
  private firstChunk: number | null = null;
  private done = false;

  constructor(provider: string, model: unknown, request: Record<string, AttrValue | null>, operation = "chat") {
    const modelName = given(model) ? String(model) : "";
    const attrs: Record<string, AttrValue> = {};
    for (const [key, value] of Object.entries(request)) if (value !== null && value !== undefined) attrs[key] = value;
    this.handle = startGeneration(
      `${operation} ${modelName}`.trim(),
      { "gen_ai.operation.name": operation, "gen_ai.provider.name": provider, "gen_ai.request.model": modelName },
      attrs,
    );
  }

  get active(): boolean {
    return this.handle !== null;
  }

  /** Run the provider call with this span current. */
  run<T>(fn: () => T): T {
    return this.handle ? this.handle.run(fn) : fn();
  }

  content(key: string, value: unknown): void {
    if (this.handle && given(value)) setContent(this.handle.obs, key, value);
  }

  set(key: string, value: AttrValue | null): void {
    if (this.handle && value !== null) this.handle.span.setAttribute(key, value);
  }

  setError(message: string): void {
    this.handle?.span.setError(message.slice(0, 32768));
  }

  markFirstChunk(): void {
    if (this.firstChunk === null) this.firstChunk = nowMs();
  }

  finish(fields: FinishFields = {}): void {
    const handle = this.handle;
    if (!handle || this.done) return;
    this.done = true;
    const span = handle.span;
    try {
      if (fields.responseId) span.setAttribute("gen_ai.response.id", String(fields.responseId));
      if (fields.model) span.setAttribute("gen_ai.response.model", String(fields.model));
      const reasons = (fields.finishReasons ?? []).filter(Boolean).map(String);
      if (reasons.length) span.setAttribute("gen_ai.response.finish_reasons", reasons);
      for (const [key, value] of Object.entries(fields.usage ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) span.setAttribute(`gen_ai.usage.${key}`, Math.trunc(value));
      }
      if (this.firstChunk !== null) span.setAttribute("gen_ai.response.time_to_first_chunk", (this.firstChunk - this.started) / 1000);
      if (fields.outputMessages?.length) setContent(handle.obs, "gen_ai.output.messages", fields.outputMessages);
      const calls = fields.toolCalls ?? [];
      if (calls.length) {
        // Arguments are content: they go through `redact` like every other content field, and are
        // dropped when it throws.
        const withArgs = contentAllowed(handle.obs);
        const cfg = getState()?.cfg;
        let redacted = false;
        const listed = calls.map((c) => {
          const call: Record<string, unknown> = { id: c.id ?? null, name: c.name ?? null };
          if (withArgs && given(c.arguments)) {
            const [args, changed, ok] = applyRedact(cfg?.redact ?? null, c.arguments);
            redacted = redacted || changed;
            if (ok) call.arguments = args;
          }
          return call;
        });
        if (redacted) span.setAttribute(REDACTED, true);
        const [text, cut] = fit(dumps(listed), cfg?.maxContentBytes ?? 1 << 20);
        span.setAttribute("zoroval.tool_calls", text);
        if (cut) addTruncated(span, cut);
        registerToolCalls(handle.obs, calls.map((c) => ({ id: c.id as string, name: c.name as string, arguments: c.arguments })));
      }
      if (given(fields.error) && !cancelled(fields.error)) recordError(span, fields.error);
    } catch (error) {
      internalError("generation.finish", error);
    } finally {
      handle.end();
    }
  }

  fail(error: unknown): void {
    this.finish({ error });
  }
}

type Iter = { next(...args: unknown[]): Promise<IteratorResult<Json>>; return?(value?: unknown): Promise<IteratorResult<Json>>; throw?(error?: unknown): Promise<IteratorResult<Json>> };

/**
 * Pass an async iterator's events through unchanged and give each to `observe`; `finish(error)` runs
 * once when the stream ends, fails, or the reader stops early (`break`, `return()`).
 */
export function watchIterator(
  inner: Iter, gen: Generation, observe: (event: Json) => void, finish: (error?: unknown) => void,
): Iter & { [Symbol.asyncIterator](): unknown } {
  let ended = false;
  const end = (error?: unknown) => {
    if (ended) return;
    ended = true;
    safe("stream.finish", () => finish(error));
  };
  const watcher = {
    async next(...args: unknown[]) {
      let result: IteratorResult<Json>;
      try {
        result = await inner.next(...args);
      } catch (error) {
        end(error);
        throw error;
      }
      if (result.done) end();
      else {
        gen.markFirstChunk();
        safe("stream.observe", () => observe(result.value));
      }
      return result;
    },
    async return(value?: unknown) {
      try {
        return inner.return ? await inner.return(value) : { done: true as const, value };
      } finally {
        end();
      }
    },
    async throw(error?: unknown) {
      try {
        if (inner.throw) return await inner.throw(error);
        throw error;
      } finally {
        end(error);
      }
    },
    [Symbol.asyncIterator]() {
      return watcher;
    },
  };
  return watcher;
}

export function textPart(text: unknown): Json {
  return { type: "text", content: text };
}

/** Media is not captured in v1: a placeholder keeps the message shape. */
export function mediaPart(kind: string, detail: unknown = null): Json {
  const part: Json = { type: kind, content: `[${kind} omitted]` };
  if (typeof detail === "string" && detail && !detail.startsWith("data:")) part.uri = detail;
  return part;
}

/** Rebuilds a streamed reply from its events; `finish` runs once. */
export interface StreamState {
  observe(event: Json): void;
  finish(error?: unknown): void;
}

/** How one provider API reads a request and its result (openai.ts, anthropic.ts). */
export interface CallMapper {
  start(body: Json): Generation;
  finish(gen: Generation, result: Json): void;
  stream(gen: Generation): StreamState;
}

const WRAPPED = Symbol.for("zoroval.wrapped");
type Fn = (this: unknown, ...args: unknown[]) => unknown;

const isStream = (value: Json): boolean =>
  value !== null && typeof value === "object" && !("choices" in value) && !("output" in value) && !("content" in value) &&
  (typeof value[Symbol.asyncIterator] === "function" || typeof value.iterator === "function");

/** Watch the events of the provider's stream object in place; the app keeps reading the same object. */
function watchStream(stream: Json, gen: Generation, state: StreamState): void {
  const watch = (make: () => Json) => () => watchIterator(make(), gen, state.observe, state.finish);
  // The Stainless clients (openai, @anthropic-ai/sdk) keep the generator in `iterator`; `tee()` calls it
  // directly, `for await` goes through Symbol.asyncIterator, which calls it too.
  if (typeof stream.iterator === "function") {
    const original = stream.iterator;
    stream.iterator = watch(() => original.call(stream));
  } else {
    const original = stream[Symbol.asyncIterator];
    stream[Symbol.asyncIterator] = watch(() => original.call(stream));
  }
}

/**
 * Attach the span to the provider's returned promise without changing it. A Stainless `APIPromise`
 * reads the body only through `parse()`, so that is where the parsed value is seen; `asResponse()`
 * (raw body for the app) ends the span without content. The libraries' helpers derive new promises
 * with `_thenUnwrap()`: those are hooked the same way. Any other promise is observed with `then`.
 */
function observeCall(call: Json, gen: Generation, mapper: CallMapper, where: string): void {
  let seen = false;
  const onValue = (value: Json) => {
    if (seen) return;
    seen = true;
    try {
      if (value === null) gen.finish(); // raw response: the app reads the bytes itself
      else if (isStream(value)) watchStream(value, gen, mapper.stream(gen));
      else mapper.finish(gen, value);
    } catch (error) {
      internalError(`${where}.finish`, error);
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

/**
 * Patch `owner[method]` of one client instance. The wrap checks the SDK state on each call: `init()` may
 * run after a module-level wrap, and with no key the call goes straight to the original method.
 */
export function wrapMethod(owner: Json, method: string, mapper: CallMapper, where: string): void {
  const original = owner?.[method] as Fn | undefined;
  if (typeof original !== "function" || (original as Json)[WRAPPED]) return;
  const wrapper: Fn = function (this: unknown, ...args) {
    if (!getState()) return original.apply(this, args);
    let gen: Generation | undefined;
    try {
      gen = mapper.start(args[0]);
    } catch (error) {
      internalError(`${where}.start`, error);
    }
    if (!gen || !gen.active) return original.apply(this, args);
    let call: unknown;
    try {
      call = gen.run(() => original.apply(this, args));
    } catch (error) {
      gen.fail(error);
      throw error;
    }
    safe(`${where}.observe`, () => observeCall(call, gen!, mapper, where));
    return call;
  };
  (wrapper as Json)[WRAPPED] = true;
  owner[method] = wrapper;
}

/** Host of a client's base URL, and its port when the URL names one. */
export function hostOf(baseURL: unknown): { host?: string; port?: number } {
  try {
    const url = new URL(String(baseURL));
    return url.port ? { host: url.hostname, port: Number(url.port) } : { host: url.hostname };
  } catch {
    return {};
  }
}

/**
 * A provider-run tool's result as content: the opaque `encrypted_*` fields providers attach to search results
 * and citations are dropped, and base64 data (a fetched PDF or image) becomes a placeholder.
 */
export function withoutEncrypted(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutEncrypted);
  if (value === null || typeof value !== "object") return value;
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("encrypted_")) continue;
    out[key] = key === "data" && value.type === "base64" ? `[${value.media_type ?? "file"} omitted]` : withoutEncrypted(item);
  }
  return out;
}
