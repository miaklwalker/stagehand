---
name: 'adding-rollbacks'
description: >
  Covers writing a step's `rollback`, declaring `rollbackKeys` (what it narrows the rollback's `ctx`
  to and permanently reserves from `clean`), `ScriptOptions.rollback` scope (`"all"` | `"phase"` |
  `"none"`), the rollback context object (`input`/`ctx`/`output`/`error`/`signal`/`phase`/`step`),
  `RunResult.rollbacks`, and cancellation via `handleSignals` / `AbortSignal` / `isAbort`. Load this
  for "add a compensation to a mutation step," "why can't my rollback see this key," "scope how far
  a failure unwinds," or "cancel a running script from outside."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/rollbacks.md'
  - 'miaklwalker/stagehand:docs/reference/errors.md'
  - 'miaklwalker/stagehand:src/errors.ts'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:test/rollback-keys.test.ts'
---

# Stagehand — Adding Rollbacks

When a step fails, every step that already **succeeded** is compensated in reverse order — last
completed, first undone. The step that actually failed is never compensated: it never completed, so
there's nothing to undo. A rollback gets no context by default; it has to name every key it needs
through `rollbackKeys`, which both narrows and permanently reserves them.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

async function reserve(accountId: string, amount: number): Promise<string> {
  return `res_${accountId}_${amount}`;
}
async function release(accountId: string, reservationId: string): Promise<void> {
  console.log(`released ${reservationId} for ${accountId}`);
}
async function chargeCard(accountId: string, amount: number): Promise<void> {
  throw new Error("payment gateway timeout");
}

const result = await new Script<{ accountId: string; amount: number }>({ name: "charge" })
  .addStep({ name: "seed", handler: ({ input }) => ({ ...input }) })
  .addStep({
    name: "reserve funds",
    handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId, ctx.amount) }),
    rollbackKeys: ["accountId", "reservationId"],
    rollback: async ({ ctx }) => release(ctx.accountId, ctx.reservationId),
  })
  .addStep({
    name: "charge card",
    handler: async ({ ctx }) => {
      await chargeCard(ctx.accountId, ctx.amount);
      return {};
    },
  })
  .run({ accountId: "acct_1", amount: 500 });

if (!result.ok) {
  console.error("run failed:", result.error);
  for (const r of result.rollbacks) if (!r.ok) console.error("rollback failed:", r.step, r.error);
}
```

## Core Patterns

### Only completed steps unwind, in reverse order

```ts
import { Script } from "@michaelrwalker/stagehand";

const order: string[] = [];

await new Script({ name: "unwind-order" })
  .addStep({ name: "one", handler: () => ({}), rollback: () => { order.push("one"); } })
  .addStep({ name: "two", handler: () => ({}), rollback: () => { order.push("two"); } })
  .addStep({
    name: "three",
    handler: () => { throw new Error("boom"); },
    rollback: () => { order.push("three"); },
  })
  .run();

// order === ["two", "one"] — "three" never completed, so its own rollback never runs
```

### Scoping the unwind with `rollback: "phase"`

```ts
import { Script } from "@michaelrwalker/stagehand";

const deploy = new Script({ name: "deploy", rollback: "phase" })
  .addPhase("Prepare")
  .addStep({ name: "provision", handler: async () => ({ serverId: "s1" }), rollback: async () => {} })
  .addPhase("Release")
  .addStep({ name: "swap traffic", handler: async () => ({ swapped: true }), rollback: async () => {} })
  .addStep({ name: "notify", handler: async () => { throw new Error("notify failed"); } });

// "notify" fails inside "Release" — only "swap traffic"'s rollback fires;
// "provision" (in "Prepare") is left alone because rollback: "phase" only unwinds the failing phase
```

`ScriptOptions.rollback` is `"all"` (default, unwinds the whole script), `"phase"` (unwinds only the
failing phase), or `"none"` (no compensation runs at all).

### Narrowing what a rollback can see with `rollbackKeys`

```ts
.addStep({
  name: "reserve funds",
  handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId, ctx.amount) }),
  rollbackKeys: ["accountId", "reservationId"],
  rollback: async ({ ctx }) => {
    // ctx is exactly { accountId: string; reservationId: string } — nothing else
    await release(ctx.accountId, ctx.reservationId);
  },
})
```

`rollbackKeys` only accepts keys that exist on the step's incoming context or its own output — anything
else is a compile error. A rollback's `output` argument always carries the full handler return value
regardless of `rollbackKeys` or later `clean` calls; only `ctx` is narrowed.

### Cancelling a running script from outside

```ts
import { Script } from "@michaelrwalker/stagehand";

