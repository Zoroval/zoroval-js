/** CommonJS build of the Workers entry: same as `entry.workerd.ts`, with `require` instead of a dynamic import. */
import { installRuntime } from "./runtime.js";
import type { AlsConstructor } from "./runtime.js";

declare const require: ((id: string) => unknown) | undefined;

const specifier = "node:async_hooks";
let als: AlsConstructor | undefined;
try {
  als = (require?.(specifier) as { AsyncLocalStorage?: AlsConstructor } | undefined)?.AsyncLocalStorage;
} catch {
  /* no nodejs_als or nodejs_compat flag */
}

installRuntime({ als, background: false });
export * from "./api.js";
