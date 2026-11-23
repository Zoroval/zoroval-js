/** Any other runtime (Deno, Bun, browsers-as-server, older bundlers): the global AsyncLocalStorage if there is one. */
import { installRuntime } from "./runtime.js";
import type { AlsConstructor } from "./runtime.js";

installRuntime({
  als: (globalThis as { AsyncLocalStorage?: AlsConstructor }).AsyncLocalStorage,
  background: true,
});
export * from "./api.js";
