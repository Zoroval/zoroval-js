/**
 * The SDK's own span record. Python builds on OpenTelemetry spans; this SDK has no OpenTelemetry
 * dependency (Workers lack the Node APIs it needs, and it would add size to every bundle), so a
 * span is a small plain object that the transport encodes as OTLP JSON.
 *
 * Times are nanoseconds, like Python's: `performance.timeOrigin + performance.now()` where both exist
 * (microsecond resolution on Node), else `Date.now()`. A time is kept as whole milliseconds plus
 * 0 to 999999 sub-millisecond nanoseconds, so the decimal `*UnixNano` string is built from integers
 * and never from a float times 1e6. The clock never goes backwards, so a child starts no earlier
 * than its parent and a span ends no earlier than it started. On Workers the platform clock only
 * advances on I/O, so durations there are coarse by design of the platform.
 *
 * Ids are lowercase hex (16 bytes for a trace, 8 for a span), the form the gateway reads from OTLP
 * JSON. Attribute values are the types the Python SDK writes: string, boolean, number (integer or
 * double) and a list of strings.
 */

import { randomHexId } from "./util.js";

export type AttrValue = string | number | boolean | string[];

export const KIND_INTERNAL = 1;
export const KIND_CLIENT = 3;
export const STATUS_ERROR = 2;

/** A point in time: whole milliseconds since the epoch plus 0 to 999999 nanoseconds. */
export interface Time {
  ms: number;
  ns: number;
}

let last: Time = { ms: 0, ns: 0 };

/** The current time, never earlier than the last one returned. */
export function now(): Time {
  const perf = (globalThis as { performance?: { timeOrigin?: number; now?: () => number } }).performance;
  let t: Time;
  if (perf && typeof perf.timeOrigin === "number" && typeof perf.now === "function") {
    const total = perf.timeOrigin + perf.now();
    const ms = Math.floor(total);
    t = { ms, ns: Math.min(999_999, Math.floor((total - ms) * 1e6)) };
  } else {
    t = { ms: Date.now(), ns: 0 };
  }
  if (t.ms < last.ms || (t.ms === last.ms && t.ns < last.ns)) t = last;
  last = t;
  return t;
}

/** Decimal nanoseconds since the epoch (OTLP JSON writes uint64 as a string). */
export function toNanos(t: Time): string {
  return String(t.ms) + String(t.ns).padStart(6, "0");
}

export interface SpanEvent {
  name: string;
  time: Time;
  attributes: Record<string, AttrValue>;
}

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: number;
  readonly start: Time;
  finish: Time;
  ended = false;
  attributes: Record<string, AttrValue> = {};
  events: SpanEvent[] = [];
  status: { code: number; message: string } | null = null;

  constructor(name: string, kind: number, parent: Span | null, attributes: Record<string, AttrValue>) {
    this.name = name;
    this.kind = kind;
    this.traceId = parent ? parent.traceId : randomHexId(16);
    this.spanId = randomHexId(8);
    this.parentSpanId = parent ? parent.spanId : null;
    this.start = now();
    this.finish = this.start;
    Object.assign(this.attributes, attributes);
  }

  setAttribute(key: string, value: AttrValue): void {
    if (!this.ended) this.attributes[key] = value;
  }

  setError(message: string): void {
    if (!this.ended) this.status = { code: STATUS_ERROR, message };
  }

  addEvent(name: string, attributes: Record<string, AttrValue>): void {
    if (!this.ended) this.events.push({ name, time: now(), attributes });
  }

  /** Marks the span ended. Returns false when it already was (a span ends once). */
  end(): boolean {
    if (this.ended) return false;
    this.ended = true;
    this.finish = now();
    return true;
  }
}

/** A rough size in bytes, used for the queue and batch caps (not the exact wire size). */
export function estimateSize(span: Span): number {
  let size = 160 + span.name.length;
  for (const [key, value] of Object.entries(span.attributes)) {
    size += key.length + 8;
    if (typeof value === "string") size += value.length;
    else if (Array.isArray(value)) size += value.reduce((sum, item) => sum + item.length, 0);
    else size += 8;
  }
  for (const event of span.events) {
    size += 32 + event.name.length;
    for (const [key, value] of Object.entries(event.attributes)) {
      size += key.length + (typeof value === "string" ? value.length : 8);
    }
  }
  return size;
}
