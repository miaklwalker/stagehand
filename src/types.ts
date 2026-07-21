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

  /** Permanent line, printed above the live frame and kept in scrollback. */
  log(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;

  /** Transient one-liner shown beside the step. Replaced on each call. */
  status(message: string): void;

  /** Attach a progress bar to this step. */
  progress(options: { total: number; label?: string; value?: number }): ProgressHandle;

  /** Attach a single checklist item nested under this step. */
  task(label: string): TaskHandle;

  /** Attach a whole checklist at once, keyed for typed lookup. */
  tasks<const K extends readonly string[]>(labels: K): TaskListHandle<K[number]>;
}

export interface RollbackContext<In, Ctx, Out> {
  readonly input: In;
  /** Context as it stood when the failure happened. */
  readonly ctx: Ctx;
  /** Exactly what this step's handler returned. */
  readonly output: Out;
  /** The error that triggered the unwind. */
  readonly error: unknown;
  readonly signal: AbortSignal;
  readonly phase: string;
  readonly step: string;

  log(message: string): void;
  status(message: string): void;
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

export interface StepDef<In, Ctx, Out> {
  name: string;
  description?: string;
  /**
   * The work. Whatever object it resolves to is merged into `ctx` and becomes
   * visible — and typed — for every later step.
   */
  handler: (context: StepContext<In, Ctx>) => Awaitable<Out>;
  /**
   * Compensation. Runs when a *later* step fails, in reverse order, after this
   * step has already succeeded.
   */
  rollback?: (context: RollbackContext<In, Ctx, Out>) => Awaitable<void>;
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
