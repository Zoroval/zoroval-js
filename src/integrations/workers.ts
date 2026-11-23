/**
 * `withZoroval(handler)` for Cloudflare Workers: wraps `export default { fetch, scheduled, queue, ... }`
 * or a `WorkerEntrypoint` class. New in the TypeScript SDK (Python has no equivalent).
 *
 * On each invocation it starts the SDK from the Worker's `env` bindings (`ZOROVAL_INGEST_KEY`,
 * `ZOROVAL_INGEST_URL`, `ZOROVAL_ENVIRONMENT`, ...; `process.env` is not there without the
 * `nodejs_compat` flag), runs the handler, and hands `flush()` to `ctx.waitUntil()` so the trace is
 * sent after the response, inside this request. That flush first waits for the turns and generations
 * this request still has open, so a streamed reply that ends after the `Response` was returned is
 * sent too (up to most of the flush time, about 20 s). The handler's result and errors pass through
 * unchanged.
 */

import type { InitOptions } from "../config.js";
import { inRequestScope } from "../context.js";
import type { RequestScope } from "../context.js";
import { init, flushFor } from "../setup.js";
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

type Ctx = { waitUntil?(promise: Promise<unknown>): void } | undefined;

/** One invocation: init from `env`, run the handler as one request, flush through `waitUntil`. */
function invoke(options: InitOptions, env: unknown, ctx: Ctx, run: () => unknown): unknown {
  try {
    init(optionsFrom(env, options));
  } catch (error) {
    internalError("withZoroval.init", error);
  }
  let request: { scope: RequestScope | null; result: unknown };
  try {
    request = inRequestScope(run);
  } catch (error) {
    sendAfter(ctx, Promise.resolve(), null);
    throw error;
  }
  sendAfter(ctx, Promise.resolve(request.result), request.scope);
  return request.result;
}

/**
 * Wrap a Worker's exported handler object, or a `WorkerEntrypoint` class. Returns the same kind.
 *
 *     export default zoroval.withZoroval({ async fetch(request, env, ctx) { ... } });
 */
export function withZoroval<T extends object>(handler: T, options: InitOptions = {}): T {
  if (typeof handler === "function") return wrapClass(handler as unknown as Ctor, options) as unknown as T;
  const wrapped: Record<string, unknown> = { ...(handler as Record<string, unknown>) };
  for (const name of HANDLERS) {
    const original = (handler as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    wrapped[name] = function (this: unknown, arg: unknown, env: unknown, ctx: Ctx) {
      return invoke(options, env, ctx, () => (original as (...a: unknown[]) => unknown).call(this, arg, env, ctx));
    };
  }
  return wrapped as T;
}

type Ctor = new (...args: unknown[]) => { env?: unknown; ctx?: Ctx };

/** A `WorkerEntrypoint` class: its handlers take only the event; `env` and `ctx` are on `this`. */
function wrapClass(Base: Ctor, options: InitOptions): Ctor {
  const names = HANDLERS.filter((name) => typeof (Base.prototype as Record<string, unknown>)?.[name] === "function");
  if (!names.length) {
    throw new TypeError("zoroval.withZoroval: pass the Worker's exported handler object or WorkerEntrypoint class; this class has no fetch, scheduled or queue method.");
  }
  const Wrapped = class extends Base {};
  for (const name of names) {
    const original = (Base.prototype as Record<string, (...a: unknown[]) => unknown>)[name]!;
    Object.defineProperty(Wrapped.prototype, name, {
      configurable: true,
      writable: true,
      value: function (this: { env?: unknown; ctx?: Ctx }, ...args: unknown[]) {
        return invoke(options, this.env, this.ctx, () => original.apply(this, args));
      },
    });
  }
  Object.defineProperty(Wrapped, "name", { value: Base.name });
  return Wrapped;
}

/** Hand `flush()` to the platform once the handler has settled; never lets a failure reach the app. */
function sendAfter(ctx: Ctx, settled: Promise<unknown>, scope: RequestScope | null): void {
  try {
    ctx?.waitUntil?.(settled.then(() => undefined, () => undefined).then(() => flushFor(scope)));
  } catch (error) {
    internalError("withZoroval.waitUntil", error);
  }
}
