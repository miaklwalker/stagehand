---
name: 'conditional-steps'
description: >
  Covers `when` on `addStep` and `addPhase` for skipping work, the `"skipped"` StepStatus,
  and how a skip interacts with `clean`, `rollback`, and a mounted routine's own resolved
  input. Load this for "run this step only in production," "skip a whole phase based on
  input," or when a rollback isn't firing and the step turns out to have been skipped.
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/phases-and-steps.md'
  - 'miaklwalker/stagehand:docs/guides/reusable-scripts.md'
  - 'miaklwalker/stagehand:src/script.ts'
---

# Stagehand — Conditional Steps and Phases

`when` on `addStep` or `addPhase` is a function of `{ input, ctx }` (may be async) that gates whether the step, or every step in the phase, runs at all. A falsy result marks the step `"skipped"` — it never runs its handler and never runs its `rollback`.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

interface Input {
  environment: "development" | "production";
}

const script = new Script<Input>({ name: "deploy" })
  .addPhase("Release")
  .addStep({
    name: "notify slack",
    when: ({ input }) => input.environment === "production",
    handler: async () => {
      // only runs when input.environment === "production"
    },
  });

await script.run({ environment: "production" });
```

## Core Patterns

### Gate a single step on input or ctx

```ts
new Script<{ environment: "development" | "production" }>({ name: "deploy" })
  .addPhase("Release")
  .addStep({ name: "resolve commit", handler: async () => ({ sha: "abc123" }) })
  .addStep({
    name: "notify slack",
    when: ({ input, ctx }) => input.environment === "production" && ctx.sha.length > 0,
    handler: async () => {
      /* notify */
    },
  });
```

`when` sees the same `{ input, ctx }` shape a handler does, so it can read anything an earlier step already put in context.

### Gate an entire phase

```ts
new Script<{ environment: "development" | "production" }>({ name: "deploy" })
  .addPhase("Validation")
  .addStep({ name: "check permissions", handler: async () => ({}) })
  .addPhase("Release", {
    when: ({ input }) => input.environment === "production",
  })
  .addStep({ name: "notify slack", handler: async () => {} })
  .addStep({ name: "publish", handler: async () => {} });
```

A falsy phase-level `when` marks every step in `"Release"` `"skipped"` in one shot, before any of those steps' own `when` (if they had one) is ever evaluated.

### Async `when`

```ts
.addStep({
  name: "run migration",
  when: async ({ ctx }) => await isMigrationPending(ctx.dbUrl),
  handler: async () => runMigration(),
})
```

`when` may return a promise; the script awaits it before deciding whether to run or skip the step (or, at phase level, the whole phase).

## Common Mistakes

### MEDIUM Skipped step's `clean` still runs

Wrong:
```ts
// developer expects `secret` to survive because "optional" never ran
new Script<{ secret: string }>({ name: "t" })
  .addStep({ name: "seed", handler: ({ input }) => ({ secret: input.secret }) })
  .addStep({ name: "optional", when: () => false, handler: () => ({}), clean: ["secret"] })
  .addStep({ name: "later", handler: ({ ctx }) => {
    ctx.secret; // compile error — gone
    return {};
  } });
```

Correct:
```ts
// if "secret" should only be dropped when "optional" actually ran, clean elsewhere
new Script<{ secret: string }>({ name: "t" })
  .addStep({ name: "seed", handler: ({ input }) => ({ secret: input.secret }) })
  .addStep({ name: "optional", when: () => false, handler: () => ({}) })
  .addStep({ name: "use it then drop it", handler: ({ ctx }) => ({}), clean: ["secret"] });
```

`clean` is part of a step's declared shape, not of the work it performs, so `drop(ctx, item.def.clean)` runs in the skip branch exactly as it does after a normal run — runtime and types never disagree about what a skipped step removed.

Source: docs/guides/cleaning-context.md; src/script.ts phaseLoop skip branch (`drop(ctx, item.def.clean)`)

### LOW Expecting a skipped step's rollback to fire

Wrong:
```ts
.addStep({
  name: "notify slack",
  when: ({ input }) => input.environment === "production",
  handler: async () => notify(),
  rollback: async () => undoNotify(), // assumed to fire if a later step fails and this was "run"
})
```

Correct:
```ts
// rely on `when` purely as a gate; don't design a rollback around a skip firing it
.addStep({
  name: "notify slack",
  when: ({ input }) => input.environment === "production",
  handler: async () => notify(),
  rollback: async () => undoNotify(), // correct: only fires if this step actually ran and succeeded
})
```

A step marked `"skipped"` never enters the `completed` list the unwind walks, so its `rollback` never runs — there is nothing to compensate for.

Source: docs/guides/phases-and-steps.md

### HIGH Step-level `when` can't re-enable a step inside a skipped phase

Wrong:
```ts
new Script<{ environment: string }>({ name: "t" })
  .addPhase("Release", { when: ({ input }) => input.environment === "production" })
  .addStep({ name: "always run this", when: () => true, handler: async () => ({}) });
  // still skipped — the phase gate short-circuits before step.when is ever checked
```

Correct:
```ts
// move a step that must always run outside the conditional phase
new Script<{ environment: string }>({ name: "t" })
  .addPhase("Always")
  .addStep({ name: "always run this", handler: async () => ({}) })
  .addPhase("Release", { when: ({ input }) => input.environment === "production" })
  .addStep({ name: "notify slack", handler: async () => ({}) });
```

Phase-level `when` is evaluated once per phase; when it resolves falsy, every step in that phase is marked skipped in a loop that never touches `item.def.when` at all.

Source: src/script.ts run() phaseLoop (`phase.options.when` checked before any `step.when`)

### MEDIUM `when` inside a mounted routine sees the mount's input, not the host's

Wrong:
```ts
// inside routines/channel.ts, built with routineFor<{ channel: string }>()
.addStep({ name: "gate", when: ({ input }) => input.hostOnlyFlag, handler: async () => ({}) })
// TypeScript already prevents referencing hostOnlyFlag if routineFor's In doesn't include it —
// but this is exactly the trap when In is loosely typed or the mapper over-forwards fields
```

Correct:
```ts
import { routineFor } from "@michaelrwalker/stagehand";

export const pullChannel = routineFor<{ channel: string; since: string }>()(
  "pull channel",
  (script) =>
    script.addStep({
      name: "gate",
      when: ({ input }) => input.channel === "amazon",
      handler: async () => ({}),
    }),
);
```

A mount's input is resolved once, from a fixed value or an `{ input, ctx } => SubIn` mapper passed to `use()`, and every `when` inside that fragment — phase- or step-level — is evaluated against that resolved input, never the host script's own `input`.

Source: docs/guides/reusable-scripts.md ("Giving a mount its own input"); src/script.ts `use()`/`run()` mount input resolution

See also: skills/reuse/reusable-routines-and-mounts/SKILL.md — `when` inside a mounted fragment evaluates against the mount's resolved input, not the host's — easy to miss without reading both.
