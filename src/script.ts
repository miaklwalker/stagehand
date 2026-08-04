import type { StandardSchemaV1 } from "@standard-schema/spec";
import { normalizeCache, phaseSlot, readCache, stepSlot, writeCache } from "./cache.js";
import { createRollbackContext, createStepContext } from "./context.js";
import {
  ScriptAbortedError,
  SchemaValidationError,
  StepDefinitionError,
  StepTimeoutError,
  isAbort,
} from "./errors.js";
import { errorMessage, type PhaseState, type RunState, type StepState } from "./state.js";
import type {
  CacheMode,
  CacheSource,
  CleanField,
  Cleaned,
  Merge,
  PhaseOptions,
  Prettify,
  RetryPolicy,
  RollbackReport,
  RunResult,
  ScriptOptions,
  StepDef,
  StepReport,
} from "./types.js";
import { createRenderer, type Renderer } from "./ui/renderer.js";

/* -------------------------------------------------------------------------- */
/* Internal definition storage (type-erased; the public API keeps the types)   */
/* -------------------------------------------------------------------------- */

interface AnyStepDef {
  name: string;
  description?: string;
  handler: (context: unknown) => unknown;
  rollbackKeys?: readonly string[];
  rollback?: (context: unknown) => unknown;
  clean?: readonly string[];
  when?: (context: { input: unknown; ctx: unknown }) => unknown;
  cache?: CacheSource;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

interface PhaseDefinition {
  name: string;
  options: PhaseOptions<unknown, unknown>;
  steps: AnyStepDef[];
}

interface RuntimeStep {
  def: AnyStepDef;
  state: StepState;
  phaseName: string;
}

export interface RunOptions {
  /** Cancel the run from the outside. */
  signal?: AbortSignal;
  /**
   * What this run may do with the caches the script declares. Default `"on"`.
   * Wire it to a flag — `cache: argv.includes("--no-cache") ? "off" : "on"` —
   * to control caching without touching the script.
   */
  cache?: CacheMode;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A saga-style script: phases of steps, each step optionally compensating when
 * a later step fails.
 *
 * The second type parameter is inferred, never written by hand — every
 * `addStep` whose handler returns an object widens it, so later handlers see
 * everything earlier ones produced.
 *
 * ```ts
 * const result = await new Script<{ userId: string }>("provision")
 *   .addPhase("Validation")
 *   .addStep({
 *     name: "load user",
 *     handler: async ({ input }) => ({ user: await db.user(input.userId) }),
 *   })
 *   .addPhase("Provision")
 *   .addStep({
 *     name: "create tenant",
 *     handler: async ({ ctx }) => ({ tenantId: await api.create(ctx.user.org) }),
 *     rollback: async ({ output }) => api.destroy(output.tenantId),
 *   })
 *   .run({ userId: "u_1" });
 * ```
 *
 * The third parameter is inferred too: it collects the keys steps reserved
 * through `rollbackKeys`, which is how `clean` knows what it may not remove.
 */
export class Script<In = void, Ctx extends object = {}, Reserved extends PropertyKey = never> {
  private readonly options: ScriptOptions;
  private readonly definition: PhaseDefinition[] = [];
  private readonly reserved = new Set<string>();
  private _schema: StandardSchemaV1 | undefined;

  constructor(options: ScriptOptions | string = {}) {
    this.options = typeof options === "string" ? { name: options } : options;
  }

  /**
   * Provide a [Standard Schema](https://standardschema.dev) describing the run
   * input instead of writing `In` by hand — any compliant library works (Zod,
   * Valibot, ArkType, Effect Schema, ...). `In` is inferred from the schema's
   * output type, and the value passed to `run()` is validated against it
   * before any phase executes, throwing {@link SchemaValidationError} on
   * failure.
   *
   * Call this first, right after construction — every `addStep`/`addPhase`
   * called before it still sees the old `In`.
   *
   * ```ts
   * const deploy = new Script({ name: "deploy" })
   *   .defineInput(z.object({ service: z.string() }))
   *   .addStep({
   *     name: "resolve commit",
   *     handler: async ({ input }) => ({ sha: await git.head(input.service) }),
   *   });
   * ```
   */
  defineInput<TSchema>(schema: StandardSchemaV1<unknown, TSchema>): Script<TSchema, Ctx, Reserved> {
    this._schema = schema as StandardSchemaV1;
    return this as unknown as Script<TSchema, Ctx, Reserved>;
  }

