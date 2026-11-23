/**
 * The few things that differ per runtime, set once by the entry file the bundler picked
 * (`entry.node.ts`, `entry.workerd.ts`, `entry.edge.ts` or `entry.default.ts`).
 *
 * New in the TypeScript SDK (Python has one runtime): the package ships one entry per runtime
 * through conditional exports, so no Node-only import reaches an edge bundle.
 * - `als`: AsyncLocalStorage, the job Python's `contextvars` does. `undefined` means this runtime
 *   cannot carry context safely; turns then stay ungrouped and are never mixed between requests.
 * - `background`: true where a timer may send spans after the response (Node). False on Workers and
 *   Edge, where nothing survives the response: `flush()` must be handed to the platform.
 * - `webcrypto`: fallback for runtimes without a global `crypto` (Node 18).
 */

export interface AlsLike<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}

export type AlsConstructor = new <T>() => AlsLike<T>;

export interface RuntimeConfig {
  als?: AlsConstructor;
  background: boolean;
  webcrypto?: { getRandomValues(array: Uint8Array): unknown };
  /** Wired by the Node entry: flush on beforeExit and SIGTERM. */
  processHooks?: boolean;
}

export const RUNTIME: RuntimeConfig = { background: true };

export function installRuntime(config: RuntimeConfig): void {
  Object.assign(RUNTIME, config);
}

/** `process.env` where it exists (Node, Workers with nodejs_compat); never throws. */
export function readEnv(name: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const value = proc?.env?.[name];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Monotonic milliseconds where possible. */
export function nowMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}
