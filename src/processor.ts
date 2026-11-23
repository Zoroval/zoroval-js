/**
 * The Zoroval span processor: head sampling, a queue capped in spans and bytes, batching, bounded
 * flush and shutdown.
 *
 * Batch lifecycle: queued, sending, then sent; split in two (413, or a timeout on a slow uplink);
 * put back at the front of the queue (retries used up while the gateway is down, at most
 * `MAX_REQUEUES` times, or the gateway asked for a pause); or dropped. The exporter itself is
 * `running`, `paused(until)` after a long Retry-After, or `backing_off(until)` after a failed batch:
 * while held it sends nothing and the queue keeps filling under its caps (oldest dropped first).
 *
 * Deviations from `_processor.py`: there is no thread. Node runs one drain loop that a one-shot
 * `unref` timer starts `flushIntervalMs` after the first queued span. On Workers and Edge nothing
 * is sent unless `flush()` is called (the platform's `waitUntil` keeps it alive); there `flush()`
 * has a hard deadline and what is not sent by then is counted as failed, not retried forever.
 * `flush()` first waits, bounded, for turns still open, so a streamed reply that ends after the
 * response is returned is still sent. No GenAI-span filter, scrubbing of foreign spans, or fork
 * handling: every span is the SDK's own and a JavaScript process has no fork. Sampling uses the
 * same SHA-256 rule as Python, compared as a double instead of an exact 64-bit integer.
 */

import type { Config } from "./config.js";
import { tracesUrl } from "./config.js";
import { RUNTIME, nowMs } from "./runtime.js";
import { estimateSize } from "./span.js";
import type { Span } from "./span.js";
import { WIRE_MARGIN, Transport } from "./transport.js";
import { addCount, guard, internalError, logOnce, sha256, sleep, uuid7 } from "./util.js";

const BATCH_BUDGET_MS = 30_000; // retries for one batch; grows to 1.5 request timeouts for big bodies
const MAX_REQUEUES = 10; // a failing batch goes back to the queue at most this many times
const MIN_BATCH_BYTES = 64 * 1024; // timeouts halve the batch size down to this
const GROW_AFTER_OK = 4; // sends in a row before a halved batch size doubles again

/** Deterministic head sampling: the same key always gets the same answer. */
export function sampleKeep(key: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const digest = sha256(key);
  const view = new DataView(digest.buffer);
  const fraction = view.getUint32(0) / 2 ** 32 + view.getUint32(4) / 2 ** 64;
  return fraction < rate;
}

export function sampleKey(conversationId: string | null, traceId: string): string {
  return conversationId ? "c:" + conversationId : "t:" + traceId;
}

interface Item {
  span: Span;
  size: number;
}

/**
 * Spans sent together under one batch id. A requeued batch keeps its id: the gateway dedupes a
 * resend, and a subset under the same id is safe because spans are deduped by id downstream.
 */
class Batch {
  size: number;

  constructor(
    public items: Item[],
    public batchId: string,
    public requeues = 0,
  ) {
    this.size = items.reduce((sum, item) => sum + item.size, 0);
  }

  halves(): Batch[] {
    const half = Math.floor(this.items.length / 2);
    return [
      new Batch(this.items.slice(0, half), uuid7(), this.requeues),
      new Batch(this.items.slice(half), uuid7(), this.requeues),
    ];
  }
}

export class Processor {
  private queue: Item[] = [];
  private retry: Batch[] = []; // batches put back; older than everything in `queue`
  private retrySpans = 0;
  private queueBytes = 0; // both lists
  private batchLimit: number;
  private okStreak = 0;
  private enqueued = 0;
  private completed = 0;
  private openRoots = 0;
  private flushes: number[] = []; // deadlines of the flush() calls in progress
  private stopping = false;
  private stopped = false;
  private shutdownDeadline = Infinity;
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiters = new Set<() => void>();

  constructor(
    private cfg: Config,
    readonly transport: Transport,
  ) {
    this.batchLimit = cfg.maxBatchBytes;
  }

  // ------------------------------------------------------------------ open turns

  rootStarted(): void {
    this.openRoots += 1;
  }

  rootEnded(): void {
    this.openRoots = Math.max(0, this.openRoots - 1);
    this.notify();
  }

  // ------------------------------------------------------------------ intake

  onEnd(span: Span): void {
    guard("on_end", () => this.accept(span), undefined);
  }

  private accept(span: Span): void {
    if (this.stopped) return;
    addCount("spansSeen");
    const explicit = span.attributes["zoroval.conversation.id"];
    const conversation = typeof explicit === "string" ? explicit : null;
    if (!sampleKeep(sampleKey(conversation, span.traceId), this.cfg.sampleRate)) {
      addCount("spansSampledOut");
      return;
    }
    const size = estimateSize(span);
    this.queue.push({ span, size });
    this.queueBytes += size;
    this.enqueued += 1;
    const dropped = this.dropOldest();
    addCount("spansQueued");
    this.reportDropped(dropped);
    if (!RUNTIME.background || this.stopping) return;
    if (this.queueBytes >= this.batchLimit || this.queue.length >= this.cfg.maxBatchSpans) this.kick();
    else this.schedule(this.cfg.flushIntervalMs);
  }