  /** Validate `input` against the schema from `defineInput`, if any. */
  private async validateInput(input: In): Promise<In> {
    if (!this._schema) return input;
    const result = await this._schema["~standard"].validate(input);
    if (result.issues) throw new SchemaValidationError(result.issues);
    return result.value as In;
  }

  /** Open a new phase. Subsequent `addStep` calls land in it. */
  addPhase(name: string, options?: PhaseOptions<In, Ctx>): Script<In, Ctx, Reserved>;
  /** Open a phase and populate it inside a callback, keeping the type flow. */
  addPhase<Next extends object, NextReserved extends PropertyKey>(
    name: string,
    build: (script: Script<In, Ctx, Reserved>) => Script<In, Next, NextReserved>,
  ): Script<In, Next, NextReserved>;
  addPhase<Next extends object, NextReserved extends PropertyKey>(
    name: string,
    options: PhaseOptions<In, Ctx>,
    build: (script: Script<In, Ctx, Reserved>) => Script<In, Next, NextReserved>,
  ): Script<In, Next, NextReserved>;
  addPhase(
    name: string,
    optionsOrBuild?: PhaseOptions<In, Ctx> | ((script: never) => unknown),
    maybeBuild?: (script: never) => unknown,
  ): unknown {
    const build =
      typeof optionsOrBuild === "function" ? optionsOrBuild : maybeBuild;
    const options =
      typeof optionsOrBuild === "function" ? {} : (optionsOrBuild ?? {});

    this.definition.push({
      name,
      options: options as PhaseOptions<unknown, unknown>,
      steps: [],
    });

    if (build) return build(this as never);
    return this;
  }

  /**
   * Append a step to the current phase. Whatever the handler resolves to is
   * merged into the context and becomes visible to every later step; whatever
   * it lists in `clean` is dropped from both.
   *
   * @throws {StepDefinitionError} if `clean` names a key reserved by some
   * step's `rollbackKeys`.
   */
  addStep<
    Out extends object | void,
    const RollbackKeys extends readonly PropertyKey[] = readonly [],
    const CleanKeys extends readonly PropertyKey[] = readonly [],
  >(
    def: StepDef<In, Ctx, Out, RollbackKeys> & CleanField<Ctx, Reserved, CleanKeys>,
  ): Script<In, Cleaned<Merge<Ctx, Out>, CleanKeys[number]>, Reserved | RollbackKeys[number]> {
    const step = def as unknown as AnyStepDef;
    const rollbackKeys = step.rollbackKeys ?? [];

    // A reserved key has to survive until a rollback might read it, so no step
    // — this one included — is allowed to clean it away.
    const conflicts = (step.clean ?? []).filter(
      (key) => this.reserved.has(key) || rollbackKeys.includes(key),
    );
    if (conflicts.length > 0) {
      throw new StepDefinitionError(
        step.name,
        `Step "${step.name}" cannot clean ${conflicts.map((key) => `"${key}"`).join(", ")}: ` +
          `reserved by rollbackKeys`,
      );
    }
    for (const key of rollbackKeys) this.reserved.add(key);

    this.currentPhase().steps.push(step);
    return this as unknown as Script<
      In,
      Cleaned<Merge<Ctx, Out>, CleanKeys[number]>,
      Reserved | RollbackKeys[number]
    >;
  }

  /** Every step name, in execution order — handy for tests and docs. */
  outline(): Array<{ phase: string; steps: string[] }> {
    return this.definition.map((phase) => ({
      phase: phase.name,
      steps: phase.steps.map((step) => step.name),
    }));
  }

