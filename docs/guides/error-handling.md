---
title: "Error Handling"
description: "The exact order of events when something goes wrong: retries, timeouts, which steps are compensated and how far, what a failed run reports, and which errors escape run() instead."
---

This page is the precise contract. The [Rollbacks](../guides/rollbacks) and
[Script Options and Results](../guides/script-options-and-result) guides teach
the pieces; this one states what happens, in what order, so you do not have to
infer it.

Every claim below is covered by a test or was checked against the runtime.

## The short version

1. A step that throws is **retried** (if it has `retry`) before it is treated as failed.
2. **Nothing is rolled back between retries.** Rollback happens **once**, after the step has failed for good.
3. The failed step is **never** rolled back. Only steps that *completed* are.
4. Completed steps are rolled back **in reverse order**, as far as `ScriptOptions.rollback` allows (`"all"` by default).
5. Steps after the failure **never run**.
6. A failed rollback is **recorded and skipped over**; it never replaces the original error and never stops the remaining rollbacks.

## Life of a step

```
step reached
 ├─ phase `when` falsy ─────────────▶ skipped          (no handler, no rollback)
 ├─ step `when` falsy ──────────────▶ skipped
 ├─ cache hit ──────────────────────▶ cached           (no handler, no rollback)
 └─ run handler  (attempt 1)
      ├─ resolves ──────────────────▶ success          (joins the "completed" list)
      └─ throws
           ├─ abort / cancellation ─▶ failed, no retry
           ├─ retryIf says no ──────▶ failed
           ├─ attempts exhausted ───▶ failed
           └─ otherwise: wait delayMs, run attempt 2 …
```

Only a step that reaches **success** is added to the completed list, and only
completed steps can ever be compensated. Skipped steps and cache hits never
are: they did no work this run.

## Retries