  private pendingSpans(): number {
    return this.queue.length + this.retrySpans;
  }

  /** Enforce the byte and span caps by dropping the oldest spans (requeued batches first). */
  private dropOldest(): number {
    let dropped = 0;
    while (
      (this.queue.length || this.retry.length) &&
      (this.queueBytes > this.cfg.maxQueueBytes || this.pendingSpans() > this.cfg.maxQueueSpans)
    ) {
      let item: Item;
      if (this.retry.length) {
        const batch = this.retry[0]!;
        item = batch.items.shift()!;
        batch.size -= item.size;
        this.retrySpans -= 1;
        if (!batch.items.length) this.retry.shift();
      } else {
        item = this.queue.shift()!;
      }
      this.queueBytes -= item.size;
      this.completed += 1;
      dropped += 1;
    }
    return dropped;
  }

  private reportDropped(dropped: number): void {
    if (!dropped) return;
    addCount("spansDropped", dropped);
    this.transport.reportDropped(dropped);
    logOnce("queue-full", "zoroval: the export queue is full; the oldest spans are being dropped. See zoroval.status() for counts.");
  }

  /** Put batches back at the front of the queue, under the caps. Returns the spans put back. */
  private putBack(...batches: Batch[]): number {
    let count = 0;
    for (const batch of [...batches].reverse()) {
      if (batch.items.length) {
        this.retry.unshift(batch);
        this.retrySpans += batch.items.length;
        this.queueBytes += batch.size;
        count += batch.items.length;
      }
    }
    this.reportDropped(this.dropOldest());
    return count;
  }

  // ------------------------------------------------------------------ drain loop

