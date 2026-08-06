---
title: "Script Options and Results"
description: "Every ScriptOptions field, per-step retry and timeoutMs, and the shape of the value run() resolves to."
---

## Script options

Passed to the `Script` constructor, either as an object or — for the common case
of just naming the script — as a bare string:

```ts
new Script<Input>({
  name: "deploy",
  description: "Build, upload and release a service",
  rollback: "all",            // "all" | "phase" | "none"
  throwOnError: false,        // true to throw instead of returning ok: false
  plain: undefined,           // force the CI renderer; default auto-detects a TTY
  silent: false,
  handleSignals: true,        // Ctrl-C aborts and compensates; a second one gives up
  logPlacement: "scrollback", // "scrollback" | "step" | "bottom"
})

new Script("deploy") // shorthand for { name: "deploy" }
```

| option | default | effect |
| --- | --- | --- |
| `name` | `"script"` | labels the frame and appears in reports |
| `description` | none | shown under the name in the header |
| `rollback` | `"all"` | how far a failure unwinds; see [Rollbacks](../guides/rollbacks#rollback-scope) |
| `throwOnError` | `false` | `true` makes `run()` throw the original error instead of resolving `{ ok: false, ... }` |
| `plain` | auto-detected | force the plain/CI renderer (`true`) or the live one (`false`) |
| `silent` | `false` | suppress all terminal output |
| `handleSignals` | `true` | Ctrl-C / SIGTERM abort the run and compensate; a second signal abandons compensation too |
| `logPlacement` | `"scrollback"` | where `log`/`info`/`warn`/`error`/`success` land; see [The Handler Surface](../guides/handler-surface#log-placement) |

`plain` and the TTY auto-detection it overrides are covered in full in
[Terminal Rendering](../guides/terminal-rendering).

## Per-step options: `retry` and `timeoutMs`

These live on the step definition itself, not on `ScriptOptions`, since they
govern one step's execution rather than the whole run:

```ts
.addStep({
  name: "publish",
  description: "push the tag",
  when: ({ input, ctx }) => input.env === "production",
  retry: { attempts: 3, delayMs: (attempt) => attempt * 250, retryIf: isTransient },
  timeoutMs: 30_000,
  handler,
  rollback,
})
```

`retry.attempts` is the total number of tries, including the first — `attempts:
3` means up to two retries after an initial failure. `delayMs` is a fixed
number or a function of the attempt that just failed (1-based), and `retryIf`
can veto a retry for a particular error (a 401 is never going to succeed by
trying again, so don't waste the budget on it):

```ts
retry: {
  attempts: 4,
  delayMs: (attempt) => attempt * 200,
  retryIf: (error) => !/^4\d\d/.test((error as Error).message),
}
```

`attempt` (1-based) is available on the handler's own context parameter, so a
handler can log or brand its behavior differently on a retry:

```ts
handler: async ({ attempt, warn }) => {
  if (attempt > 1) warn(`retrying (attempt ${attempt})`);
  // ...
}
```

`timeoutMs` aborts the step's `signal` once that many milliseconds have passed,
which surfaces as a `StepTimeoutError` if the handler does not resolve first.
`retry` and `timeoutMs` compose: a timeout that fires counts as a failed
attempt, subject to the same `retryIf`.

## The result

`run()` resolves to a discriminated union on `ok`:

```ts
type RunResult<Ctx> =
  | {
      ok: true;
      status: "success";
      ctx: Ctx;
      durationMs: number;
      steps: StepReport[];
    }
  | {
      ok: false;
      status: "failed" | "aborted";
      error: unknown;
      failedAt: { phase: string; step: string } | null;
      ctx: Partial<Ctx>;           // whatever did get produced before the failure
      durationMs: number;
      steps: StepReport[];
      rollbacks: RollbackReport[];
    };
```

```ts
const result = await deploy.run(input);

if (result.ok) {
  result.ctx.releaseId; // fully typed
} else {
  console.error(`failed at ${result.failedAt?.phase} › ${result.failedAt?.step}`);
  console.error(result.error);
  for (const r of result.rollbacks) {
    console.error(`rollback for "${r.step}": ${r.ok ? "ok" : "failed"}`);
  }
}
```

- **`status`** is `"success"`, `"failed"`, or `"aborted"`: `"aborted"` means the
  run was canceled (Ctrl-C, an external signal) rather than a handler throwing
  on its own.
- **`ctx`** on failure is `Partial<Ctx>` — the accumulated context as it stood at
  the moment of failure, not reverted by compensation. A rollback undoes
  external side effects; it does not erase what was already recorded in `ctx`.
- **`failedAt`** is `null` only in the (unreachable in practice, since a failure
  always has a step) type; in every failing run it names the phase and step
  that threw.
- **`steps`** is every declared step, in order, each reporting its final
  `StepStatus` (`"success"`, `"failed"`, `"skipped"`, `"cached"`, `"rolled-back"`,
  `"rollback-failed"`, etc.), `durationMs`, `attempts`, and its `error` if any.
- **`rollbacks`** (failure only) is one `RollbackReport` per compensation that
  actually ran, each with `{ phase, step, ok, error? }`, in the order they ran,
  which is reverse completion order.

## `throwOnError`

With `throwOnError: true`, a failing run rejects with the original error instead
of resolving to `{ ok: false, ... }`:

```ts
await assert.rejects(
  () => new Script({ name: "t", throwOnError: true })
    .addStep({ name: "one", handler: () => { throw new Error("nope"); } })
    .run(),
  /nope/,
);
```

Compensation still runs before the rejection: `throwOnError` only changes how
the outcome is reported, not whether rollback happens. Reach for it when the
script is a step inside something else's own error handling (a build tool
calling a Stagehand script as one stage) rather than the top-level entry point
of a process.