  private currentPhase(): PhaseDefinition {
    const last = this.definition.at(-1);
    if (last) return last;
    const implicit: PhaseDefinition = { name: "Main", options: {}, steps: [] };
    this.definition.push(implicit);
    return implicit;
  }

  /* ------------------------------------------------------------------------ */
  /* Runner                                                                    */
  /* ------------------------------------------------------------------------ */

  async run(input: In, runOptions: RunOptions = {}): Promise<RunResult<Ctx>> {
    input = await this.validateInput(input);

    const runtime: RuntimeStep[] = [];
    const phases: PhaseState[] = this.definition.map((phase, phaseIndex) => {
      const steps: StepState[] = phase.steps.map((def) => {
        const state: StepState = {
          name: def.name,
          phaseIndex,
          status: "pending",
          attempts: 0,
          tasks: [],
          logs: [],
          hasRollback: typeof def.rollback === "function",
        };
        if (def.description !== undefined) state.description = def.description;
        runtime.push({ def, state, phaseName: phase.name });
        return state;
      });

      const phaseState: PhaseState = { name: phase.name, steps };
      if (phase.options.description !== undefined) {
        phaseState.description = phase.options.description;
      }
      return phaseState;
    });

    const state: RunState = {
      name: this.options.name ?? "script",
      phases,
      status: "running",
      startedAt: performance.now(),
      rollbackCount: 0,
      rollbackFailures: 0,
      logTail: [],
    };
    if (this.options.description !== undefined) state.description = this.options.description;

    const renderer = createRenderer({
      ...(this.options.plain !== undefined ? { plain: this.options.plain } : {}),
      ...(this.options.silent !== undefined ? { silent: this.options.silent } : {}),
      ...(this.options.logPlacement !== undefined ? { logPlacement: this.options.logPlacement } : {}),
    });

    const runController = new AbortController();
    const rollbackController = new AbortController();
    const detach = this.attachCancellation(runController, rollbackController, runOptions.signal);

    const ctx = {} as Ctx & Record<string, unknown>;
    const completed: Array<{ runtime: RuntimeStep; output: unknown }> = [];
    const rollbacks: RollbackReport[] = [];
    let failure: { phase: string; step: string; error: unknown } | null = null;

    renderer.start(state);

    try {
      let cursor = 0;
      const cacheMode: CacheMode = runOptions.cache ?? "on";

      phaseLoop: for (const [phaseIndex, phase] of this.definition.entries()) {
        const phaseState = phases[phaseIndex];
        const phaseSteps = runtime.slice(cursor, cursor + phase.steps.length);
        cursor += phase.steps.length;
        if (!phaseState) continue;

        renderer.onPhaseStart(phaseState);

        if (phase.options.when && !(await phase.options.when({ input, ctx }))) {
          for (const item of phaseSteps) {
            item.state.status = "skipped";
            drop(ctx, item.def.clean);
            renderer.onStepEnd(item.state);
          }
          renderer.refresh();
          continue;
        }

        const phaseCache = normalizeCache(phase.options.cache);
        const slot = phaseSlot(phase.name);

        if (phaseCache) {
          const hit = await safely(
            () => readCache(phaseCache, slot, input, ctx, cacheMode),
            { hit: false } as const,
            `read for phase "${phase.name}"`,
            renderer,
          );
          if (hit.hit) {
            // The delta was recorded *after* this phase's own cleans, so
            // applying it and then replaying those cleans reproduces exactly
            // the context the phase left behind the first time — including the
            // upstream keys its steps removed.
            merge(ctx, hit.value);
            phaseState.cacheAgeMs = hit.ageMs;
            for (const item of phaseSteps) {
              // Age lives on the phase line here; repeating it per step would
              // just be the same number N times.
              item.state.status = "cached";
              drop(ctx, item.def.clean);
              renderer.onStepEnd(item.state);
            }
            renderer.refresh();
            continue;
          }
        }

        // What this phase contributes to the context, tracked only when there
        // is somewhere to store it.
        const delta: Record<string, unknown> | null = phaseCache ? {} : null;

        for (const item of phaseSteps) {
          if (runController.signal.aborted) {
            failure = {
              phase: phase.name,
              step: item.state.name,
              error: runController.signal.reason ?? new ScriptAbortedError("cancelled"),
            };
            break phaseLoop;
          }

          if (item.def.when && !(await item.def.when({ input, ctx }))) {
            item.state.status = "skipped";
            drop(ctx, item.def.clean);
            drop(delta, item.def.clean);
            renderer.onStepEnd(item.state);
            renderer.refresh();
            continue;
          }

          const stepCache = normalizeCache(item.def.cache);
          const stepKey = stepSlot(phase.name, item.state.name);

          if (stepCache) {
            const hit = await safely(
              () => readCache(stepCache, stepKey, input, ctx, cacheMode),
              { hit: false } as const,
              `read for step "${item.state.name}"`,
              renderer,
            );
            if (hit.hit) {
              // Never entered `completed`, so this step's rollback cannot fire
              // during a later unwind — the side effect belongs to the run that
              // wrote the entry, and was never undone.
              item.state.status = "cached";
              item.state.cacheAgeMs = hit.ageMs;
              merge(ctx, hit.value);
              merge(delta, hit.value);
              drop(ctx, item.def.clean);
              drop(delta, item.def.clean);
              renderer.onStepEnd(item.state);
              renderer.refresh();
              continue;
            }
          }

          item.state.status = "running";
          item.state.startedAt = performance.now();
          renderer.onStepStart(item.state);
          renderer.refresh();

          let output: unknown;
          try {
            output = await this.executeStep(item, input, ctx, runController.signal, renderer);
            item.state.status = "success";
            item.state.endedAt = performance.now();
            delete item.state.statusText;
            merge(ctx, output);
            merge(delta, output);
            // The step said it is done with these; later steps neither see
            // them at runtime nor have them in their context type. `output`
            // keeps its own copy, so this step's rollback is unaffected.
            drop(ctx, item.def.clean);
            drop(delta, item.def.clean);
            completed.push({ runtime: item, output });
            renderer.onStepEnd(item.state);
            renderer.refresh();
          } catch (error) {
            item.state.status = "failed";
            item.state.endedAt = performance.now();
            item.state.error = error;
            delete item.state.statusText;
            failure = { phase: phase.name, step: item.state.name, error };
            renderer.onStepEnd(item.state);
            renderer.refresh();
            break phaseLoop;
          }

          // Only reached when the step succeeded — a `break phaseLoop` skips
          // it. Kept outside the try so a store that cannot write never gets
          // mistaken for a handler that threw.
          if (stepCache) {
            await safely(
              () => writeCache(stepCache, stepKey, output, cacheMode),
              undefined,
              `write for step "${item.state.name}"`,
              renderer,
            );
          }
        }

        // Every step settled without failing, so the delta is complete.
        if (phaseCache && delta) {
          await safely(
            () => writeCache(phaseCache, slot, delta, cacheMode),
            undefined,
            `write for phase "${phase.name}"`,
            renderer,
          );
        }
      }

      if (failure) {
        state.status = isAbort(failure.error) ? "aborted" : "failed";
        state.failure = failure;
        await this.unwind(
          completed,
          failure,
          input,
          ctx,
          state,
          rollbacks,
          rollbackController.signal,
          renderer,
        );
      } else {
        state.status = "success";
      }
    } finally {
      state.endedAt = performance.now();
      renderer.stop();
      detach();
    }

    const steps: StepReport[] = runtime.map((item) => {
      const report: StepReport = {
        phase: item.phaseName,
        name: item.state.name,
        status: item.state.status,
        durationMs:
          item.state.startedAt === undefined
            ? 0
            : (item.state.endedAt ?? performance.now()) - item.state.startedAt,
        attempts: item.state.attempts,
      };
      if (item.state.error !== undefined) report.error = item.state.error;
      return report;
    });

    const durationMs = (state.endedAt ?? performance.now()) - state.startedAt;

    if (failure) {
      if (this.options.throwOnError) throw failure.error;
      return {
        ok: false,
        status: state.status === "aborted" ? "aborted" : "failed",
        error: failure.error,
        failedAt: { phase: failure.phase, step: failure.step },
        ctx: ctx as Partial<Prettify<Ctx>>,
        durationMs,
        steps,
        rollbacks,
      };
    }

    return {
      ok: true,
      status: "success",
      ctx: ctx as Prettify<Ctx>,
      durationMs,
      steps,
    };
  }

