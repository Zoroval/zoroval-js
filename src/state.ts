/** The one process-wide SDK state. `null` until init() succeeds. Mirrors `_state.py`. */

import type { Config } from "./config.js";
import type { Processor } from "./processor.js";
import type { Transport } from "./transport.js";

export interface State {
  cfg: Config;
  processor: Processor;
  transport: Transport;
}

let current: State | null = null;
let declined = false;

export function getState(): State | null {
  return current;
}

export function setState(state: State | null): void {
  current = state;
  if (state) declined = false;
}

/** init() ran and tracing stayed off (no key, `enabled: false`, a bad key or URL). */
export function tracingOff(): boolean {
  return current === null && declined;
}

export function setDeclined(value = true): void {
  if (!current) declined = value;
}
