/**
 * `withZoroval(handler)` for Cloudflare Workers: wraps `export default { fetch, scheduled, queue, ... }`.
 * New in the TypeScript SDK (Python has no equivalent).
 *
 * On each invocation it starts the SDK from the Worker's `env` bindings (`ZOROVAL_INGEST_KEY`,
 * `ZOROVAL_INGEST_URL`, `ZOROVAL_ENVIRONMENT`, ...; `process.env` is not there without the
 * `nodejs_compat` flag), runs the handler, and hands `flush()` to `ctx.waitUntil()` so the trace is
 * sent after the response. `flush()` waits for turns and generations still open, so a streamed reply
 * that ends after the `Response` was returned is sent too. The handler's result and errors pass
 * through unchanged.
 */

import type { InitOptions } from "../config.js";
import { init, flush } from "../setup.js";
import { internalError } from "../util.js";

const HANDLERS = ["fetch", "scheduled", "queue", "email", "tail", "tailStream", "trace"] as const;

function text(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function flag(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function optionsFrom(env: unknown, explicit: InitOptions): InitOptions {
  const bindings = env !== null && typeof env === "object" ? (env as Record<string, unknown>) : {};
  const rate = Number(text(bindings, "ZOROVAL_SAMPLE_RATE"));
  const fromEnv: InitOptions = {
    apiKey: text(bindings, "ZOROVAL_INGEST_KEY"),
    ingestUrl: text(bindings, "ZOROVAL_INGEST_URL"),
    serviceName: text(bindings, "ZOROVAL_SERVICE_NAME"),
    environment: text(bindings, "ZOROVAL_ENVIRONMENT"),
    release: text(bindings, "ZOROVAL_RELEASE"),
    captureContent: flag(text(bindings, "ZOROVAL_CAPTURE_CONTENT")),
    sampleRate: text(bindings, "ZOROVAL_SAMPLE_RATE") !== undefined && Number.isFinite(rate) ? rate : undefined,
    enabled: flag(text(bindings, "ZOROVAL_ENABLED")),
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...fromEnv, ...explicit })) if (value !== undefined) out[key] = value;
  return out as InitOptions;
}

type Handler = (this: unknown, arg: unknown, env: unknown, ctx: { waitUntil?(promise: Promise<unknown>): void } | undefined) => unknown;

/**
 * Wrap a Worker's exported handler object. Returns an object of the same type.
 *
 *     export default zoroval.withZoroval({ async fetch(request, env, ctx) { ... } });
 */
export function withZoroval<T extends object>(handler: T, options: InitOptions = {}): T {
  const wrapped: Record<string, unknown> = { ...(handler as Record<string, unknown>) };
  for (const name of HANDLERS) {
    const original = (handler as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    wrapped[name] = function (this: unknown, arg: unknown, env: unknown, ctx: Parameters<Handler>[2]) {
      try {
        init(optionsFrom(env, options));
      } catch (error) {
        internalError("withZoroval.init", error);
      }
      let result: unknown;
      try {
        result = (original as Handler).call(this, arg, env, ctx);
      } catch (error) {
        sendAfter(ctx, Promise.resolve());
        throw error;
      }
      sendAfter(ctx, Promise.resolve(result));
      return result;
    };
  }
  return wrapped as T;
}

/** Hand `flush()` to the platform once the handler has settled; never lets a failure reach the app. */
function sendAfter(ctx: Parameters<Handler>[2], settled: Promise<unknown>): void {
  try {
    ctx?.waitUntil?.(settled.then(() => undefined, () => undefined).then(() => flush()));
  } catch (error) {
    internalError("withZoroval.waitUntil", error);
  }
}