  /** Retry + timeout wrapper around a single handler invocation. */
  private async executeStep(
    item: RuntimeStep,
    input: In,
    ctx: Ctx,
    runSignal: AbortSignal,
    renderer: Renderer,
  ): Promise<unknown> {
    const retry = item.def.retry;
    const maxAttempts = Math.max(1, retry?.attempts ?? 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      item.state.attempts = attempt;
      item.state.status = "running";
      renderer.refresh();

      const controller = new AbortController();
      const forward = (): void => controller.abort(runSignal.reason);
      if (runSignal.aborted) controller.abort(runSignal.reason);
      else runSignal.addEventListener("abort", forward, { once: true });

      const timeoutMs = item.def.timeoutMs;
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => controller.abort(new StepTimeoutError(item.def.name, timeoutMs)), timeoutMs);

      const bail = abortRejection(controller.signal);

      try {
        const context = createStepContext(
          { renderer, step: item.state, phaseName: item.phaseName },
          input,
          ctx,
          controller.signal,
          attempt,
        );
        return await Promise.race([
          Promise.resolve(item.def.handler(context as never)),
          bail.promise,
        ]);
      } catch (error) {
        lastError = error;
        if (isAbort(error)) throw error;

        const allowed = retry?.retryIf?.(error, attempt) ?? true;
        if (attempt >= maxAttempts || !allowed) throw error;

        const delayMs = resolveDelay(retry, attempt);
        item.state.statusText = `attempt ${attempt} failed, retrying in ${delayMs}ms`;
        renderer.refresh();
        await sleep(delayMs, runSignal);
      } finally {
        if (timer) clearTimeout(timer);
        runSignal.removeEventListener("abort", forward);
        bail.dispose();
      }
    }

