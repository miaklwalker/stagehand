import type { StandardSchemaV1 } from "@standard-schema/spec";

export type Awaitable<T> = T | Promise<T>;

/** Flattens intersections so hover tooltips show a real object shape. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Context after a step contributes `Out`. A step that returns nothing leaves
 * the context untouched; later keys win over earlier ones.
 */
export type Merge<Ctx, Out> = [Out] extends [void]
  ? Ctx
  : [Out] extends [undefined]
    ? Ctx
    : Prettify<Omit<Ctx, keyof Out> & Out>;

/**
 * Context with `Keys` dropped — what `clean` leaves behind for later steps.
 */
export type Cleaned<Ctx, Keys extends PropertyKey> = Prettify<Omit<Ctx, Keys>>;

/**
 * The slice of the context a `rollback` sees: exactly the keys it asked for
 * via `rollbackKeys`, and nothing else. With no keys declared it is `{}` — a
 * rollback has to say what it needs.
 */
export type RollbackData<Ctx, Keys extends readonly PropertyKey[]> = Pick<
  Ctx,
  Extract<Keys[number], keyof Ctx>
>;

/**
 * The optional `clean` field, mixed into a step definition by `addStep`.
 *
 * `Keys` captures the literal tuple so the caller's context type can be
 * narrowed by exactly the keys listed. The value is checked element-wise — a
 * valid key checks against itself, an invalid one against the union of valid
 * keys — so only the offending entry is flagged and the editor still
 * autocompletes. `Reserved` holds the keys earlier `rollbackKeys` declarations
 * locked down; they are excluded from the valid set.
 */
export type CleanField<
  Ctx,
  Reserved extends PropertyKey,
  Keys extends readonly PropertyKey[],
> = {
  /**
   * Keys of the incoming context this step is done with. They are deleted from
   * the context once the step settles and disappear from the type every later
   * step sees.
   */
  clean?: {
    [I in keyof Keys]: Keys[I] extends Exclude<keyof Ctx, Reserved>
      ? Keys[I]
      : Exclude<keyof Ctx, Reserved>;
  };
};

export type StepStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "cached"
  | "rolling-back"
  | "rolled-back"
  | "rollback-failed";

export type PhaseStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cached";

export type RunStatus = "pending" | "running" | "success" | "failed" | "aborted";

/**
 * Where `log`/`info`/`warn`/`error`/`success` land in the live terminal.
 *
 * - `"scrollback"` (default): a permanent line above the frame — the complete
 *   record, in order, for the whole run.
 * - `"step"`: nested under the step that logged it, alongside its tasks and
 *   progress bar. Keeps only the most recent few per step.
 * - `"bottom"`: a rolling tail of the most recent lines across the whole run,
 *   shown below the phase tree.
 *
 * `"step"` and `"bottom"` trade completeness for locality — both cap what
 * they keep, so reach for `"scrollback"` when the log is the thing you need
 * to still have after the run. Only the live renderer honors this; the
 * plain/CI renderer prints every line immediately as it happens regardless,
 * which is already both complete and in place.
 */
export type LogPlacement = "scrollback" | "step" | "bottom";

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

/** One stored result, as it sits in a {@link CacheStore}. */
export interface CachedEntry {
  /** What the phase contributed, or what the step returned. */
  value: unknown;
  /** Wall-clock ms (`Date.now()`) at the moment it was written. */
  savedAt: number;
}

/**
 * Where cached values live. The three methods are all a store has to do — a
 * Redis or S3 backing is a dozen lines.
 *
 * `slot` identifies which phase or step an entry belongs to and is derived
 * from its name; scripts never write it. It exists so that several phases can
 * point at one store without overwriting each other.
 */
export interface CacheStore {
  read(slot: string): Awaitable<CachedEntry | undefined>;
  write(slot: string, entry: CachedEntry): Awaitable<void>;
  clear(slot: string): Awaitable<void>;
}

/** What `stale` gets to decide on. */
export interface StaleContext<In, Ctx> {
  /** The stored value — the phase's context delta, or the step's return value. */
  value: unknown;
  input: In;
  /** The live context as it stands right now, *before* the entry is applied. */
  ctx: Ctx;
  /** Wall-clock ms at which the entry was written. */
  savedAt: number;
  /** How old the entry is, in ms. A TTL is `({ ageMs }) => ageMs > 3_600_000`. */
  ageMs: number;
}

