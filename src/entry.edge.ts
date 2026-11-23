/** Vercel Edge and Next.js edge routes: the Edge runtime provides `AsyncLocalStorage` as a global. No background timer. */
import { installRuntime } from "./runtime.js";
import type { AlsConstructor } from "./runtime.js";

installRuntime({
  als: (globalThis as { AsyncLocalStorage?: AlsConstructor }).AsyncLocalStorage,
  background: false,
});
export * from "./api.js";
