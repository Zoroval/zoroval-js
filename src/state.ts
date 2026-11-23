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

export function getState(): State | null {
  return current;
}

export function setState(state: State | null): void {
  current = state;
}