const job = new Script({ name: "long-job" })
  .addStep({
    name: "fetch",
    handler: async ({ signal }) => {
      const response = await fetch("https://api.example.com/data", { signal });
      return { data: await response.json() };
    },
  });

const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const result = await job.run(undefined, { signal: controller.signal });

if (!result.ok && result.status === "aborted") {
  console.log("cancelled:", result.error);
}
```

`ScriptOptions.handleSignals` (default `true`) makes Ctrl-C and `SIGTERM` do the same thing; a second
signal after the first abandons compensation too. Forward a handler's own `signal` into any real I/O so
a cancelled step actually stops.

## Common Mistakes

### MEDIUM Relying on rollback: "phase" without ever calling addPhase

Wrong:
```ts
new Script({ name: "t", rollback: "phase" })
  .addStep(stepA).addStep(stepB).addStep(stepC);
// rollback: "phase" here behaves exactly like "all" — one phase, "Main"
```

Correct:
```ts
new Script({ name: "t", rollback: "phase" })
  .addPhase("Prepare").addStep(stepA)
  .addPhase("Commit").addStep(stepB).addStep(stepC);
```

`addStep` creates an implicit `"Main"` phase the first time it's called if `addPhase` was never used, so with everything in one phase there is nothing for `"phase"` scoping to exclude — it unwinds identically to `"all"`.

Source: src/script.ts currentPhase() implicit "Main"; docs/guides/phases-and-steps.md

### MEDIUM Writing a rollback for the step that itself failed

Wrong:
```ts
.addStep({
  name: "charge card",
  handler: () => { throw new Error("declined"); },
  rollback: () => refund(),  // never runs — this step never succeeded
})
```

Correct:
```ts
.addStep({
  name: "reserve funds",
  handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId) }),
  rollbackKeys: ["accountId"],
  rollback: async ({ ctx, output }) => release(ctx.accountId, output.reservationId),
})
.addStep({ name: "charge card", handler: () => { throw new Error("declined"); } })
```

The step that throws never completes, so only earlier, already-succeeded steps are unwound — a `rollback` field on the failing step itself is dead code.

Source: docs/guides/rollbacks.md

### CRITICAL Expecting a rollback to see the full context without declaring rollbackKeys

Wrong:
```ts
.addStep({
  name: "reserve funds",
  handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId) }),
  rollback: async ({ ctx }) => release(ctx.accountId, ctx.reservationId),
  //                  ^ both are `undefined` — ctx is {}
})
```

Correct:
```ts
.addStep({
  name: "reserve funds",
  handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId) }),
  rollbackKeys: ["accountId", "reservationId"],
  rollback: async ({ ctx }) => release(ctx.accountId, ctx.reservationId),
})
```

A rollback gets `{}` by default — every key it touches has to be named in `rollbackKeys`, which both narrows `ctx` and reserves those keys against `clean`.

Source: docs/guides/rollbacks.md; test/rollback-keys.test.ts

### MEDIUM Assuming a throwing rollback replaces or masks result.error

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

Source: docs/guides/rollbacks.md; docs/reference/errors.md (RollbackFailedError)

### MEDIUM Any Error named "AbortError" reads as a script cancellation

Wrong:
```ts
handler: async ({ signal }) => {
  const localController = new AbortController();
  setTimeout(() => localController.abort(), 200);       // unrelated to `signal`
  return fetch(url, { signal: localController.signal }); // throws AbortError → retry silently skipped
},
retry: { attempts: 3 },
```

Correct:
```ts
handler: async ({ signal }) => fetch(url, { signal }),  // forward the step's own signal
retry: { attempts: 3, retryIf: (error) => !isAbort(error) },
```

Wrong:
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

`isAbort(error)` returns `true` for a `ScriptAbortedError` or any `Error` whose `name` is exactly `"AbortError"` — not just one tied to the script's own signal — so a hand-rolled `AbortController` inside a handler silently skips `retry`, and checking `isAbort(result.error)` alone can misreport an unrelated internal abort as a real cancellation.

Source: src/errors.ts isAbort(); src/script.ts executeStep() (isAbort check precedes the retry-budget check); docs/guides/rollbacks.md ("Signals and cancellation")

### MEDIUM Writing a rollback that reaches beyond its own step's side effects

Wrong:
```ts
.addStep({
  name: "reserve funds",
  handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId) }),
  rollback: async ({ ctx }) => {
    await release(ctx.reservationId);
    await notifyUser(ctx.accountId);   // "charge card"'s concern, not this step's
  },
})
.addStep({ name: "charge card", handler: chargeCard, rollback: async () => notifyUser(ctx.accountId) })
```

Correct:
```ts
.addStep({
  name: "reserve funds",
  handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId) }),
  rollbackKeys: ["reservationId"],
  rollback: async ({ ctx }) => release(ctx.reservationId),   // only what this step did
})
.addStep({
  name: "charge card",
  handler: chargeCard,
  rollback: async () => notifyUser(),   // its own concern, compensated independently
})
```

Each completed step's own rollback already fires for its own side effects during the reverse unwind, so a rollback that also cleans up another step's work either double-undoes it or does so with less context than the responsible step actually had.

Source: maintainer interview ("rollback steps should be written when you understand everything a step must do to properly rollback... scoped to the specific step it is supposed to rollback")

### CRITICAL Cleaning a key reserved by rollbackKeys, even from the step that reserved it

Wrong:
```ts
.addStep({ name: "one", handler: () => {}, rollbackKeys: ["a"], rollback: async () => {} })
.addStep({ name: "two", handler: () => {}, clean: ["a"] });
// StepDefinitionError: reserved by rollbackKeys
```

Correct:
```ts
.addStep({ name: "one", handler: () => {}, rollbackKeys: ["a"], rollback: async () => {} })
.addStep({ name: "two", handler: () => {} })  // leave "a" alone; it stays reserved
```

Once a key is reserved by any step's `rollbackKeys`, no step — including that one — may list it in `clean`, for the rest of the script, across phase boundaries; `addStep` throws `StepDefinitionError` at build time.

Source: src/script.ts addStep() conflicts check; docs/guides/cleaning-context.md; test/rollback-keys.test.ts

### MEDIUM Giving a routine its own ScriptOptions and expecting them to hold once mounted

Wrong:
```ts
// routines/import.ts
const pipeline = new Script({ name: "import", rollback: "none" })
  .addPhase("Fetch").addStep({ name: "pull", handler, rollback: undoPull });
