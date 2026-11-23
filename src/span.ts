/**
 * The SDK's own span record. Python builds on OpenTelemetry spans; this SDK has no OpenTelemetry
 * dependency (Workers lack the Node APIs it needs, and it would add size to every bundle), so a
 * span is a small plain object that the transport encodes as OTLP JSON.
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

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes: Record<string, AttrValue>;
}

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: number;
  readonly startMs: number;
  endMs = 0;
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
    this.startMs = Date.now();
    Object.assign(this.attributes, attributes);
  }

  setAttribute(key: string, value: AttrValue): void {
    if (!this.ended) this.attributes[key] = value;
  }

  setError(message: string): void {
    if (!this.ended) this.status = { code: STATUS_ERROR, message };
  }

  addEvent(name: string, attributes: Record<string, AttrValue>): void {
    if (!this.ended) this.events.push({ name, timeMs: Date.now(), attributes });
  }

  /** Marks the span ended. Returns false when it already was (a span ends once). */
  end(): boolean {
    if (this.ended) return false;
    this.ended = true;
    this.endMs = Date.now();
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
