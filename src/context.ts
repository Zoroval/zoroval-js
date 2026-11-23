/**
 * Public context API: conversation(), turn(), trace(), step(), tool(), and trace attributes.
 *
 * - conversation(id, fn) groups every turn inside `fn` into one Zoroval trace (design 6.5). It makes
 *   no span itself: a conversation outlives one request.
 * - turn() is the root span of one user turn. trace() is the root of one run (agents, batch jobs);
 *   inside a conversation it acts as a turn.
 * - step() and tool() are child spans.
 *
 * Deviations from `_context.py`: Python's `with` blocks and decorators become callbacks, because a
 * callback is the one shape that carries context safely across `await` in every runtime; context
 * lives in AsyncLocalStorage instead of contextvars (one store per call: conversation, current root
 * and current span); there is no OpenTelemetry span, the SDK's own `Span` is used; a callback's
 * return value is not captured as output (call `obs.setOutput()`), so nothing is sent unasked.
 * Without AsyncLocalStorage (a Worker missing `nodejs_als`) turns stay ungrouped, never mixed.
 * Conversation-level metadata is applied to each root span (Python stores it but never sends it).
 *
 * Added for the OpenAI integrations (integrations/): `startGeneration()` opens a generation span under
 * the current span, the counterpart of Python's `Generation.__init__`; every open generation counts as
 * open work for flush(). `tool()` links a call that the model registered after the tool started or
 * ended (a streamed reply is read in the background), which Python never needs because it registers
 * before `create()` returns. `recordError` names the error by its class when `name` is the default
 * "Error" (openai's `RateLimitError`), the way Python records `__qualname__`.
 */

import { capture as captureValue, dumps, fit, toPlain } from "./json.js";
import type { Processor } from "./processor.js";
import { RUNTIME, nowMs } from "./runtime.js";
import type { AlsLike } from "./runtime.js";
import { sampleKey, sampleKeep } from "./processor.js";
import { getState } from "./state.js";
import { KIND_CLIENT, KIND_INTERNAL, Span } from "./span.js";
import type { AttrValue } from "./span.js";
import { addCount, guard, internalError, logOnce, sha256Hex } from "./util.js";

export const MAX_CONVERSATION_ID = 256;
export const MAX_TAGS = 64;
export const MAX_TAG_CHARS = 128;

// Span attribute names (contracts section 6).
export const CONVERSATION_ID = "zoroval.conversation.id";
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
export const OBS_TYPE = "zoroval.observation.type";
export const USER_ID = "zoroval.user.id";
export const TAGS = "zoroval.tags";
export const METADATA = "zoroval.metadata";
export const INPUT = "zoroval.input";
export const OUTPUT = "zoroval.output";
export const GROUPING = "zoroval.grouping";
export const TEST = "zoroval.test";
export const REDACTED = "zoroval.redacted";
export const TRUNCATED = "zoroval.truncated_bytes";

// Conversation ids other tools put on a parent span (design 6.5 "inherited").
const INHERITED_CONVERSATION_KEYS = [
  "zoroval.conversation.id", "gen_ai.conversation.id", "session.id", "langfuse.session.id",
  "anthropic.session.thread.id",
];

type Id = string | number;