/**
 * Caching for a phase or a step. Pass a bare {@link CacheStore} when the
 * defaults are enough, or this object to say when an entry stops being good.
 *
 * There is no key: the store *is* the identity. Whether an entry is still
 * usable is `stale`'s job, and nothing else's.
 */
export interface CacheOptions<In = unknown, Ctx = unknown, Value = unknown> {
  store: CacheStore;
  /**
   * Return true to treat the stored entry as a miss — the work runs again and
   * the entry is overwritten. Given `value` as `unknown`; annotate the
   * parameter yourself, or hand over a `schema` and let it do the narrowing.
   */
  stale?: (context: StaleContext<In, Ctx>) => Awaitable<boolean>;
  /**
   * Checked against the stored value on every read. A stored value that no
   * longer fits is a **miss**, not an error — which is what keeps a cache
   * written by an older version of the script from feeding the wrong shape
   * into the context.
   */
  schema?: StandardSchemaV1<unknown, Value>;
}

export type CacheSource<In = unknown, Ctx = unknown, Value = unknown> =
  | CacheStore
  | CacheOptions<In, Ctx, Value>;

/**
 * The value type a slot reads back as.
 *
 * A declared `schema` wins: it is the only thing actually *checked* against
 * what came off the disk. With no schema the phase's own delta stands in —
 * convenient, and right until an entry written by an older version of the
 * script outlives the code that wrote it. That gap is what the shape guard on
 * `read` exists to catch at the moment you touch a missing field.
 */
export type SlotValue<Schema, Delta> = unknown extends Schema ? Delta : Schema;

/**
 * Stand-in for a step that cannot know the host's slots — one written with
 * {@link stepFor}, or a hand-written {@link StepDef}. Every name is accepted
 * and values read back as `unknown`.
 *
 * The alternative default, `{}`, makes `keyof Slots & string` resolve to
 * `never` and quietly renders the whole handle uncallable, which reads as
 * "the cache is missing" rather than "this step never declared its slots".
 * Pass the slots explicitly to get them checked.
 */
export type UnknownSlots = Record<string, unknown>;

/**
 * Stand-in for a step that cannot know the host's declared flags — same
 * reasoning as {@link UnknownSlots}: `Record<string, unknown>` accepts any
 * key, which is what lets a `stepFor` step read `context.flags` without
 * knowing the specific script it will end up in.
 */
export type UnknownFlags = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

export interface BaseFlagOptions<Name extends string = string> {
  /** The property key on `context.flags`, and (kebab-cased) the default `--` form. */
  name: Name;
  /** Override the long `--` flag when it should differ from `name`. */
  long?: string;
  /** A single-letter `-` alias. */
  short?: string;
  description?: string;
}

export interface BooleanFlagOptions<Name extends string = string> extends BaseFlagOptions<Name> {
  boolean: true;
  /** What the flag resolves to when absent from argv. Default `false`. */
  default?: boolean;
}

export interface StringFlagOptions<
  Name extends string = string,
  Default extends string | undefined = undefined,
> extends BaseFlagOptions<Name> {
  boolean?: false;
  default?: Default;
}

/**
 * `context.cache`, typed to the slots declared *before* this step.
 *
 * Invalidation flows backwards — a later step throwing away an earlier phase's
 * entry — so only already-declared slots are addressable, which falls out of
 * builder order for free. With no cached phases anywhere the slot type is
 * `never` and every method is uncallable.
 */
