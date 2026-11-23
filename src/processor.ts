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
 * is sent unless `flush()` is called (the platform's `waitUntil` keeps it alive), and each flush
 * sends inside the request that called it: its own loop, its own abort signal, only the spans
 * queued before it, and nothing shared with another request's I/O (Workers refuse that). There
 * `flush()` has a hard deadline and what it had to send but could not is counted as failed, not
 * retried forever. `flush()` first waits, bounded, for turns still open, so a streamed reply that
 * ends after the response is returned is still sent (on Workers most of the flush time, since the
 * request lives only as long as `waitUntil`). No GenAI-span filter, scrubbing of foreign spans, or fork
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
const MAX_OPEN_WAIT_MS = 10_000; // longest a Node flush waits for open turns
const SEND_RESERVE_MS = 5_000; // on Workers and Edge, the part of a flush kept for sending after open turns end
const POLL_MS = 25; // Workers and Edge poll instead of waking across requests
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
  seq: number; // order queued: a Workers flush sends only what was queued before it
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
  private heldUntil = 0; // when the earliest held span is released (set by takeBatch)
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
    this.enqueued += 1;
    this.queue.push({ span, size, seq: this.enqueued });
    this.queueBytes += size;
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

  /** The time after which a background send must give up: none, until shutdown sets one. */
  private hardDeadline(): number {
    return this.stopping ? this.shutdownDeadline : Infinity;
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

  /** The next batch to send; `upTo` limits it to spans queued at or before that sequence number. */
  private takeBatch(deadline: number, upTo = Infinity): Batch | null {
    const retryAt = this.retry.findIndex((batch) => batch.items.some((item) => item.seq <= upTo));
    if (retryAt >= 0) {
      const [batch] = this.retry.splice(retryAt, 1);
      this.retrySpans -= batch!.items.length;
      this.queueBytes -= batch!.size;
      return batch!;
    }
    // A tool run still waiting to be linked to its streamed tool call stays queued until its grace
    // (a fraction of a second) ends, a flush too: only a deadline that is about to pass sends it as it is.
    const now = nowMs();
    const releaseAll = deadline - now < 500;
    this.heldUntil = 0;
    const taken: number[] = [];
    let size = 0;
    for (let at = 0; at < this.queue.length && taken.length < this.cfg.maxBatchSpans; at++) {
      const item = this.queue[at]!;
      if (item.seq > upTo) break;
      if (!releaseAll && item.span.holdUntil > now) {
        this.heldUntil = this.heldUntil ? Math.min(this.heldUntil, item.span.holdUntil) : item.span.holdUntil;
        continue;
      }
      if (taken.length && size + item.size > this.batchLimit) break;
      size += item.size;
      taken.push(at);
    }
    if (!taken.length) return null;
    const items = taken.map((at) => this.queue[at]!);
    const gone = new Set(taken);
    this.queue = this.queue.filter((_, at) => !gone.has(at));
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
      const batch = this.takeBatch(deadline);
      if (!batch) {
        // only held spans are left: a flush or shutdown waits out the grace, the background timer comes back by itself
        if (this.queue.length && (this.flushes.length || this.stopping)) {
          await sleep(Math.max(this.heldUntil - nowMs(), 5), this.transport.signal);
          continue;
        }
        return;
      }
      await this.sendBatch(batch, deadline, this.transport.signal);
      this.notify();
    }
  }

  /** Export one batch and count it as done, except the spans that went back to the queue. */
  private async sendBatch(batch: Batch, deadline: number, signal: AbortSignal): Promise<void> {
    const size = batch.items.length;
    let putBack = 0;
    try {
      putBack = await this.exportBatch(batch, deadline, signal);
    } catch (error) {
      internalError("export", error);
      addCount("spansFailed", size);
    }
    this.completed += size - putBack;
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
  private async exportBatch(batch: Batch, hardDeadline: number, signal: AbortSignal): Promise<number> {
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
    const deadline = Math.min(nowMs() + budget, hardDeadline);
    const result = await this.transport.send(tracesUrl(this.cfg), body, {
      deadline, batchId: batch.batchId, timeout, splitOnTimeout: count > 1, signal,
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
    if (result.retryable && (this.stopping || nowMs() >= hardDeadline)) {
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

  /**
   * Wait until every span queued before this call is sent or given up. Never throws. `openWork`
   * counts the turns and generations to wait for first (default: all of them in this process).
   */
  async flush(timeoutMs: number, openWork: () => number = () => this.openRoots): Promise<boolean> {
    if (this.stopped) return true;
    if (!RUNTIME.background) return this.flushHere(timeoutMs, openWork);
    const deadline = nowMs() + Math.max(timeoutMs, 0);
    this.flushes.push(deadline);
    try {
      // Turns still open get up to half the time (and no more than 10 s), so a streamed reply that ends
      // later is still sent, while a turn that never ends cannot hold every later flush.
      const until = nowMs() + Math.min(Math.max(timeoutMs, 0) / 2, MAX_OPEN_WAIT_MS);
      while (openWork() > 0 && nowMs() < until) await this.waitForChange(until - nowMs());
      const target = this.enqueued;
      if (this.completed >= target) return true;
      this.kick();
      while (this.completed < target) {
        const remaining = deadline - nowMs();
        if (remaining <= 0) return false;
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
   * Workers and Edge: send what was queued before this call, inside the calling request. Nothing here
   * waits on, wakes, or aborts work that belongs to another request: the platform may cancel that
   * request at any time, and Workers refuse I/O objects shared across requests.
   */
  private async flushHere(timeoutMs: number, openWork: () => number): Promise<boolean> {
    const total = Math.max(timeoutMs, 0);
    const deadline = nowMs() + total;
    const controller = new AbortController();
    const signal = controller.signal;
    this.flushes.push(deadline);
    try {
      // Open turns and streams get all but the send reserve: the request lives only as long as this flush.
      const until = deadline - Math.min(SEND_RESERVE_MS, total / 2);
      while (openWork() > 0 && nowMs() < until) await sleep(Math.min(POLL_MS, until - nowMs()), signal);
      const target = this.enqueued;
      for (;;) {
        if (this.stopped) return true;
        if (nowMs() >= deadline - 50) break;
        const held = this.transport.holdRemaining();
        if (held > 0) {
          if (nowMs() + held >= deadline) break;
          await sleep(held, signal);
          continue;
        }
        const batch = this.takeBatch(deadline, target);
        if (batch) {
          await this.sendBatch(batch, deadline, signal);
          continue;
        }
        // Only spans still held for a moment are left (a tool run waiting for its tool call): wait them out.
        if (this.heldUntil) {
          await sleep(Math.max(this.heldUntil - nowMs(), 5), signal);
          continue;
        }
        return true; // everything queued before this flush is sent, or is in another flush's hands
      }
      this.dropUpTo(target);
      return false;
    } catch (error) {
      internalError("flush", error);
      return false;
    } finally {
      this.flushes.splice(this.flushes.indexOf(deadline), 1);
      controller.abort();
    }
  }

  /** A Workers or Edge flush ran out of time: what it had to send and could not is counted as failed. */
  private dropUpTo(target: number): void {
    let left = 0;
    const keep = (item: Item) => {
      if (item.seq > target) return true;
      left += 1;
      this.queueBytes -= item.size;
      return false;
    };
    this.queue = this.queue.filter(keep);
    for (const batch of this.retry) {
      const before = batch.items.length;
      batch.items = batch.items.filter(keep);
      this.retrySpans -= before - batch.items.length;
      batch.size = batch.items.reduce((sum, item) => sum + item.size, 0);
    }
    this.retry = this.retry.filter((batch) => batch.items.length);
    this.completed += left;
    if (left) addCount("spansFailed", left);
  }

  /**
   * The process is ending (`beforeExit`, SIGTERM): flush within `timeoutMs`, and if that is not enough,
   * stop the work and count what is left as failed. Without the second part the retry loop would keep
   * the process alive for as long as the ingest URL is down.
   */
  async flushForExit(timeoutMs: number): Promise<void> {
    try {
      if (!(await this.flush(timeoutMs))) await this.abandon();
    } catch (error) {
      internalError("flushForExit", error);
    }
  }

  private async abandon(): Promise<void> {
    if (RUNTIME.background) this.transport.abortInflight(); // on Workers each flush aborts its own sends
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
