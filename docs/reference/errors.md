---
title: "Errors"
description: "Every error class Stagehand throws or resolves with, what triggers each one, and the isAbort helper."
---

All error classes extend `Error` and set `name` to their own class name, so
`error.name` and `instanceof` agree. Most carry extra fields relevant to what
failed, listed below each one.

## Build-time errors

Thrown synchronously while a script is being assembled, from `addStep`,
`addPhase`, or `use()`, before `run()` is ever called.

### `StepDefinitionError`

```ts
class StepDefinitionError extends Error {
  readonly step: string;
}
```

Thrown by `addStep` when `clean` names a key reserved by some step's
`rollbackKeys`, including a key that step reserves for itself. Also thrown by
`use()` if the value passed is neither a `Routine` (from `routineFor`) nor a
`Script`, and by the runtime `cache` handle if a step addresses a slot name
that was never declared as a cached phase or step. See
[Rollbacks](../guides/rollbacks#reserved-keys-and-clean) and
[Cleaning Context Keys](../guides/cleaning-context).

### `DuplicateNameError`

```ts
class DuplicateNameError extends Error {
  readonly kind: "phase" | "step";
  readonly duplicate: string;
}
```

Thrown by `addPhase` when a phase name is already used anywhere in the script
(including one brought in by `use()`), and by `addStep` when a step name is
already used within its own phase. The same step name in two *different* phases
is fine. Mounting the same routine twice without giving each mount an `as`
prefix is the most common trigger; see
[Reusable Scripts and Mounts](../guides/reusable-scripts#mounting-twice).

## Run-time errors

### `SchemaValidationError`

```ts
class SchemaValidationError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;
}
```

Thrown by `run()` when input fails the schema given to `defineInput`, before any
phase executes. `message` joins every issue's path and message; `issues` is the
raw Standard Schema issue list for programmatic handling. See
[The Typed Context](../guides/typed-context#validating-input-with-defineinput).
Always thrown, never returned as part of `RunResult` — there is no partial
result to produce when the input itself was rejected.

### `StepTimeoutError`

```ts
class StepTimeoutError extends Error {
  readonly step: string;
  readonly timeoutMs: number;
}
```

The reason a step's `signal` aborts when its `timeoutMs` elapses before the
handler resolves. Surfaces as `result.error` on a failed run, or is thrown
directly when `throwOnError` is set. Counts as a failed attempt against `retry`,
subject to `retryIf` like any other error.

### `ScriptAbortedError`

```ts
class ScriptAbortedError extends Error {
  readonly reason: string;
}
```

The reason a run's signal aborts on Ctrl-C / SIGTERM (when `handleSignals` is
on) or on an external `AbortSignal` passed to `run(input, { signal })`.
`result.status` is `"aborted"` rather than `"failed"` when this is what stopped
the run.

### `RollbackFailedError`

```ts
class RollbackFailedError extends Error {
  readonly phase: string;
  readonly step: string;
  readonly rollbackError: unknown;
}
```

Describes a compensation handler throwing during an unwind. In practice, a
failing rollback does not propagate as this error type through `RunResult`:
it is recorded in `result.rollbacks` as `{ ok: false, error }` instead, and
never replaces `result.error`, which always stays the failure that triggered
the unwind in the first place. `RollbackFailedError` is exported for callers
building their own reporting around a rollback failure. See
[Rollbacks](../guides/rollbacks#rollback-scope).

### `StepFailedError`

```ts
class StepFailedError extends Error {
  readonly phase: string;
  readonly step: string;
  readonly attempts: number;
}
```

Wraps a handler's thrown error with the step and phase it happened in, and how
many attempts were made, using the standard `cause` mechanism (`error.cause` is
whatever the handler actually threw). Exported for use in a caller's own error
handling; `result.error` on a failed run is the original thrown value, not
automatically wrapped in this type.

## Cache errors

### `CacheShapeError`

```ts
class CacheShapeError extends Error {
  readonly slot: string;
  readonly path: string; // e.g. "orders.0.date_fixed"
}
```

Thrown the moment code reads a property from a cached value (via
`context.cache.read`) that the stored JSON does not actually have, unless the
slot declared a `schema` or the read passed `{ raw: true }`. `path` names the
exact property access that failed, dotted through arrays and objects. See
[Caching](../guides/caching#the-shape-guard).

## `isAbort(error)`

```ts
function isAbort(error: unknown): boolean
```

Returns `true` for a `ScriptAbortedError`, or any `Error` whose `name` is
`"AbortError"` (the DOM/Node convention other abort-aware APIs use). Use it to
tell a genuine cancellation apart from an ordinary handler failure when
inspecting `result.error`:

```ts
if (!result.ok) {
  if (isAbort(result.error)) {
    console.log("canceled from outside");
  } else {
    console.error(result.error);
  }
}
```