export interface CacheHandle<Slots> {
  /**
   * The stored value, or `undefined` on a miss.
   *
   * Unless the slot declared a `schema`, the value is wrapped in a guard that
   * throws {@link CacheShapeError} the moment you read a field the stored
   * object does not have — which is how a cache written before a refactor
   * announces itself instead of quietly yielding `undefined`. Pass
   * `{ raw: true }` to opt out; do that before putting the value in the
   * context, since the guard would otherwise travel with it into later steps.
   */
  read<K extends keyof Slots & string>(
    slot: K,
    options?: { raw?: boolean },
  ): Promise<Slots[K] | undefined>;
  /**
   * Replace a slot outright. Values are not type-checked on the way in.
   *
   * The entry is restamped as written *now* unless `keepAge` is set. Reach for
   * `keepAge` when correcting a value rather than refreshing it: a patch that
   * resets the clock silently buys another full TTL for data that is still as
   * old as it ever was — which matters most when the cache exists to stay
   * inside someone's rate limit.
   */
  write<K extends keyof Slots & string>(
    slot: K,
    value: unknown,
    options?: { keepAge?: boolean },
  ): Promise<void>;
  /** Drop a slot, so the next run does the work again. */
  clear(slot: keyof Slots & string): Promise<void>;
  /** Age of a slot's entry in ms, or `undefined` if there isn't one. */
  ageOf(slot: keyof Slots & string): Promise<number | undefined>;
}

/**
 * What `run` is allowed to do with the caches this script declares.
 *
 * - `"on"` (default): read and write.
 * - `"off"`: ignore them entirely — nothing is read, nothing is written.
 * - `"refresh"`: run everything, then overwrite every entry.
 * - `"read-only"`: use hits, but never write.
 */
export type CacheMode = "on" | "off" | "refresh" | "read-only";

/* -------------------------------------------------------------------------- */
/* Handler-facing UI surface                                                   */
/* -------------------------------------------------------------------------- */

export interface ProgressHandle {
  /** Set the absolute value, optionally relabeling the bar. */
  update(value: number, label?: string): void;
  /** Advance by `by` (default 1). */
  increment(by?: number): void;
  setTotal(total: number): void;
  setLabel(label: string): void;
  /** Fill the bar and stop showing it as in-flight. */
  done(): void;
  readonly value: number;
  readonly total: number;
}

export interface TaskHandle {
  /** Move a pending task into the running state (spinner). */
  start(text?: string): void;
  /** Rename the task in place. */
  label(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  skip(text?: string): void;
}

export interface TaskListHandle<K extends string> {
  readonly tasks: Record<K, TaskHandle>;
  get(key: K): TaskHandle;
}

export interface TextPromptOptions {
  message: string;
  /** Used verbatim when stdin isn't interactive, and preselects the field when it is. */
  default?: string;
  placeholder?: string;
  /** Return `true` to accept the value, or a message to show and keep prompting. */
  validate?: (value: string) => Awaitable<string | true>;
  /** Render input as `•` — for a value sensitive enough that it shouldn't be echoed. */
  mask?: boolean;
}

export interface ConfirmPromptOptions {
  message: string;
  default?: boolean;
}

export interface PromptChoice<Value> {
  label: string;
  value: Value;
  hint?: string;
}

export interface SelectPromptOptions<Value> {
  message: string;
  choices: readonly PromptChoice<Value>[];
  default?: Value;
}

export interface MultiSelectPromptOptions<Value> {
  message: string;
  choices: readonly PromptChoice<Value>[];
  default?: readonly Value[];
  /** Keep prompting until at least this many are selected. */
  min?: number;
  /** Keep prompting if more than this many are selected. */
  max?: number;
}

/**
 * Ask the person running the script something, mid-step. Every method
 * suspends the live frame, reads from stdin, and repaints once it has an
 * answer.
 *
 * On a non-interactive stdin (CI, a pipe, a subprocess) nothing is drawn:
 * `default` is returned immediately, and a call with no `default` throws
 * {@link PromptUnavailableError} rather than hanging on a stream nothing will
 * ever write to.
 *
 * Ctrl-C while a prompt is open throws {@link PromptCancelledError}, which
 * `isAbort` recognizes — the run unwinds exactly as it would for a SIGINT.
 */
export interface PromptHandle {
  text(options: TextPromptOptions): Promise<string>;
  confirm(options: ConfirmPromptOptions): Promise<boolean>;
  select<Value>(options: SelectPromptOptions<Value>): Promise<Value>;
  multiselect<Value>(options: MultiSelectPromptOptions<Value>): Promise<Value[]>;
}

/** Everything a handler gets: accumulated data plus the live terminal. */
export interface StepContext<In, Ctx, Slots = UnknownSlots, Flags = UnknownFlags> {
  /** The input the script was run with. */
  readonly input: In;
  /** Data produced by every step that has already succeeded. */
  readonly ctx: Ctx;
  /** Aborts on timeout, on Ctrl-C, or when `run` is canceled. */
  readonly signal: AbortSignal;
  /** 1 on the first try, 2 on the first retry, and so on. */
  readonly attempt: number;
  readonly phase: string;
  readonly step: string;

