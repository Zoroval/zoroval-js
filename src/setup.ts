/**
 * init(), shutdown(), flush() and status().
 *
 * - No key, `enabled: false`, a key that is not a Zoroval ingest key, or a bad ingest URL make
 *   init() a silent no-op (it returns false and logs nothing: an app that has not set a key yet
 *   must not be noisy). A second init() keeps the first configuration.
 * - Node: a background timer sends batches; `beforeExit` and `SIGTERM` flush within
 *   `shutdownTimeoutMs`. The SIGTERM listener keeps the default behaviour: when it is the only
 *   listener, the process still exits after the flush.
 * - Workers and Edge: nothing is sent on a timer; hand `flush()` to the platform (`waitUntil`).
 *
 * Deviations from `_setup.py`: no TracerProvider coexistence (no OpenTelemetry), no log export, no
 * auto-instrumentation (wrapping the OpenAI client is explicit and comes in a later step);
 * `atexit` becomes `beforeExit`/`SIGTERM`; durations are milliseconds; `shutdown()` also resets
 * the counters and one-time log keys so a later init() starts fresh.
 */

import { resolve, keyIdOf, ingestUrlOk } from "./config.js";
import type { InitOptions } from "./config.js";
import { PENDING } from "./context.js";
import { Processor } from "./processor.js";
import { RUNTIME } from "./runtime.js";
import { getState, setState } from "./state.js";
import { Transport } from "./transport.js";
import { COUNTERS, internalError, logOnce, resetCounters, resetLogOnce } from "./util.js";

let hooksInstalled = false;
let sigtermHandler: (() => void) | null = null;
let beforeExitHandler: (() => void) | null = null;

type ProcessLike = {
  on(event: string, handler: () => void): unknown;
  removeListener(event: string, handler: () => void): unknown;
  listenerCount(event: string): number;
  kill(pid: number, signal: string): void;
  pid: number;
};

function nodeProcess(): ProcessLike | null {
  const proc = (globalThis as { process?: Partial<ProcessLike> }).process;
  return proc && typeof proc.on === "function" && typeof proc.listenerCount === "function" ? (proc as ProcessLike) : null;
}

function installProcessHooks(): void {
  const proc = nodeProcess();
  if (hooksInstalled || !proc || !RUNTIME.processHooks) return;
  hooksInstalled = true;
  beforeExitHandler = () => {
    const state = getState();
    if (state && state.processor.queueState().queueSpans > 0) void state.processor.flush(state.cfg.shutdownTimeoutMs);
  };
  sigtermHandler = () => {
    const state = getState();
    const others = proc.listenerCount("SIGTERM") > 1; // the app handles SIGTERM itself: flush, do not exit
    const finish = () => {
      if (others || !sigtermHandler) return;
      proc.removeListener("SIGTERM", sigtermHandler);
      try {
        proc.kill(proc.pid, "SIGTERM"); // restore the default: exit
      } catch {
        /* nothing more to do */
      }
    };
    if (!state) return finish();
    void state.processor.flush(state.cfg.shutdownTimeoutMs).then(finish, finish);
  };
  proc.on("beforeExit", beforeExitHandler);
  proc.on("SIGTERM", sigtermHandler);
}

function removeProcessHooks(): void {
  const proc = nodeProcess();
  if (proc && beforeExitHandler) proc.removeListener("beforeExit", beforeExitHandler);
  if (proc && sigtermHandler) proc.removeListener("SIGTERM", sigtermHandler);
  hooksInstalled = false;
  beforeExitHandler = sigtermHandler = null;
}

/**
 * Start Zoroval tracing. Safe to call more than once; never throws.
 * Returns true when tracing is active.
 */
export function init(options: InitOptions = {}): boolean {
  try {
    if (getState()) return true; // the first good configuration stays
    const { cfg, unknown } = resolve({ ...options });
    if (unknown.length) logOnce("unknown-options", `zoroval: init() ignored unknown options: ${unknown.join(", ")}.`);
    if (!cfg.enabled || !cfg.apiKey) return false;
    if (keyIdOf(cfg.apiKey) === null) {
      logOnce("bad-key", "zoroval: the ingest key does not look like a Zoroval ingest key (zv_ingest_...). Tracing is off.");
      return false;
    }
    if (!ingestUrlOk(cfg.ingestUrl)) return false;
    const transport = new Transport(cfg);
    setState({ cfg, transport, processor: new Processor(cfg, transport) });
    installProcessHooks();
    return true;
  } catch (error) {
    internalError("init", error);
    return false;
  }
}

/** Send everything queued so far. Returns a promise that never rejects; true when all was sent. */
export async function flush(timeoutMs?: number): Promise<boolean> {
  try {
    const state = getState();
    if (!state) return true;
    return await state.processor.flush(timeoutMs ?? (RUNTIME.background ? 5000 : 25_000));
  } catch (error) {
    internalError("flush", error);
    return false;
  }
}

/** Flush and stop. Resolves with status() and never rejects. */
export async function shutdown(timeoutMs?: number): Promise<Record<string, unknown>> {
  const state = getState();
  if (!state) return status();
  try {
    await state.processor.shutdown(timeoutMs ?? state.cfg.shutdownTimeoutMs);
  } catch (error) {
    internalError("shutdown", error);
  }
  removeProcessHooks();
  const result = status();
  setState(null);
  PENDING.clear();
  resetCounters();
  resetLogOnce();
  return result;
}

/** Counters and health: sent, dropped, failed, queue size, last error. Never shows the key. */
export function status(): Record<string, unknown> {
  const state = getState();
  const out: Record<string, unknown> = { active: state !== null, ...COUNTERS };
  if (state) {
    Object.assign(out, state.processor.queueState());
    out.keyId = keyIdOf(state.cfg.apiKey);
    out.ingestUrl = state.cfg.ingestUrl;
    out.lastError = state.transport.lastError;
    out.keyRefused = state.transport.fatalReason;
    out.exportState = state.transport.exportState();
    out.exportResumesInS = Math.round(state.transport.holdRemaining() / 100) / 10;
    out.sampleRate = state.cfg.sampleRate;
    out.captureContent = state.cfg.captureContent;
  }
  return out;
}
