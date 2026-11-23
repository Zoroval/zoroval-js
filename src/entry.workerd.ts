/**
 * Cloudflare Workers. AsyncLocalStorage comes from `node:async_hooks`, which needs the `nodejs_als`
 * or `nodejs_compat` compatibility flag. No background timer: hand `flush()` to `ctx.waitUntil()`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { installRuntime } from "./runtime.js";

installRuntime({ als: AsyncLocalStorage, background: false });
export * from "./api.js";