  /** Where these land is controlled by `logPlacement` (default: a permanent line above the live frame, kept in scrollback). */
  log(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;

  /** Transient one-liner shown beside the step. Replaced on each call. */
  status(message: string): void;

  /**
   * Annotate the step's title — `query database (400 rows found)`. Unlike
   * `status`, it survives the step finishing, so it is what to use for the
   * one fact worth reading off the finished line. Replaced on each call;
   * pass `""` to remove it.
   */
  note(message: string): void;

  /** Attach a progress bar to this step. */
  progress(options: { total: number; label?: string; value?: number }): ProgressHandle;

  /** Attach a single checklist item nested under this step. */
  task(label: string): TaskHandle;

  /** Attach a whole checklist at once, keyed for typed lookup. */
  tasks<const K extends readonly string[]>(labels: K): TaskListHandle<K[number]>;

  /**
   * Read, replace or drop the entries of cached phases declared earlier in
   * this script. See {@link CacheHandle}.
   */
  readonly cache: CacheHandle<Slots>;

  /**
   * Ask the person running the script something, mid-step — free text,
   * yes/no, a single choice, or several. See {@link PromptHandle}.
   */
  readonly prompt: PromptHandle;

  /**
   * Values parsed off the command line for every `defineFlag` this script
   * declared, keyed by each flag's `name`. Parsed once, before any phase
   * executes; see {@link BooleanFlagOptions} / {@link StringFlagOptions}.
   */
  readonly flags: Flags;
}

export interface RollbackContext<In, Ctx, Out, Slots = UnknownSlots, Flags = UnknownFlags> {
  readonly input: In;
  /**
   * Only the keys this step declared in `rollbackKeys`, as they stood when the
   * failure happened. Empty when none were declared.
   */
  readonly ctx: Ctx;
  /** Exactly what this step's handler returned. */
  readonly output: Out;
  /** The error that triggered the unwind. */
  readonly error: unknown;
  readonly signal: AbortSignal;
  readonly phase: string;
  readonly step: string;

  /** Where these land is controlled by `logPlacement`, as in a handler. */
  log(message: string): void;
  status(message: string): void;
  /** Annotate the step's title, as in a handler. Replaces whatever it set. */
  note(message: string): void;
  progress(options: { total: number; label?: string; value?: number }): ProgressHandle;

  /** Undoing work usually means the entry describing it is wrong too. */
  readonly cache: CacheHandle<Slots>;

