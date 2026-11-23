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
  addTruncated, contentAllowed, recordError, registerToolCalls, setContent, startGeneration,
} from "../context.js";
import type { GenerationHandle } from "../context.js";
import { dumps, fit } from "../json.js";
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
        const withArgs = contentAllowed(handle.obs);
        const listed = calls.map((c) => ({
          id: c.id ?? null,
          name: c.name ?? null,
          ...(withArgs && given(c.arguments) ? { arguments: c.arguments } : {}),
        }));
        const [text, cut] = fit(dumps(listed), getState()?.cfg.maxContentBytes ?? 1 << 20);
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
