---
name: 'handling-results-and-errors'
description: >
  Covers the RunResult discriminated union returned by run(), every exported error class
  (StepFailedError, StepTimeoutError, ScriptAbortedError, RollbackFailedError, CacheShapeError,
  SchemaValidationError), the isAbort(error) helper, and the throwOnError script option. Load this
  for "branch correctly on a failed run," "tell a Ctrl-C cancellation apart from a real failure,"
  or "get the phase/step name a failure happened at."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/rollbacks.md'
  - 'miaklwalker/stagehand:docs/guides/script-options-and-result.md'
  - 'miaklwalker/stagehand:docs/reference/errors.md'
  - 'miaklwalker/stagehand:src/errors.ts'
  - 'miaklwalker/stagehand:src/script.ts'
---

# Stagehand — Handling Results and Errors

`run()` never throws for an ordinary step failure — it resolves to a discriminated union on `ok`. A handful of exported error classes exist for callers building their own reporting, but most of them never propagate through `run()` itself; knowing which ones do (and which don't) is the whole game.

## Setup

```ts
import { Script, isAbort } from "@michaelrwalker/stagehand";

const deploy = new Script<{ env: string }>({ name: "deploy" })
  .addStep({
    name: "build",
    handler: async ({ ctx }) => ({ releaseId: "r-123" }),
  })
  .addStep({
    name: "publish",
    handler: async ({ ctx }) => {
      if (ctx.releaseId === undefined) throw new Error("no release to publish");
      return { published: true };
    },
  });

const result = await deploy.run({ env: "production" });

if (result.ok) {
  console.log("deployed", result.ctx.releaseId);
} else if (isAbort(result.error) && result.status === "aborted") {
  console.log("cancelled");
} else {
  console.error(`failed at ${result.failedAt?.phase} › ${result.failedAt?.step}`, result.error);
  process.exitCode = 1;
}
```

## Core Patterns

### Branch on the full RunResult shape

```ts
const result = await deploy.run(input);

if (result.ok) {
  // result.status === "success"; result.ctx is fully typed
  result.ctx.releaseId;
} else {
  // result.status is "failed" | "aborted"
  console.error(`failed at ${result.failedAt?.phase} › ${result.failedAt?.step}`);
  console.error(result.error);           // the original thrown value, unwrapped
  console.error(result.ctx);              // Partial<Ctx> — whatever was produced before failure
  for (const r of result.rollbacks) {
    console.error(`rollback for "${r.step}": ${r.ok ? "ok" : "failed"}`);
  }
}
```

`result.ctx` on failure is not reverted by compensation — a rollback undoes external side effects, it does not erase what was already recorded in `ctx`.

### Tell cancellation apart from an ordinary failure

```ts
const result = await deploy.run(input, { signal: controller.signal });

if (!result.ok) {
  if (isAbort(result.error) && result.status === "aborted") {
    console.log("canceled from outside (Ctrl-C or an external signal)");
  } else {
    console.error("handler failure:", result.error);
  }
}
```

`isAbort(error)` returns `true` for a `ScriptAbortedError` or any `Error` named `"AbortError"` — checking `result.status === "aborted"` alongside it confirms the abort was the script's own, not an unrelated `AbortError` a handler happened to throw.

### Use `throwOnError` when the script is one stage of a larger flow

```ts
import { SchemaValidationError } from "@michaelrwalker/stagehand";

const stage = new Script<{ env: string }>({ name: "stage", throwOnError: true })
  .addStep({ name: "one", handler: () => ({ done: true }) });

try {
  const result = await stage.run({ env: "production" });
  console.log(result.ctx.done); // reached only on success — a failure rejects instead
} catch (error) {
  if (error instanceof SchemaValidationError) console.error(error.issues);
  else throw error; // the original error a step threw, or a ScriptAbortedError
}
```

Compensation still runs to completion before the rejection; `throwOnError` only changes how the outcome is reported.

## Common Mistakes

### CRITICAL wrapping run() in try/catch expecting it to throw

Wrong:
```ts
try {
  const result = await deploy.run(input);
  console.log("deployed", result.ctx.releaseId);
} catch (e) {
  console.error(e);
}
```

Correct:
```ts
const result = await deploy.run(input);
if (!result.ok) {
  console.error(result.error);
  process.exitCode = 1;
  return;
}
console.log("deployed", result.ctx.releaseId);
```

`run()` resolves to `{ ok: false, ... }` by default; nothing throws unless `throwOnError` is set, so the `catch` block never fires and a failed run is silently treated as if nothing happened.

Source: docs/guides/script-options-and-result.md; src/script.ts `run()`

### HIGH assuming a bad `defineInput` schema shows up as `{ ok: false }`

Wrong:
```ts
const result = await deploy.run(rawInput);
if (!result.ok) { /* never reached on bad input — it throws instead */ }
```

Correct:
```ts
try {
  const result = await deploy.run(rawInput);
} catch (error) {
  if (error instanceof SchemaValidationError) console.error(error.issues);
  else throw error;
}
```

`SchemaValidationError` is always thrown directly by `run()`, before any phase executes, and is unaffected by `throwOnError` — there is no partial result to produce since nothing ran yet.

Source: docs/guides/typed-context.md; docs/reference/errors.md

### MEDIUM assuming a failing rollback replaces `result.error`

Wrong:
```ts
const result = await script.run(input);
if (!result.ok) console.error(result.error); // assumed to be the rollback's error if one failed
```

Correct:
```ts
const result = await script.run(input);
if (!result.ok) {
  console.error("run failed:", result.error);
  for (const r of result.rollbacks) if (!r.ok) console.error("rollback failed:", r.step, r.error);
}
```

A failing rollback is recorded as `{ ok: false, error }` inside `result.rollbacks`; `result.error` always stays the original failure that triggered the unwind, and the remaining rollbacks still run.

Source: docs/guides/rollbacks.md; docs/reference/errors.md (`RollbackFailedError`)

### MEDIUM trusting `AbortError`'s name to mean the script itself was cancelled

Wrong (inside a handler, defeats retry):
```ts
handler: async ({ signal }) => {
  const localController = new AbortController();
  setTimeout(() => localController.abort(), 200);       // unrelated to `signal`
  return fetch(url, { signal: localController.signal }); // throws AbortError → retry silently skipped
},
retry: { attempts: 3 },
```

```ts
handler: async ({ signal }) => fetch(url, { signal }),  // forward the step's own signal
retry: { attempts: 3, retryIf: (error) => !isAbort(error) },
```

Wrong (after `run()`, misreads an unrelated AbortError as user cancellation):
```ts
if (!result.ok && isAbort(result.error)) {
  console.log("user pressed Ctrl-C");  // could actually be an unrelated internal AbortError
}
```

Correct:
```ts
if (!result.ok && isAbort(result.error) && result.status === "aborted") {
  console.log("cancelled");
}
```

`isAbort()` returns `true` for a `ScriptAbortedError` *or* any `Error` whose `name` is exactly `"AbortError"` — not just ones tied to the script's own signal. Inside `executeStep`'s retry loop, that check runs before the retry-budget check, so a handler's own unrelated `AbortController` (e.g. a hand-rolled per-call timeout) silently skips `retry`/`retryIf` entirely; after `run()` returns, the same permissiveness means `isAbort(result.error)` alone doesn't prove the script itself was aborted — pair it with `result.status === "aborted"`.

Source: src/errors.ts `isAbort()`; src/script.ts `executeStep()` (isAbort check precedes the retry-budget check); docs/guides/rollbacks.md ("Signals and cancellation")

### HIGH checking `result.error instanceof StepFailedError`

Wrong:
```ts
if (!result.ok && result.error instanceof StepFailedError) {
  console.error(result.error.step, result.error.attempts); // never true — error is the raw throw
}
```

Correct:
```ts
if (!result.ok) {
  console.error(result.failedAt?.phase, result.failedAt?.step, result.error);
}
```

`result.error` on a failed run is the original value the handler threw, not automatically wrapped in `StepFailedError` — that class exists for callers building their own reporting elsewhere; the phase/step is available on `result.failedAt` instead.

Source: docs/reference/errors.md ("result.error on a failed run is the original thrown value, not automatically wrapped in this type")

### MEDIUM assuming `throwOnError` skips compensation and fails fast

Wrong:
```ts
// assumed: throwOnError means "don't bother rolling back, just blow up immediately"
new Script({ name: "t", throwOnError: true })
```

Correct:
```ts
// rollbacks still run to completion; throwOnError only affects how the caller is told about the outcome
new Script({ name: "t", throwOnError: true }) // reach for this when the script is one stage inside a larger error-handling flow
```

`throwOnError` only changes how the outcome is reported — a failing run rejects with the original error instead of resolving `{ ok: false }`, but compensation still runs first, in full, before the rejection.

Source: docs/guides/script-options-and-result.md ("Compensation still runs before the rejection")

### MEDIUM catching `RollbackFailedError` from `run()` or its result

Wrong:
```ts
try {
  await script.run(input);
} catch (e) {
  if (e instanceof RollbackFailedError) { /* never matches */ }
}
```

Correct:
```ts
const result = await script.run(input);
if (!result.ok) {
  const failedRollbacks = result.rollbacks.filter((r) => !r.ok);
}
```

`RollbackFailedError` is exported for a caller's own reporting, but the library itself never throws it or puts it in `RunResult` — a failing rollback is instead recorded as `{ ok: false, error }` inside `result.rollbacks`.

Source: docs/reference/errors.md ("a failing rollback does not propagate as this error type through RunResult")

See also: skills/compensation-safety/adding-rollbacks/SKILL.md — isAbort and the retry loop's abort check directly govern whether — and how fast — a rollback's unwind gets triggered.