  /** Same as on a handler's context — see {@link StepContext.flags}. */
  readonly flags: Flags;
}

/* -------------------------------------------------------------------------- */
/* Definitions                                                                 */
/* -------------------------------------------------------------------------- */

export interface RetryPolicy {
  attempts: number;
  /** Fixed delay in ms, or a function of the attempt just failed (1-based). */
  delayMs?: number | ((attempt: number) => number);
  /** Return false to stop retrying this particular error. */
  retryIf?: (error: unknown, attempt: number) => boolean;
}

export interface StepDef<
  In,
  Ctx,
  Out,
  RollbackKeys extends readonly PropertyKey[] = readonly [],
  Slots = UnknownSlots,
  Flags = UnknownFlags,
> {
  name: string;
  description?: string;
  /**
   * The work. Whatever object it resolves to is merged into `ctx` and becomes
   * visible — and typed — for every later step.
   */
  handler: (context: StepContext<In, Ctx, Slots, Flags>) => Awaitable<Out>;
  /**
   * The context keys this step's `rollback` needs. It receives only these
   * (none by default), and declaring them reserves them: neither this step nor
   * any later one may `clean` them away, so they are guaranteed to still be
   * there if the rollback runs.
   *
   * `output` is unaffected — a rollback always gets its own step's return
   * value in full, just it was cleaned from the context.
   */
  rollbackKeys?: RollbackKeys & readonly (keyof Merge<Ctx, Out>)[];
  /**
   * Compensation. Runs when a *later* step fails, in reverse order, after this
   * step has already succeeded.
   */
  rollback?: (
    context: RollbackContext<
      In,
      Prettify<RollbackData<Merge<Ctx, Out>, RollbackKeys>>,
      Out,
      Slots,
      Flags
    >,
  ) => Awaitable<void>;
  /** Skip the step (and its rollback) when this resolves falsy. */
  when?: (context: { input: In; ctx: Ctx }) => Awaitable<boolean>;
  /**
   * Reuse this step's return value from a previous run instead of running the
   * handler. On a hit the stored value is merged into the context exactly as
   * if the handler had produced it — and, since the step never ran, its
   * `rollback` cannot fire during a later unwind. That is deliberate: the side
   * effect belongs to the earlier run and was never undone.
   *
   * ```ts
   * cache: { store: fileStore("./cache.json"), stale: ({ ageMs }) => ageMs > 60_000 }
   * ```
   */
  cache?: CacheSource<In, Ctx>;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

/**
 * The same step definition as {@link StepDef}, for the case where every
 * `rollbackKeys` entry names a key the incoming context *already* has —
 * something an earlier step produced, not something this one returns.
 *
 * The only difference is that `rollbackKeys` is plain `RollbackKeys` here
 * rather than `RollbackKeys & readonly (keyof Merge<Ctx, Out>)[]`, and that is
 * the whole fix. In `StepDef`, `Out` is inferred from three sibling properties
 * of one object literal at once — and `handler`, the only one that knows the
 * answer, is inferred *last*, because a handler with a destructured parameter
 * is context-sensitive and so deferred to inference's second pass. Whichever
 * of `rollbackKeys` and `rollback` TypeScript reaches first settles `Out` on
 * its own: `rollbackKeys: ["k"]` reverse-infers `{ k: any }` out of
 * `keyof Merge<Ctx, Out>`, and `rollback` feeds back whatever provisional
 * `Out` it happened to be contextually typed with. Either candidate then
 * collides with a handler resolving `Promise<void>`, which is the
 * `TS2769: No overload matches this call` on a step that returns nothing while
 * naming a key an earlier step produced.
 *
 * Dropping `Out` from `rollbackKeys` leaves `handler` as its only inference
 * site. `rollbackKeys` stays checked — against `keyof Ctx`, through the
 * *constraint* on `addStep`'s `RollbackKeys` parameter, which is concrete and
 * so cannot drag `Out` anywhere. A step naming one of its own output keys
 * fails that constraint on the spot, in inference's first pass and before any
 * context-sensitive property is typed, and falls through to the `StepDef`
 * overload with nothing left behind.
 *
 * `Out` defaults to `void` rather than falling back to its constraint, which
 * is what a `rollback` declared *above* its own `handler` resolves it to while
 * the handler is still pending — the right answer for a step that returns
 * nothing, and harmlessly replaced by the handler's own candidate otherwise.
 */
export interface InheritedKeyStepDef<
  In,
  Ctx,
  Out,
  RollbackKeys extends readonly PropertyKey[] = readonly [],
  Slots = UnknownSlots,
  Flags = UnknownFlags,
> {
  name: string;
  description?: string;
  /** See {@link StepDef.handler}. */
  handler: (context: StepContext<In, Ctx, Slots, Flags>) => Awaitable<Out>;
  /**
   * The context keys this step's `rollback` needs, all of them inherited from
   * an earlier step. Checked against `keyof Ctx` by `addStep`'s constraint.
   */
  rollbackKeys?: RollbackKeys;
  /** See {@link StepDef.rollback}. */
  rollback?: (
    context: RollbackContext<
      In,
      Prettify<RollbackData<Merge<Ctx, Out>, RollbackKeys>>,
      Out,
      Slots,
      Flags
    >,
  ) => Awaitable<void>;
  /** See {@link StepDef.when}. */
  when?: (context: { input: In; ctx: Ctx }) => Awaitable<boolean>;
  /** See {@link StepDef.cache}. */
  cache?: CacheSource<In, Ctx>;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

/**
 * The context a later step sees, given a step that ran before it and whatever
 * else is already there. Spares you from restating a step's return shape by
 * hand just to declare the next step's `Ctx`.
 *
 * ```ts
 * export const logIntoDb = stepFor<Input>()({
 *   name: "log into db",
 *   handler: async () => ({ conn: await connect() }),
 * });
 *
 * export const loadRules = stepFor<
 *   Input,
 *   WithStepFor<typeof logIntoDb, { conditions: Array<{ name: string }> }>
 * >()({
 *   name: "load rules",
 *   //     ctx.conn — from the step; ctx.conditions — from the rest
 *   handler: ({ ctx }) => ({ rules: ctx.conn.query(ctx.conditions) }),
 * });
 * ```
 *
 * It nests, so a chain of steps composes without a separate variadic form:
 *
 * ```ts
 * WithStepFor<typeof second, WithStepFor<typeof first, { conditions: string[] }>>
 * ```
 *
 * Read that inside out — start with `conditions`, add what `first` returns,
 * then what `second` returns — which is also the precedence: on a name
 * collision the outermost step wins, matching the way a later step's return
 * value shadows an earlier key at runtime. Order the nesting to match the
 * order the steps actually run in and the two agree.
 *
 * Only the step's *output* is read. Its own `Ctx` requirement is not checked
 * against `Rest`, since the two are declared independently; `addStep` is still
 * where a step meeting an insufficient context is caught.
 *
 * A step returning nothing leaves `Rest` untouched, and an `async` handler is
 * awaited first, so both fall out without a special case.
 */
export type WithStepFor<
  // Structural on purpose: the handler's return type is the only place `Out`
  // sits covariantly. `StepDef` itself is invariant in `Out` — `rollback`
  // takes it as a parameter — so inferring off the interface would force the
  // caller's step to match an unsatisfiable bound.
  Step extends { handler: (context: never) => unknown },
  Rest extends object = {},
> = Step extends { handler: (context: never) => infer Out }
  ? Merge<Rest, Awaited<Out>>
  : never;

export interface PhaseOptions<In = unknown, Ctx = unknown> {
  description?: string;
  /** Skip every step in the phase when this resolves falsy. */
  when?: (context: { input: In; ctx: Ctx }) => Awaitable<boolean>;
  /**
   * Reuse this phase's work from a previous run. What gets stored is the
   * phase's **delta** — the keys its steps contributed to the context, minus
   * anything they cleaned — so a hit skips every step and merges that delta
   * over the live context, leaving keys from earlier phases alone.
   *
   * `stale` and `when` see the context as it stands when the phase is reached,
   * which is exactly `Ctx` here, so both are typed without any annotation.
   *
   * ```ts
   * .addPhase("Build", {
   *   cache: {
   *     store: fileStore("./cache.json"),
   *     stale: ({ ctx }) => ctx.sha !== lastBuiltSha,
   *   },
   * })
   * ```
   */
  cache?: CacheSource<In, Ctx>;
}

export interface ScriptOptions {
  name?: string;
  description?: string;
  /**
   * `all` (default) unwinds every completed step across the whole script.
   * `phase` unwinds only the phase that failed. `none` leaves state as-is.
   */
  rollback?: "all" | "phase" | "none";
  /** Throw instead of returning a failed result. Default false. */
  throwOnError?: boolean;
  /** Force the plain, non-animated renderer (useful in CI). Default: auto. */
  plain?: boolean;
  /** Suppress all output. */
  silent?: boolean;
  /** Rollback on SIGINT/SIGTERM. Default true. */
  handleSignals?: boolean;
  /** Where `log`/`info`/`warn`/`error`/`success` land. Default `"scrollback"`. */
  logPlacement?: LogPlacement;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export interface StepReport {
  phase: string;
  name: string;
  status: StepStatus;
  durationMs: number;
  attempts: number;
  error?: unknown;
}

export interface RollbackReport {
  phase: string;
  step: string;
  ok: boolean;
  error?: unknown;
}

export type RunResult<Ctx> =
  | {
      ok: true;
      status: "success";
      ctx: Prettify<Ctx>;
      durationMs: number;
      steps: StepReport[];
    }
  | {
      ok: false;
      status: "failed" | "aborted";
      error: unknown;
      failedAt: { phase: string; step: string } | null;
      /** Partial context: everything the steps that did succeed produced. */
      ctx: Partial<Prettify<Ctx>>;
      durationMs: number;
      steps: StepReport[];
      rollbacks: RollbackReport[];
    };
