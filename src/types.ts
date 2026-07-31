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
  | "rolling-back"
  | "rolled-back"
  | "rollback-failed";

export type PhaseStatus = "pending" | "running" | "success" | "failed" | "skipped";

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
 * to still have after the run. Only the live renderer honours this; the
 * plain/CI renderer prints every line immediately as it happens regardless,
 * which is already both complete and in place.
 */
export type LogPlacement = "scrollback" | "step" | "bottom";

/* -------------------------------------------------------------------------- */
/* Handler-facing UI surface                                                   */
/* -------------------------------------------------------------------------- */

export interface ProgressHandle {
  /** Set the absolute value, optionally relabelling the bar. */
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

/** Everything a handler gets: accumulated data plus the live terminal. */
export interface StepContext<In, Ctx> {
  /** The input the script was run with. */
  readonly input: In;
  /** Data produced by every step that has already succeeded. */
  readonly ctx: Ctx;
  /** Aborts on timeout, on Ctrl-C, or when `run` is cancelled. */
  readonly signal: AbortSignal;
  /** 1 on the first try, 2 on the first retry, and so on. */
  readonly attempt: number;
  readonly phase: string;
  readonly step: string;

  /** Where this lands is controlled by `logPlacement` (default: a permanent line above the live frame, kept in scrollback). */
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
}

export interface RollbackContext<In, Ctx, Out> {
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

  /** Where this lands is controlled by `logPlacement`, as in a handler. */
  log(message: string): void;
  status(message: string): void;
  /** Annotate the step's title, as in a handler. Replaces whatever it set. */
  note(message: string): void;
  progress(options: { total: number; label?: string; value?: number }): ProgressHandle;
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
> {
  name: string;
  description?: string;
  /**
   * The work. Whatever object it resolves to is merged into `ctx` and becomes
   * visible — and typed — for every later step.
   */
  handler: (context: StepContext<In, Ctx>) => Awaitable<Out>;
  /**
   * The context keys this step's `rollback` needs. It receives only these
   * (none by default), and declaring them reserves them: neither this step nor
   * any later one may `clean` them away, so they are guaranteed to still be
   * there if the rollback runs.
   *
   * `output` is unaffected — a rollback always gets its own step's return
   * value in full, whether or not it was cleaned from the context.
   */
  rollbackKeys?: RollbackKeys & readonly (keyof Merge<Ctx, Out>)[];
  /**
   * Compensation. Runs when a *later* step fails, in reverse order, after this
   * step has already succeeded.
   */
  rollback?: (
    context: RollbackContext<In, Prettify<RollbackData<Merge<Ctx, Out>, RollbackKeys>>, Out>,
  ) => Awaitable<void>;
  /** Skip the step (and its rollback) when this resolves falsy. */
  when?: (context: { input: In; ctx: Ctx }) => Awaitable<boolean>;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

export interface PhaseOptions<In = unknown, Ctx = unknown> {
  description?: string;
  /** Skip every step in the phase when this resolves falsy. */
  when?: (context: { input: In; ctx: Ctx }) => Awaitable<boolean>;
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