    throw lastError;
  }

  /** Compensate completed steps in reverse order. */
  private async unwind(
    completed: Array<{ runtime: RuntimeStep; output: unknown }>,
    failure: { phase: string; step: string; error: unknown },
    input: In,
    ctx: Ctx,
    state: RunState,
    rollbacks: RollbackReport[],
    signal: AbortSignal,
    renderer: Renderer,
  ): Promise<void> {
    const mode = this.options.rollback ?? "all";
    if (mode === "none") return;

    const targets = completed
      .filter((entry) => mode === "all" || entry.runtime.phaseName === failure.phase)
      .reverse();

    for (const entry of targets) {
      const rollback = entry.runtime.def.rollback;
      if (!rollback) continue;
      if (signal.aborted) break;

      entry.runtime.state.status = "rolling-back";
      renderer.refresh();

      try {
        const context = createRollbackContext(
          { renderer, step: entry.runtime.state, phaseName: entry.runtime.phaseName },
          input,
          // Only what the step asked for — nothing by default. Reserved keys
          // can never be cleaned, so they are all still here.
          pick(ctx, entry.runtime.def.rollbackKeys),
          entry.output,
          failure.error,
          signal,
        );
        await rollback(context as never);
        entry.runtime.state.status = "rolled-back";
        delete entry.runtime.state.statusText;
        state.rollbackCount += 1;
        rollbacks.push({ phase: entry.runtime.phaseName, step: entry.runtime.state.name, ok: true });
      } catch (error) {
        entry.runtime.state.status = "rollback-failed";
        entry.runtime.state.error = error;
        state.rollbackFailures += 1;
        rollbacks.push({
          phase: entry.runtime.phaseName,
          step: entry.runtime.state.name,
          ok: false,
          error,
        });
      }
      renderer.refresh();
    }
  }

