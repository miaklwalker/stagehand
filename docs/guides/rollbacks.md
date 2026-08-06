---
title: "Rollbacks"
description: "How compensation runs when a step fails, what a rollback can see, and how rollbackKeys reserves context."
---

When a step fails, every step that already **succeeded** is compensated in
reverse order — last completed, first undone. The step that actually failed is
never compensated; it never completed, so there is nothing to undo.

```ts
const order: string[] = [];

await new Script({ name: "t" })
  .addStep({ name: "one", handler: () => ({}), rollback: () => order.push("one") })
  .addStep({ name: "two", handler: () => ({}), rollback: () => order.push("two") })
  .addStep({
    name: "three",
    handler: () => { throw new Error("boom"); },
    rollback: () => order.push("three"),
  })
  .run();

// order === ["two", "one"] — "three" never ran, so its rollback doesn't either
```

## Rollback scope

`ScriptOptions.rollback` controls how far the unwind reaches:

| value | behavior |
| --- | --- |
| `"all"` (default) | unwind every completed step in the whole script |
| `"phase"` | unwind only the steps in the phase that failed |
| `"none"` | leave everything as-is, no compensation runs |

```ts
new Script({ name: "deploy", rollback: "phase" })
```

A rollback that itself throws is recorded in `result.rollbacks` and surfaced in
the terminal summary. It never masks the original failure — `result.error` is
always what actually broke the run, and the remaining rollbacks still run; one
failing compensation does not stop the rest from attempting theirs.

## What a rollback can see

A rollback always receives its own step's `output` in full — exactly what the
handler returned, regardless of whether the context has since been cleaned. It
receives **no context at all** by default. To read anything from `ctx`, a
rollback has to ask for it by name through `rollbackKeys`:

```ts
new Script<{ accountId: string; amount: number }>({ name: "charge" })
  .addStep({ name: "read input", handler: ({ input }) => ({ ...input }) })
  .addStep({
    name: "reserve funds",
    handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId, ctx.amount) }),
    rollbackKeys: ["accountId", "reservationId"],
    rollback: async ({ ctx }) => {
      // ctx is { accountId: string; reservationId: string } — and nothing else
      await release(ctx.accountId, ctx.reservationId);
    },
  })
  .addStep({
    name: "charge card",
    handler: () => { throw new Error("payment gateway timeout"); },
  });
```

`rollbackKeys` does two things:

1. **Narrows** `ctx` inside that step's `rollback` to exactly the keys listed;
   nothing else is even visible to TypeScript, let alone present at runtime.
2. **Reserves** those keys, so neither this step nor any later one may `clean`
   them away. Whatever the rollback asked for is therefore guaranteed to still be
   in the context if the rollback ever actually runs.

`rollbackKeys` only accepts keys that exist on the step's incoming context or on
its own output; anything else is a compile error:

```ts
.addStep({
  name: "one",
  handler: () => ({ made: 1 }),
  // @ts-expect-error - "nope" is neither in the context nor in the output
  rollbackKeys: ["nope"],
  rollback: () => {},
})
```

## Reserved keys and `clean`

Once a key is reserved by some step's `rollbackKeys`, no step — including the one
that reserved it — may list that key in its own `clean`. Attempting to throws
`StepDefinitionError` from `addStep`, at script build time, before anything runs:

```ts
script
  .addStep({ name: "one", handler: () => {}, rollbackKeys: ["a"], rollback: async () => {} })
  .addStep({ name: "two", handler: () => {}, clean: ["a"] });
  //                                          ^ StepDefinitionError: reserved by rollbackKeys
```

The reservation persists for the rest of the script, across phase boundaries:
a key reserved in phase one stays unclean-able in phase five. See
[Cleaning Context Keys](../guides/cleaning-context) for the full rules `clean`
follows.

## The rollback context

`rollback` receives one object, distinct from a handler's:

| | |
| --- | --- |
| `input` | the value the step actually ran with |
| `ctx` | only the keys named in `rollbackKeys`, `{}` if none were declared |
| `output` | exactly what this step's handler returned |
| `error` | what triggered the unwind |
| `signal` | an `AbortSignal`, aborted if the unwind itself is canceled |
| `phase` / `step` | the names of this step's phase and itself |
| `log` / `status` / `note` / `progress` | the same terminal primitives a handler gets; see [The Handler Surface](../guides/handler-surface) |
| `cache` | typed to the cached phases declared before this step; see [Caching](../guides/caching) |

A handler's other UI methods (`info`, `warn`, `error`, `success`, `task`,
`tasks`) are not part of the rollback surface; `log` is the one always-available
line, and `status`/`note`/`progress` behave exactly as they do in a handler.

## Cached work never rolls back

If a step or phase was served from cache, its handler never actually ran this
run — so its `rollback` cannot fire during a later unwind, even if the step is
otherwise reached in the compensation order. The side effect the rollback would
be undoing belongs to whichever earlier run actually did the work and wrote the
cache entry; it was never undone then, either. For the mirror-image reason, a
failure downstream of a cache hit leaves that entry alone: nothing about a later
failure invalidates it automatically. See
[Caching](../guides/caching#rollback-and-caching) for how to invalidate an entry
deliberately from within a rollback.

## Signals and cancellation

`ScriptOptions.handleSignals` (default `true`) makes Ctrl-C (`SIGINT`) and
`SIGTERM` abort the run and let compensation proceed; a second signal after that
abandons compensation too. `run(input, { signal })` accepts an external
`AbortSignal` for the same behavior triggered programmatically. Pass the
handler's own `signal` through to any real I/O (`fetch`, a database driver, a
child process) so a canceled step actually stops rather than finishing in the
background:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const result = await job.run(input, { signal: controller.signal });
```

`isAbort(error)` distinguishes a cancellation (`ScriptAbortedError`, or any
`Error` named `"AbortError"`) from an ordinary handler failure, useful in a
`catch` or when inspecting `result.error` after a failed run.