// mounted into a host with rollback: "all" — the host's "all" wins; "pull"'s rollback CAN fire
```

Correct:
```ts
// a mountable fragment's own ScriptOptions are dead weight once mounted — fine to leave them off,
// and expect whichever script mounts it to own rollback/logPlacement/silent for the whole run
```

A mounted `Script`'s own `ScriptOptions` are discarded in favor of the host's; only its phases and steps come across.

Source: docs/guides/reusable-scripts.md ("A mounted Script's own ScriptOptions... are ignored in favor of the host's")

### MEDIUM Catching RollbackFailedError around run()

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

`RollbackFailedError` is exported for a caller's own reporting, but the library itself never throws it — a failing rollback is instead recorded as `{ ok: false, error }` inside `result.rollbacks`.

Source: docs/reference/errors.md ("a failing rollback does not propagate as this error type through RunResult")

### HIGH Tension: Caching speed vs. compensation guarantees

Cached work never actually runs on a hit, so its rollback can never fire during a later unwind. Agents optimizing for this skill's goal tend to add `cache: store` to an already-rollback-protected phase as a drive-by performance or rate-limit tweak because they don't account for caching-expensive-work's constraint that a cache hit skips the handler entirely, quietly removing that phase from the saga's compensation guarantee.

See also: skills/caching/caching-expensive-work/SKILL.md § Common Mistakes

### HIGH Tension: Simple first draft vs. rollbackKeys reservation permanence

The simplest script has no `rollbackKeys` and no `clean` conflicts. Agents optimizing for this skill's goal tend to add a `rollback` to "harden" an already-working script and get blindsided by `StepDefinitionError` from unrelated `clean` calls elsewhere because they don't account for the fact that any `rollbackKeys` the new rollback declares permanently locks those keys from `clean` everywhere else in the script, for the rest of its life.

See also: skills/building-scripts/getting-started/SKILL.md § Common Mistakes, skills/compensation-safety/cleaning-context/SKILL.md § Common Mistakes

### HIGH Tension: Routine authoring instincts vs. host-controlled ScriptOptions

A routine is built as an ordinary `Script`, which makes it natural to set `rollback`/`logPlacement`/`silent` on it as if authoring a standalone safety policy. Agents optimizing for this skill's goal tend to set `rollback: "none"` on a routine's own `Script` to bake in "this fragment is always non-destructive" because they don't account for reusable-routines-and-mounts' constraint that every one of those options is discarded the moment the routine is mounted — only the host's own `ScriptOptions` ever apply.

See also: skills/reuse/reusable-routines-and-mounts/SKILL.md § Common Mistakes, skills/observability/log-placement-and-rendering/SKILL.md § Common Mistakes

See also: skills/compensation-safety/cleaning-context/SKILL.md — rollbackKeys and clean share one reservation mechanism; writing a rollback without knowing this leads to confusing StepDefinitionErrors elsewhere in the script.
See also: skills/caching/caching-expensive-work/SKILL.md — cached work never rolls back; anyone reasoning about compensation coverage needs to know which phases are cache-exempt from it.