  /**
   * Wire up cancellation. The first interrupt stops the run and lets
   * compensation proceed; a second one abandons compensation too.
   */
  private attachCancellation(
    run: AbortController,
    rollback: AbortController,
    external?: AbortSignal,
  ): () => void {
    const disposers: Array<() => void> = [];

    if (external) {
      const forward = (): void => run.abort(external.reason);
      if (external.aborted) run.abort(external.reason);
      else external.addEventListener("abort", forward, { once: true });
      disposers.push(() => external.removeEventListener("abort", forward));
    }

    if (this.options.handleSignals !== false) {
      for (const signalName of ["SIGINT", "SIGTERM"] as const) {
        const handler = (): void => {
          if (run.signal.aborted) rollback.abort(new ScriptAbortedError(`${signalName} (forced)`));
          else run.abort(new ScriptAbortedError(signalName));
        };
        process.on(signalName, handler);
        disposers.push(() => {
          process.off(signalName, handler);
        });
      }
    }

    return () => {
      for (const dispose of disposers) dispose();
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Delete a step's `clean` keys from the live context, in place. */
function drop(ctx: object | null, keys: readonly string[] | undefined): void {
  if (!ctx || !keys) return;
  for (const key of keys) delete (ctx as Record<string, unknown>)[key];
}

/** Fold a handler's return value — or a cache hit — into a target object. */
function merge(target: object | null, value: unknown): void {
  if (!target || value === null || typeof value !== "object") return;
  Object.assign(target, value);
}

/**
 * Run a cache operation without letting it decide the fate of the run.
 *
 * A store that cannot be read, a `stale` predicate that throws, a disk that is
 * full — none of those mean the work failed. Each is reported as a warning and
 * falls back to doing the work, which is always the safe direction.
 */
async function safely<T>(
  action: () => Promise<T>,
  fallback: T,
  what: string,
  renderer: Renderer,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    renderer.log({ level: "warn", message: `cache ${what} failed: ${errorMessage(error)}` });
    return fallback;
  }
}

/** The `rollbackKeys` slice of the context — `{}` when none were declared. */
function pick(ctx: object, keys: readonly string[] | undefined): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!keys) return picked;
  for (const key of keys) {
    if (key in ctx) picked[key] = (ctx as Record<string, unknown>)[key];
  }
  return picked;
}

function resolveDelay(retry: RetryPolicy | undefined, attempt: number): number {
  const delay = retry?.delayMs;
  if (typeof delay === "function") return Math.max(0, delay(attempt));
  return Math.max(0, delay ?? 0);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (): void =>
      reject(signal.reason ?? new ScriptAbortedError("aborted"));
    if (signal.aborted) {
      fail();
      return;
    }
    listener = fail;
    signal.addEventListener("abort", fail, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener("abort", listener);
    },
  };
}

/**
 * Define a step in its own module while keeping full inference. Bind the input
 * and the context the step expects, then pass the definition to `addStep`.
 *
 * ```ts
 * export const verifyId = stepFor<Input, { user: User }>()({
 *   name: "verify id",
 *   handler: async ({ ctx }) => ({ verified: ctx.user.id }),
 * });
 * ```
 *
 * `rollbackKeys` works the same here, and the keys it names stay reserved once
 * the step is handed to `addStep`.
 */
export function stepFor<In, Ctx extends object = {}>() {
  return <Out extends object | void, const RollbackKeys extends readonly PropertyKey[] = readonly []>(
    def: StepDef<In, Ctx, Out, RollbackKeys>,
  ): StepDef<In, Ctx, Out, RollbackKeys> => def;
}

/** Convenience factory so callers can skip `new`. */
export function script<In = void>(options?: ScriptOptions | string): Script<In, {}> {
  return new Script<In, {}>(options);
}