`retry: { attempts, delayMs?, retryIf? }` (see
[Script Options and Results](../guides/script-options-and-result#per-step-options-retry-and-timeoutms)).

- `attempts` is the **total** number of tries, so `attempts: 3` is one try plus at most two retries. Without `retry` it is `1`.
- A retry **re-runs the handler from the start**, against the same `input` and the same `ctx` it saw the first time. A failed attempt contributes nothing to `ctx`: only the output of the attempt that succeeds is merged.
- **No rollback runs between attempts.** The step's own `rollback` is for work that *completed*; a failed attempt is not completed work, and the step has not failed yet. Earlier steps are not rolled back either.
- **After the last attempt fails, there is still no rollback for this step.** It never completed. Rollback begins for the steps *before* it.
- `retryIf(error, attempt)` is asked after each failed attempt. `false` stops retrying immediately and the step fails with that error. `attempt` is the 1-based number of the attempt that just failed.
- The error that ends up in `result.error` is the one from the **last** attempt. Earlier attempts' errors are not kept; `steps[].attempts` tells you how many were made.
- Cancellation is never retried (see below), and neither is a prompt the user cancelled.
- A branch ([`addBranch`](../guides/phases-and-steps#addbranch-one-step-two-ways-to-do-it)) retries as a unit: the `condition` is evaluated again and then the arm runs again.

### Consequence: a step with `retry` must tolerate partial work

Because nothing compensates a failed attempt, if attempt 1 creates something and
then throws, attempt 2 starts with that thing already created, and if every
attempt fails it is **never cleaned up by Stagehand**. Either make the handler
idempotent, or clean up inside the handler before rethrowing:

```ts
.addStep({
  name: "provision",
  retry: { attempts: 3 },
  handler: async ({ signal }) => {
    const id = await api.create({ signal });
    try {
      await api.configure(id, { signal });
    } catch (error) {
      await api.destroy(id); // this attempt's own mess; no rollback will see it
      throw error;
    }
    return { id };
  },
  rollback: ({ output }) => api.destroy(output.id), // for the attempt that succeeded
})
```

## Timeouts

`timeoutMs` aborts the attempt's `signal` after that long and fails the attempt
with `StepTimeoutError`.

- A timeout is an ordinary failure, **not** a cancellation (`isAbort` is `false` for it). It **is** retried, subject to `retryIf`, and each attempt gets a fresh `timeoutMs`.
- The wait on your handler is abandoned the moment the timer fires, but a handler that ignores `signal` **keeps running in the background**. If it is retried, the old attempt and the new one overlap. Pass `signal` to real I/O.
- Timeouts apply to handlers only. A `rollback` has no timeout, no retry, and can run for as long as it likes unless the unwind is cancelled.

## Cancellation

A cancellation is a `ScriptAbortedError` (Ctrl-C, SIGTERM, an aborted `run(input, { signal })`), a `PromptCancelledError`, or any `Error` named `"AbortError"`. `isAbort(error)` recognises all three.

- It is **not retried**, whatever `retry` says, and it ends any retry delay immediately.
- It is checked **between steps** as well: if the run is aborted while step A finishes, step B is never started. The run is reported as failed at B with the abort as the error.
- `result.status` is `"aborted"` instead of `"failed"`.
- **Rollback still runs**, to the same extent as for any other failure. Cancelling does not skip compensation.
- Signals: the first SIGINT/SIGTERM stops the run and lets compensation proceed. A **second** signal abandons compensation too: remaining rollbacks are not attempted and their steps keep status `"success"`. If the run had already failed on its own and was mid-unwind, the first signal is absorbed and the second is the one that abandons it. `handleSignals: false` turns this off.

## What gets rolled back, and how far

When a step fails for good, `unwind` runs once:

1. Take the completed steps. Cached and skipped ones are not in the list.
2. Filter by `ScriptOptions.rollback`:

| `rollback` | steps considered |
| --- | --- |
| `"all"` (default) | every completed step in the script, in every phase |
| `"phase"` | only completed steps in the **same phase as the failed step**. Earlier phases are left in place |
| `"none"` | none; `result.rollbacks` is empty |

3. Run them **one at a time, in reverse completion order** (last completed, first undone). Steps without a `rollback` are passed over.
4. Each rollback receives that step's own `output`, the `input` it ran with, only the `rollbackKeys` it asked for, and the error that triggered the unwind. See [The rollback context](../guides/rollbacks#the-rollback-context).

```ts
// phase 1: a ✔  b ✔      phase 2: c ✔  d ✘ (fails)
//
// rollback: "all"    → undo c, b, a
// rollback: "phase"  → undo c
// rollback: "none"   → nothing
//
// d is never undone: it did not complete. e, which follows d, never runs.
```

### When a rollback itself fails

- The error is recorded in `result.rollbacks` (`{ ok: false, error }`) and the step's status becomes `"rollback-failed"`.
- The unwind **continues** with the next step. One broken compensation never prevents the others from trying.
- `result.error` is **always** the original failure, never a rollback's.
- Nothing is retried: a rollback runs once.

### What is never rolled back

| | why |
| --- | --- |
| the step that failed | it did not complete |
| steps after it | they never started (status `"pending"`) |
| a skipped step (`when` falsy) | it did nothing |
| a cache hit, step or phase | the work was done by an earlier run; see [Cached work never rolls back](../guides/rollbacks#cached-work-never-rolls-back) |
| a step that failed on an earlier retry but later succeeded | it completed, so it *is* rolled back, once, using the successful attempt's output |

## The result of a failed run

`run()` resolves (it does not throw) to `{ ok: false, ... }` unless `throwOnError` is set:

| field | value |
| --- | --- |
| `status` | `"failed"`, or `"aborted"` for a cancellation |
| `error` | the original thrown value from the last attempt of the failing step (not wrapped) |
| `failedAt` | `{ phase, step }` of the step that failed |
| `ctx` | `Partial<Ctx>`: everything produced before the failure. **Rolling back does not remove keys from it** |
| `steps` | one report per declared step: `success`, `rolled-back`, `rollback-failed`, `failed`, `skipped`, `cached` or `pending`, plus `attempts` and `error` |
| `rollbacks` | one entry per rollback that actually ran, in the order they ran |

With `throwOnError: true`, the compensation still runs first, and then `run()` rejects with the same original error.

## What is thrown out of `run()` instead

Some errors are not step failures. They never produce a result, and **nothing
is rolled back**, because they happen when nothing has completed yet, or outside
the machinery that tracks completed steps:

| error | when | rolls back? |
| --- | --- | --- |
| `SchemaValidationError` | `defineInput` rejects the input | n/a, nothing ran |
| `UnknownFlagError`, `MissingFlagValueError` | bad argv for `defineFlag` | n/a, nothing ran |
| an error thrown by a **`when`** (step or phase) or by a **mount `input` mapper** | evaluated by the runner, not inside a step | **No.** `run()` rejects, and steps that already completed are *not* compensated |

Everything thrown **inside** a handler (including a `condition`, `onTrue` or
`onFalse` of a branch, a prompt, or a `PromptUnavailableError`) is an ordinary
step failure with the behavior described above.

> Keep `when` predicates and mount `input` mappers total: no I/O that can fail
> and no parsing that can throw. If a decision can fail, make it a step (or a
> branch) so a failure rolls back the work before it. A `when` that throws after
> steps have already done real work leaves that work in place.

## Caches and failure

- A **step** cache entry is written immediately when that step succeeds, even if a later step fails. It is not invalidated by the later failure.
- A **phase** cache entry is written only after **every** step in the phase has settled without failing. A failure part-way through leaves no phase entry.
- A cache that cannot be read or written logs a warning and the work runs anyway; it never fails the run.

## Quick answers

**Does rollback run on each retry?** No. It runs once, after retries are exhausted (or `retryIf` stops them), and only for the steps that completed *before* the failing one.

**Is the failing step rolled back?** Never.

**How far does it go back?** To the start of the script by default (`"all"`), to the start of the failed step's phase with `"phase"`, not at all with `"none"`.

**What if I cancel mid-way?** The run fails as `"aborted"`, and compensation proceeds as for any failure; a second signal gives up on it.

**What if a rollback throws?** It is recorded, the rest still run, and the original error is still the one reported.