  private notify(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  private waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(ms, 0));
      this.waiters.add(wake);
    });
  }

  private schedule(delayMs: number): void {
    if (!RUNTIME.background || this.stopped || this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(delayMs, 0));
    (this.timer as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The time after which a send must give up: the latest flush deadline, or the shutdown one. */
  private hardDeadline(): number {
    if (this.stopping) return this.shutdownDeadline;
    if (RUNTIME.background || !this.flushes.length) return Infinity;
    return Math.max(...this.flushes);
  }

  private kick(): void {
    if (this.draining || this.stopped) return;
    this.draining = this.run()
      .catch((error) => internalError("drain", error))
      .finally(() => {
        this.draining = null;
        this.notify();
        if (this.pendingSpans() && RUNTIME.background && !this.stopping) this.schedule(this.cfg.flushIntervalMs);
      });
  }

  private takeBatch(): Batch | null {
    if (this.retry.length) {
      const batch = this.retry.shift()!;
      this.retrySpans -= batch.items.length;
      this.queueBytes -= batch.size;
      return batch;
    }
    let count = 0;
    let size = 0;
    while (count < this.queue.length && count < this.cfg.maxBatchSpans) {
      const item = this.queue[count]!;
      if (count && size + item.size > this.batchLimit) break;
      size += item.size;
      count += 1;
    }
    if (!count) return null;
    const items = this.queue.splice(0, count);
    this.queueBytes -= size;
    return new Batch(items, uuid7());
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.stopped || !(this.queue.length || this.retry.length)) return;
      const deadline = this.hardDeadline();
      if (nowMs() >= deadline - 50) return;
      const held = this.transport.holdRemaining();
      if (held > 0) {
        // paused or backing off: send nothing; the queue keeps filling under its caps
        if (!this.flushes.length && !this.stopping) {
          this.schedule(held);
          return;
        }
        if (nowMs() + held >= deadline) return;
        await sleep(held, this.transport.signal);
        continue;
      }
      const batch = this.takeBatch();
      if (!batch) return;
      const size = batch.items.length;
      let putBack = 0;
      try {
        putBack = await this.exportBatch(batch);
      } catch (error) {
        internalError("export", error);
        addCount("spansFailed", size);
      }
      this.completed += size - putBack;
      this.notify();
    }
  }

  private shrink(size: number): void {
    this.batchLimit = Math.max(MIN_BATCH_BYTES, Math.floor(Math.min(this.batchLimit, size) / 2));
    this.okStreak = 0;
  }

  private sentOk(): void {
    this.okStreak += 1;
    if (this.batchLimit < this.cfg.maxBatchBytes && this.okStreak >= GROW_AFTER_OK) {
      this.batchLimit = Math.min(this.cfg.maxBatchBytes, this.batchLimit * 2);
      this.okStreak = 0;
    }
  }

  private failBatch(count: number): void {
    addCount("batchesFailed");
    addCount("spansFailed", count);
    this.transport.reportDropped(count);
  }

  /** Send one batch. Returns how many of its spans went back to the queue. */
  private async exportBatch(batch: Batch): Promise<number> {
    const count = batch.items.length;
    if (!this.cfg.apiKey || this.transport.fatalReason) {
      addCount("spansFailed", count);
      return 0;
    }
    const raw = this.transport.encodeSpans(batch.items.map((item) => item.span));
    const body = await this.transport.compress(raw);
    if (body.bytes.length > this.cfg.maxRequestBytes - WIRE_MARGIN) {
      if (count === 1) {
        addCount("spansFailed");
        this.transport.reportDropped(1);
        logOnce("span-too-large", "zoroval: one span was larger than the gateway limit after compression and was dropped.");
        return 0;
      }
      addCount("batchesSplit");
      return this.putBack(...batch.halves());
    }
    const timeout = this.transport.requestTimeoutFor(body.bytes.length);
    const budget = Math.max(BATCH_BUDGET_MS, 1.5 * timeout);
    const deadline = Math.min(nowMs() + budget, this.hardDeadline());
    const result = await this.transport.send(tracesUrl(this.cfg), body, {
      deadline, batchId: batch.batchId, timeout, splitOnTimeout: count > 1,
    });
    if (result.ok) {
      this.sentOk();
      addCount("batchesSent");
      addCount("spansExported", count - result.rejected);
      if (result.rejected) addCount("spansRejected", result.rejected);
      return 0;
    }
    if ((result.status === 413 || result.timeout) && count > 1) {
      if (result.timeout) this.shrink(batch.size); // a slow uplink: send halves now, then smaller batches
      addCount("batchesSplit");
      return this.putBack(...batch.halves());
    }
    if (result.fatal) {
      this.failBatch(count);
      const lost = this.pendingSpans();
      this.queue = [];
      this.retry = [];
      this.retrySpans = 0;
      this.queueBytes = 0;
      this.completed += lost;
      if (lost) addCount("spansFailed", lost);
      return 0;
    }
    if (result.paused) return this.putBack(batch); // the gateway asked for a pause: not this batch's fault
    if (result.retryable && (this.stopping || nowMs() >= this.hardDeadline())) {
      // The deadline cut the retries short; what is left is counted when the flush or shutdown ends.
      if (result.reason !== "shutdown" && result.reason !== "deadline") this.transport.backOff(result.reason);
      return this.putBack(batch);
    }
    if (result.retryable && batch.requeues < MAX_REQUEUES) {
      batch.requeues += 1;
      addCount("batchesRequeued");
      const delay = this.transport.backOff(result.reason || "unreachable");
      logOnce(
        "requeued",
        `zoroval: could not deliver a batch (${result.reason}). Its spans stay queued and are retried in ${(delay / 1000).toFixed(1)}s, then with growing waits.`,
      );
      return this.putBack(batch);
    }
    this.failBatch(count);
    return 0;
  }

  // ------------------------------------------------------------------ flush and shutdown

  /** Wait until every span queued before this call is sent or given up. Never throws. */
  async flush(timeoutMs: number): Promise<boolean> {
    if (this.stopped) return true;
    const deadline = nowMs() + Math.max(timeoutMs, 0);
    this.flushes.push(deadline);
    try {
      // Turns still open get up to half the time, so a streamed reply that ends later is still sent.
      const until = nowMs() + Math.max(timeoutMs, 0) / 2;
      while (this.openRoots > 0 && nowMs() < until) await this.waitForChange(until - nowMs());
      const target = this.enqueued;
      if (this.completed >= target) return true;
      this.kick();
      while (this.completed < target) {
        const remaining = deadline - nowMs();
        if (remaining <= 0) {
          await this.giveUp(deadline);
          return false;
        }
        await this.waitForChange(Math.min(remaining, 250));
      }
      return true;
    } catch (error) {
      internalError("flush", error);
      return false;
    } finally {
      this.flushes.splice(this.flushes.indexOf(deadline), 1);
    }
  }

  /**
   * A flush ran out of time. On Workers and Edge, if no other flush is still waiting, stop the send
   * and count what is left as failed: nothing runs after the platform's deadline anyway.
   */
  private async giveUp(deadline: number): Promise<void> {
    if (RUNTIME.background || this.flushes.some((other) => other > deadline)) return;
    await this.abandon();
  }

  private async abandon(): Promise<void> {
    this.transport.abortInflight();
    if (this.draining) await Promise.race([this.draining, sleep(200)]);
    const left = this.pendingSpans();
    this.queue = [];
    this.retry = [];
    this.retrySpans = 0;
    this.queueBytes = 0;
    this.completed += left;
    if (left) addCount("spansFailed", left);
    this.notify();
  }

  /** Send what is queued, then stop. Returns within about `timeoutMs`. */
  async shutdown(timeoutMs: number): Promise<void> {
    if (this.stopped) return;
    try {
      const done = await this.flush(timeoutMs);
      this.stopping = true;
      this.shutdownDeadline = nowMs();
      this.clearTimer();
      if (!done) await this.abandon();
    } catch (error) {
      internalError("shutdown", error);
    } finally {
      this.stopped = true;
      this.clearTimer();
      this.transport.close();
    }
  }

  queueState(): { queueSpans: number; queueBytes: number } {
    return { queueSpans: this.pendingSpans(), queueBytes: this.queueBytes };
  }
}
