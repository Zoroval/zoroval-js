/**
 * Cloudflare Workers. AsyncLocalStorage comes from `node:async_hooks`, which needs the `nodejs_als`
 * or `nodejs_compat` compatibility flag. No background timer: hand `flush()` to `ctx.waitUntil()`.
 *
 * The module is loaded at run time and not named in a static import, so a Worker without the flag
 * still builds and starts: the SDK then leaves turns ungrouped (it logs once and never mixes two
 * users' chats). A static import would fail the build of every Worker that lacks the flag.
 */
import { installRuntime } from "./runtime.js";
import type { AlsConstructor } from "./runtime.js";

const specifier = "node:async_hooks";
let als: AlsConstructor | undefined;
try {
  als = ((await import(/* @vite-ignore */ specifier)) as { AsyncLocalStorage?: AlsConstructor }).AsyncLocalStorage;
} catch {
  /* no nodejs_als or nodejs_compat flag */
}

installRuntime({ als, background: false });
export * from "./api.js";