export interface ConversationOptions {
  userId?: Id;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface TurnOptions {
  name?: string;
  input?: unknown;
  userId?: Id;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface StepOptions {
  input?: unknown;
  metadata?: Record<string, unknown>;
  /** "step" (default), "chain" or "agent". */
  type?: "step" | "chain" | "agent";
  captureInput?: boolean;
}

export interface ToolOptions {
  /** The model's tool-call id. Otherwise the one pending call of the same name is used. */
  callId?: string;
  arguments?: unknown;
  metadata?: Record<string, unknown>;
  captureInput?: boolean;
}

interface ConversationScope {
  id: string;
  userId: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

interface Store {
  conversation: ConversationScope | null;
  root: Observation | null;
  span: Span | null;
  test: boolean;
}

const EMPTY: Store = { conversation: null, root: null, span: null, test: false };

let als: AlsLike<Store> | null | undefined;

function getAls(): AlsLike<Store> | null {
  if (als === undefined) als = RUNTIME.als ? new RUNTIME.als<Store>() : null;
  return als;
}

function currentStore(): Store {
  return getAls()?.getStore() ?? EMPTY;
}

/** The turns and generations still open in one Worker request (`withZoroval`), so its flush waits for its own. */
export interface RequestScope {
  open: number;
}

let scopeAls: AlsLike<RequestScope> | null | undefined;

function getScopeAls(): AlsLike<RequestScope> | null {
  if (scopeAls === undefined) scopeAls = RUNTIME.als ? new RUNTIME.als<RequestScope>() : null;
  return scopeAls;
}

/** Run `fn` as one request. Null scope when the runtime cannot carry it: flush then waits for all open work. */
export function inRequestScope<T>(fn: () => T): { scope: RequestScope | null; result: T } {
  const scoped = getScopeAls();
  if (!scoped) return { scope: null, result: fn() };
  const scope: RequestScope = { open: 0 };
  return { scope, result: scoped.run(scope, fn) };
}

function noAlsNotice(): void {
  logOnce(
    "no-als",
    "zoroval: this runtime has no AsyncLocalStorage, so conversations cannot be grouped and each turn " +
      "becomes its own trace. On Cloudflare Workers add the `nodejs_als` compatibility flag.",
  );
}

export function currentConversationId(): string | null {
  return currentStore().conversation?.id ?? null;
}

export function normalizeConversationId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text) return null;
  // Cutting would merge different long ids; a hash keeps them apart and stays stable.
  if (text.length > MAX_CONVERSATION_ID) return "sha256:" + sha256Hex(text);
  return text;
}

export function cleanTags(tags: Iterable<unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const text = String(tag).slice(0, MAX_TAG_CHARS);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------- capture helpers

/** False when content must not be serialized for this span (capture off, span ended, or sampled out). */
export function contentAllowed(obs: Observation): boolean {
  const state = getState();
  if (!state || !obs.span || obs.span.ended || !state.cfg.captureContent) return false;
  if (state.cfg.sampleRate < 1) {
    return sampleKeep(sampleKey(obs.conversationId, obs.span.traceId), state.cfg.sampleRate);
  }
  return true;
}

/** Capture `value` into span attribute `key`, with redact and size cap flags. */
export function setContent(obs: Observation, key: string, value: unknown, limit?: number): void {
  const state = getState();
  if (!state || !obs.span || value === null || value === undefined || !contentAllowed(obs)) return;
  const captured = captureValue(value, {
    captureContent: state.cfg.captureContent,
    redact: state.cfg.redact,
    limit: limit ?? state.cfg.maxContentBytes,
  });
  if (captured.text !== null) obs.span.setAttribute(key, captured.text);
  if (captured.redacted) obs.span.setAttribute(REDACTED, true);
  if (captured.truncatedBytes) addTruncated(obs.span, captured.truncatedBytes);
}

export function addTruncated(span: Span, count: number): void {
  const previous = span.attributes[TRUNCATED];
  span.setAttribute(TRUNCATED, (typeof previous === "number" ? previous : 0) + count);
}

function setMetadataAttr(span: Span, metadata: Record<string, unknown>): void {
  if (Object.keys(metadata).length === 0) return;
  const limit = getState()?.cfg.maxMetadataBytes ?? 16 * 1024;
  const [text, cut] = fit(dumps(metadata), limit);
  span.setAttribute(METADATA, text);
  if (cut) addTruncated(span, cut);
}

function inheritedConversation(attributes: Record<string, AttrValue> | undefined): string | null {
  if (!attributes) return null;
  for (const key of INHERITED_CONVERSATION_KEYS) {
    const value = attributes[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** Explicit ids from conversation(); else an id inherited from the current (parent) span. */
function conversationAttributes(store: Store): Record<string, AttrValue> {
  if (store.conversation) {
    return { [CONVERSATION_ID]: store.conversation.id, [GEN_AI_CONVERSATION_ID]: store.conversation.id };
  }
  const inherited = inheritedConversation(store.span?.attributes);
  return inherited ? { [GEN_AI_CONVERSATION_ID]: inherited } : {};
}

function rootAttributes(userId: Id | undefined, tags: string[] | undefined, store: Store): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {};
  const scope = store.conversation;
  const user = userId ?? scope?.userId;
  if (user !== undefined && user !== null && user !== "") {
    attrs[USER_ID] = String(user);
    attrs["user.id"] = String(user);
  }
  const all = cleanTags([...(scope?.tags ?? []), ...(tags ?? [])]);
  if (all.length) attrs[TAGS] = all;
  if (store.test) attrs[TEST] = true;
  return attrs;
}

/** Span status ERROR plus a standard `exception` event with a capped stack. */
export function recordError(span: Span, error: unknown): void {
  guard("recordError", () => {
    const limit = getState()?.cfg.maxStackBytes ?? 16 * 1024;
    const isError = error instanceof Error;
    // Libraries often subclass Error without setting `name` (openai's RateLimitError): the class name
    // is what Python records (`__qualname__`).
    const type = isError ? (error.name && error.name !== "Error" ? error.name : error.constructor?.name || "Error") : typeof error;
    const text = isError ? error.message : String(error);
    span.setError(`${type}: ${text}`.slice(0, 32768));
    let stack = isError && typeof error.stack === "string" ? error.stack : "";
    if (stack.length > limit) stack = stack.slice(-limit);
    span.addEvent("exception", {
      "exception.type": type,
      "exception.message": text.slice(0, 32768),
      "exception.stacktrace": stack,
      "exception.escaped": true,
    });
    span.setAttribute("error.type", type);
  }, undefined);
}

// ---------------------------------------------------------------------------- pending tool calls

interface PendingCall {
  id: string;
  name: string;
  arguments: unknown;
  traceId: string;
  conversation: string | null;
  at: number;
}

/**
 * Tool calls the model asked for and no tool() run has claimed yet. Keyed by trace id and
 * conversation id, so a match never crosses users or requests.
 */
class PendingCalls {
  static readonly TTL_MS = 600_000;
  /** An unlinked tool run is kept back from export this long (a quarter second), so a streamed reply that registers its calls just after can still link it. */
  static readonly GRACE_MS = 250;
  static readonly LIMIT = 1024;
  private items: PendingCall[] = [];
  /** Tool runs that ended before the model's call was registered (a streamed reply is read in the background). */
  private orphans: { span: Span; name: string; args: unknown; traceId: string; conversation: string | null; at: number }[] = [];

  add(calls: readonly { id?: string; name?: string; arguments?: unknown }[], traceId: string, conversation: string | null): void {
    const now = Date.now();
    for (const call of calls) {
      if (call.id && call.name) {
        this.items.push({ id: call.id, name: call.name, arguments: call.arguments, traceId, conversation, at: now });
      }
    }
    this.prune(now);
    this.link(now);
  }

  /** Remember a finished tool run that found no call to link to; a later registration may fill it in. */
  orphan(span: Span, name: string, args: unknown, traceId: string, conversation: string | null): void {
    span.holdUntil = nowMs() + PendingCalls.GRACE_MS;
    this.orphans.push({ span, name, args, traceId, conversation, at: Date.now() });
    this.orphans = this.orphans.slice(-256);
  }

  private link(now: number): void {
    if (!this.orphans.length) return;
    this.orphans = this.orphans.filter((o) => {
      const id = this.claim(o.name, o.args, o.traceId, o.conversation);
      if (id === null) return now - o.at < PendingCalls.TTL_MS;
      o.span.attributes["gen_ai.tool.call.id"] = id; // the span has ended but is still queued
      o.span.holdUntil = 0;
      return false;
    });
  }

  private prune(now: number): void {
    this.items = this.items.filter((i) => now - i.at < PendingCalls.TTL_MS).slice(-PendingCalls.LIMIT);
  }

  claim(name: string, args: unknown, traceId: string, conversation: string | null): string | null {
    this.prune(Date.now());
    let candidates = this.items.filter(
      (i) => i.name === name && (i.traceId === traceId || (conversation !== null && i.conversation === conversation)),
    );
    if (candidates.length > 1 && args !== undefined && args !== null) {
      candidates = candidates.filter((i) => sameArguments(i.arguments, args));
    }
    if (candidates.length !== 1) return null; // none, or ambiguous: never pair by position
    this.items.splice(this.items.indexOf(candidates[0]!), 1);
    return candidates[0]!.id;
  }

  clear(): void {
    this.items = [];
    this.orphans = [];
  }
}

function sameArguments(raw: unknown, args: unknown): boolean {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return dumps(toPlain(parsed)) === dumps(toPlain(args));
  } catch {
    return false;
  }
}

export const PENDING = new PendingCalls();

export function registerToolCalls(
  obs: Observation,
  calls: readonly { id?: string; name?: string; arguments?: unknown }[],
): void {
  if (!calls.length || !obs.span) return;
  guard("registerToolCalls", () => PENDING.add(calls, obs.span!.traceId, obs.conversationId), undefined);
}

/** The current root saw a `previous_response_id`: the turn is grouped by the response chain. */
export function noteResponseChain(): void {
  const root = currentStore().root;
  if (root) root.responseChain = true;
}

// ---------------------------------------------------------------------------- Observation

/** Handle to an open span. Every method is safe: it never throws into the app. */
export class Observation {
  /** @internal */ readonly span: Span | null;
  readonly kind: string;
  readonly isRoot: boolean;
  /** @internal */ responseChain = false;
  /** @internal */ inherited = false;
  /** @internal */ readonly conversationId: string | null;
  private metadata: Record<string, unknown> = {};

  /** @internal */
  constructor(span: Span | null, kind: string, isRoot = false, conversationId: string | null = null) {
    this.span = span;
    this.kind = kind;
    this.isRoot = isRoot;
    this.conversationId = conversationId;
  }

  get traceId(): string {
    return this.span?.traceId ?? "";
  }

  get spanId(): string {
    return this.span?.spanId ?? "";
  }

  setInput(value: unknown): void {
    guard("setInput", () => setContent(this, this.kind === "tool" ? "gen_ai.tool.call.arguments" : INPUT, value), undefined);
  }

  setOutput(value: unknown): void {
    guard("setOutput", () => setContent(this, this.kind === "tool" ? "gen_ai.tool.call.result" : OUTPUT, value), undefined);
  }

  setMetadata(metadata: Record<string, unknown>): void {
    guard("setMetadata", () => {
      if (!this.span) return;
      Object.assign(this.metadata, metadata);
      setMetadataAttr(this.span, this.metadata);
    }, undefined);
  }

  setUser(userId: Id | null | undefined): void {
    guard("setUser", () => {
      if (userId === null || userId === undefined || !this.span) return;
      this.span.setAttribute(USER_ID, String(userId));
      this.span.setAttribute("user.id", String(userId));
    }, undefined);
  }

  setTags(tags: Iterable<unknown>): void {
    guard("setTags", () => {
      if (!this.span) return;
      const existing = this.span.attributes[TAGS];
      const merged = cleanTags([...(Array.isArray(existing) ? existing : []), ...tags]);
      if (merged.length) this.span.setAttribute(TAGS, merged);
    }, undefined);
  }

  setAttribute(key: string, value: AttrValue): void {
    guard("setAttribute", () => this.span?.setAttribute(key, value), undefined);
  }

  setError(error: unknown): void {
    guard("setError", () => {
      if (!this.span) return;
      if (error instanceof Error) recordError(this.span, error);
      else this.span.setError(String(error).slice(0, 32768));
    }, undefined);
  }

  update(fields: { output?: unknown; metadata?: Record<string, unknown>; userId?: Id; tags?: Iterable<unknown> }): void {
    if (fields.output !== undefined && fields.output !== null) this.setOutput(fields.output);
    if (fields.metadata) this.setMetadata(fields.metadata);
    if (fields.userId !== undefined && fields.userId !== null) this.setUser(fields.userId);
    if (fields.tags) this.setTags(fields.tags);
  }
}

const NOOP = (): Observation => new Observation(null, "noop");

// ---------------------------------------------------------------------------- span scopes

interface SpanSpec {
  kind: "turn" | "trace" | "step" | "tool";
  name?: string;
  input?: unknown;
  userId?: Id;
  tags?: string[];
  metadata?: Record<string, unknown>;
  callId?: string;
  arguments?: unknown;
  captureInput?: boolean;
  obsType?: string;
}

interface Started {
  /** Set for a tool with no explicit call id: what to claim again when the tool ends. */
  claim?: { name: string; args: unknown };
  /** Roots only: releases the open-turn count `flush()` waits on. */
  release?: () => void;
  obs: Observation;
  store: Store;
  span: Span;
}

function groupingOf(obs: Observation): string {
  if (obs.conversationId !== null) return "explicit";
  if (obs.inherited) return "inherited";
  if (obs.responseChain) return "response_chain";
  if (obs.kind === "trace") return "not_chat";
  addCount("ungroupedTurns");
  if (!getAls()) noAlsNotice();
  else {
    logOnce(
      "ungrouped-turn",
      "zoroval: turn() ran outside conversation(); each such turn becomes its own trace (ungrouped). " +
        "Wrap the chat handler in zoroval.conversation(chatId, ...).",
    );
  }
  return "ungrouped";
}

function startSpan(spec: SpanSpec): Started | null {
  const state = getState();
  if (!state) return null;
  const store = currentStore();
  const scope = store.conversation;
  const kind = spec.kind === "trace" && scope ? "turn" : spec.kind;
  let name = spec.name || kind;
  const isRoot = kind === "turn" || kind === "trace";
  const attrs: Record<string, AttrValue> = { [OBS_TYPE]: spec.obsType ?? kind };
  Object.assign(attrs, conversationAttributes(store));
  if (isRoot) Object.assign(attrs, rootAttributes(spec.userId, spec.tags, store));
  if (kind === "tool") {
    attrs["gen_ai.operation.name"] = "execute_tool";
    attrs["gen_ai.tool.name"] = name;
    attrs["gen_ai.tool.type"] = "function";
    name = `execute_tool ${name}`;
  }
  const span = new Span(name, KIND_INTERNAL, store.span, attrs);
  const obs = new Observation(span, kind, isRoot, scope?.id ?? null);
  let claim: Started["claim"];
  if (isRoot) obs.inherited = scope === null && GEN_AI_CONVERSATION_ID in attrs;
  const metadata = isRoot ? { ...(scope?.metadata ?? {}), ...(spec.metadata ?? {}) } : spec.metadata;
  if (metadata && Object.keys(metadata).length) obs.setMetadata(metadata);
  if (kind === "tool") {
    const callId = spec.callId ?? PENDING.claim(spec.name ?? "", spec.arguments, span.traceId, scope?.id ?? null);
    if (callId) span.setAttribute("gen_ai.tool.call.id", String(callId));
    else if (spec.callId === undefined) claim = { name: spec.name ?? "", args: spec.arguments };
    if (spec.captureInput !== false && spec.arguments !== undefined && spec.arguments !== null) {
      setContent(obs, "gen_ai.tool.call.arguments", spec.arguments);
    }
  } else if (spec.captureInput !== false && spec.input !== undefined && spec.input !== null) {
    setContent(obs, INPUT, spec.input);
  }
  const release = isRoot ? holdOpen(state.processor, OPEN_ROOT_MS) : undefined;
  return { obs, span, claim, release, store: { conversation: scope, root: isRoot ? obs : store.root, span, test: store.test } };
}

function finishSpan(started: Started, error: unknown, failed: boolean): void {
  const { span, obs } = started;
  try {
    if (failed) recordError(span, error);
    // A streamed reply registers its tool calls when it ends, which can be after the tool started or ended.
    if (obs.kind === "tool" && !("gen_ai.tool.call.id" in span.attributes) && started.claim) {
      const { name, args } = started.claim;
      const callId = PENDING.claim(name, args, span.traceId, obs.conversationId);
      if (callId) span.setAttribute("gen_ai.tool.call.id", String(callId));
      else PENDING.orphan(span, name, args, span.traceId, obs.conversationId);
    }
    if (obs.isRoot) span.setAttribute(GROUPING, groupingOf(obs));
    if (span.end()) getState()?.processor.onEnd(span);
  } catch (inner) {
    internalError(`${obs.kind}.end`, inner);
  } finally {
    started.release?.();
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}

/** Run `fn` inside a new span. The callback's own result and errors pass through unchanged. */
function runSpan<T>(spec: SpanSpec, fn: (obs: Observation) => T): T {
  let started: Started | null = null;
  try {
    started = startSpan(spec);
  } catch (error) {
    internalError(`${spec.kind}.start`, error);
  }
  if (!started) return fn(NOOP());
  const active = started;
  const scoped = getAls();
  if (!scoped && spec.kind !== "step" && spec.kind !== "tool") noAlsNotice();
  let result: T;
  try {
    result = scoped ? scoped.run(active.store, () => fn(active.obs)) : fn(active.obs);
  } catch (error) {
    finishSpan(active, error, true);
    throw error;
  }
  if (isThenable(result)) {
    // The app gets its own promise back (an SDK's promise subclass keeps its methods); the span ends
    // on the side. That side never rethrows: the app handles its own rejection, or Node reports it once.
    try {
      result.then(
        () => finishSpan(active, null, false),
        (error) => finishSpan(active, error, true),
      );
    } catch (error) {
      finishSpan(active, error, true);
    }
    return result;
  }
  finishSpan(active, null, false);
  return result;
}

// ---------------------------------------------------------------------------- generations

/** How long a generation that never ended (a stream nobody read) keeps flush() waiting. */
const OPEN_GENERATION_MS = 300_000;
const OPEN_ROOT_MS = 60_000;

/**
 * A turn, trace or generation is open until it ends; `flush()` waits (bounded) for open ones, and a
 * `withZoroval` flush for those of its own request. Work that never ends must not be waited for
 * ever, so the count is released by a timer too. Returns the release.
 */
function holdOpen(processor: Processor, maxMs: number): () => void {
  processor.rootStarted();
  const scope = getScopeAls()?.getStore();
  if (scope) scope.open += 1;
  let open = true;
  const timer = setTimeout(() => release(), maxMs);
  (timer as { unref?: () => void }).unref?.();
  const release = () => {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    if (scope) scope.open = Math.max(0, scope.open - 1);
    guard("rootEnded", () => processor.rootEnded(), undefined);
  };
  return release;
}

export interface GenerationHandle {
  readonly obs: Observation;
  readonly span: Span;
  /** Run `fn` with this span current, so the provider's own work and nested calls see it. */
  run<T>(fn: () => T): T;
  end(): void;
}

/**
 * Open a generation span (one LLM call) under the current span; null when there is nothing to record:
 * the SDK is off, or a generation is already open here (`wrapOpenAI` and `wrapFetch` together, or
 * `parse()` calling `create()`), which is Python's "no duplicate span" rule.
 *
 * Every generation counts as open work for flush(), like a root: a streamed reply can end after its
 * turn has returned the `Response`. `base` is written first and `request` last, as in Python.
 */
export function startGeneration(
  name: string, base: Record<string, AttrValue>, request: Record<string, AttrValue>,
): GenerationHandle | null {
  const state = getState();
  if (!state) return null;
  const store = currentStore();
  const parent = store.span;
  if (parent && !parent.ended && parent.attributes[OBS_TYPE] === "generation") return null;
  const attrs: Record<string, AttrValue> = { ...base, [OBS_TYPE]: "generation", ...conversationAttributes(store) };
  if (!parent) Object.assign(attrs, rootAttributes(undefined, undefined, store));
  Object.assign(attrs, request);
  const span = new Span(name, KIND_CLIENT, parent, attrs);
  const obs = new Observation(span, "generation", false, store.conversation?.id ?? null);
  const processor = state.processor;
  const release = holdOpen(processor, OPEN_GENERATION_MS);
  const inner: Store = { ...store, span };
  const scoped = getAls();
  return {
    obs,
    span,
    run: (fn) => (scoped ? scoped.run(inner, fn) : fn()),
    end() {
      try {
        if (span.end()) processor.onEnd(span);
      } catch (error) {
        internalError("generation.end", error);
      } finally {
        release();
      }
    },
  };
}

// ---------------------------------------------------------------------------- public functions

/**
 * Group every turn inside `fn` into one conversation (one Zoroval trace).
 *
 *     zoroval.conversation(chatId, { userId }, () => zoroval.turn({ input }, async (turn) => { ... }))
 *
 * Makes no span itself. Returns what `fn` returns.
 */
export function conversation<T>(id: unknown, fn: () => T): T;
export function conversation<T>(id: unknown, options: ConversationOptions, fn: () => T): T;
export function conversation<T>(id: unknown, a: ConversationOptions | (() => T), b?: () => T): T {
  const fn = (typeof a === "function" ? a : b) as () => T;
  const options = (typeof a === "function" ? {} : a) ?? {};
  const scoped = getAls();
  let store: Store | null = null;
  try {
    const normalized = normalizeConversationId(id);
    if (normalized === null) {
      logOnce("conversation-empty", "zoroval: conversation() got an empty id; turns stay ungrouped.");
    } else if (!scoped) {
      noAlsNotice();
    } else {
      const scope: ConversationScope = {
        id: normalized,
        userId: options.userId === undefined || options.userId === null ? null : String(options.userId),
        tags: cleanTags(options.tags),
        metadata: { ...(options.metadata ?? {}) },
      };
      store = { ...currentStore(), conversation: scope };
    }
  } catch (error) {
    internalError("conversation", error);
  }
  return store && scoped ? scoped.run(store, fn) : fn();
}

function splitArgs<O extends object, T>(
  a: unknown, b: unknown,
): { options: O; fn: (obs: Observation) => T } {
  if (typeof a === "function") return { options: {} as O, fn: a as (obs: Observation) => T };
  return { options: ((typeof a === "string" ? { name: a } : a) ?? {}) as O, fn: b as (obs: Observation) => T };
}

/** The root span of one user turn. Use inside conversation(). */
export function turn<T>(fn: (turn: Observation) => T): T;
export function turn<T>(options: TurnOptions, fn: (turn: Observation) => T): T;
export function turn<T>(a: TurnOptions | ((turn: Observation) => T), b?: (turn: Observation) => T): T {
  const { options, fn } = splitArgs<TurnOptions, T>(a, b);
  return runSpan({ kind: "turn", ...options }, fn);
}

/** The root span of one run (agent or batch job). Inside conversation() it acts as a turn. */
export function trace<T>(fn: (trace: Observation) => T): T;
export function trace<T>(nameOrOptions: string | TurnOptions, fn: (trace: Observation) => T): T;
export function trace<T>(a: string | TurnOptions | ((trace: Observation) => T), b?: (trace: Observation) => T): T {
  const { options, fn } = splitArgs<TurnOptions, T>(a, b);
  return runSpan({ kind: "trace", ...options }, fn);
}

/** A custom step. */
export function step<T>(name: string, fn: (step: Observation) => T): T;
export function step<T>(name: string, options: StepOptions, fn: (step: Observation) => T): T;
export function step<T>(name: string, a: StepOptions | ((step: Observation) => T), b?: (step: Observation) => T): T {
  const fn = (typeof a === "function" ? a : b) as (step: Observation) => T;
  const options = (typeof a === "function" ? {} : a) ?? {};
  const type = options.type === "chain" || options.type === "agent" ? options.type : "step";
  return runSpan({ kind: "step", name, input: options.input, metadata: options.metadata, captureInput: options.captureInput, obsType: type }, fn);
}

/**
 * A tool run, linked to the model's tool-call id.
 *
 * The id is `callId` when given; otherwise the one pending call of the same name (and the same
 * arguments, if several) in this trace or conversation. Ambiguous calls stay unlinked.
 */
export function tool<T>(name: string, fn: (tool: Observation) => T): T;
export function tool<T>(name: string, options: ToolOptions, fn: (tool: Observation) => T): T;
export function tool<T>(name: string, a: ToolOptions | ((tool: Observation) => T), b?: (tool: Observation) => T): T {
  const fn = (typeof a === "function" ? a : b) as (tool: Observation) => T;
  const options = (typeof a === "function" ? {} : a) ?? {};
  return runSpan({ kind: "tool", name, ...options }, fn);
}

type Target = Observation | ConversationScope | null;

function target(): Target {
  const store = currentStore();
  return store.root ?? store.conversation;
}

/** Set the user id on the current turn or trace, or on the current conversation. */
export function setUser(userId: Id | null | undefined): void {
  guard("setUser", () => {
    const t = target();
    if (t instanceof Observation) t.setUser(userId);
    else if (t) t.userId = userId === null || userId === undefined ? null : String(userId);
  }, undefined);
}

export function setTags(...tags: (string | string[])[]): void {
  guard("setTags", () => {
    const flat = tags.flat();
    const t = target();
    if (t instanceof Observation) t.setTags(flat);
    else if (t) t.tags = cleanTags([...t.tags, ...flat]);
  }, undefined);
}

export function setMetadata(metadata: Record<string, unknown>): void {
  guard("setMetadata", () => {
    const t = target();
    if (t instanceof Observation) t.setMetadata(metadata);
    else if (t) Object.assign(t.metadata, metadata);
  }, undefined);
}

/** The innermost turn or trace handle, or a no-op handle. */
export function currentObservation(): Observation {
  return currentStore().root ?? NOOP();
}

/** Marks root spans with zoroval.test=true (a real boolean). Used by `zoroval doctor` only. */
export function withTestMode<T>(fn: () => T): T {
  const scoped = getAls();
  return scoped ? scoped.run({ ...currentStore(), test: true }, fn) : fn();
}
