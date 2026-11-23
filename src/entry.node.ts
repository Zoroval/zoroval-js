/** Node 18+ (and Next.js Node routes): AsyncLocalStorage from `node:async_hooks`, background timer, exit hooks. */
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";
import { installRuntime } from "./runtime.js";

installRuntime({ als: AsyncLocalStorage, background: true, processHooks: true, webcrypto });
export * from "./api.js";
