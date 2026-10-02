---
name: 'branching-steps'
description: >
  Covers `addBranch` — a step that runs `onTrue` or `onFalse` depending on `condition`, with both
  arms required to return the same shape so `ctx` stays accurately typed whichever one ran. Load this
  for "an override flag changes how a value is produced but later steps need it either way," "do X or
  Y and keep the context typed," or when `when` skipped a step and a later step crashed on a missing
  `ctx` key.
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.8.0'
sources:
  - 'miaklwalker/stagehand:docs/guides/phases-and-steps.md'
  - 'miaklwalker/stagehand:docs/reference/script.md'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:test/branch.test.ts'
---

# Stagehand — Branching Steps

`addBranch` is a step with an if/else inside it. `condition` picks the arm, `onTrue` / `onFalse` do the work, and both return the same shape — so every later step sees one `ctx` type, no matter which arm ran. Use it instead of `when` whenever later steps depend on what the step produces.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

const result = await new Script<{ service: string }>({ name: "deploy" })
  .defineFlag({ name: "sha" })
  .addPhase("Resolve")
  .addBranch({
    name: "resolve commit",
    condition: ({ flags }) => Boolean(flags.sha),
    onTrue: ({ flags }) => ({ sha: flags.sha as string }),
    onFalse: async ({ input }) => ({ sha: await git.head(input.service) }),
  })
  .addStep({
    name: "build",
    handler: ({ ctx }) => ({ image: `app:${ctx.sha}` }), // ctx.sha: string
  })
  .run({ service: "checkout-api" }, { argv: ["--sha", "abc1234"] });
```

## Core Patterns

### Everything a handler gets, in all three functions

`condition`, `onTrue` and `onFalse` each receive the normal step context — `input`, `ctx`, `flags`, `status`, `note`, `log`, `prompt`, `signal`. `condition` may be async and runs once per attempt; only the chosen arm executes.

```ts
.addBranch({
  name: "pick target",
  condition: async ({ ctx }) => await isReachable(ctx.host),
  onTrue: ({ ctx }) => ({ target: ctx.host }),
  onFalse: async ({ prompt }) => ({ target: await prompt.text({ message: "fallback host?", default: "localhost" }) }),
})
```

### Retry and timeout cover the whole branch

```ts
.addBranch({
  name: "resolve commit",
  retry: { attempts: 3, delayMs: 250 },
  timeoutMs: 10_000,
  condition: ({ flags }) => Boolean(flags.sha),
  onTrue: ({ flags }) => ({ sha: flags.sha as string }),
  onFalse: async ({ input }) => ({ sha: await git.head(input.service) }),
})
```

A retry re-evaluates `condition` and re-runs the arm. Those two options, plus `name` and `description`, are the whole surface.

### Caching a branch: cache the phase

```ts
.addPhase("Resolve", { cache: store })
.addBranch({ name: "resolve commit", /* ... */ })
```

A branch has no `cache` of its own. A cached phase stores the merged output of every step in it, branch included.

## Common Mistakes

### HIGH Using `when` where later steps need the output

Wrong:
```ts
.addStep({ name: "head sha", when: ({ flags }) => !flags.sha, handler: async () => ({ sha: await git.head() }) })
.addStep({ name: "build", handler: ({ ctx }) => ctx.sha.slice(0, 7) }) // compiles; crashes with --sha set
```

Correct:
```ts
.addBranch({
  name: "resolve commit",
  condition: ({ flags }) => Boolean(flags.sha),
  onTrue: ({ flags }) => ({ sha: flags.sha as string }),
  onFalse: async () => ({ sha: await git.head() }),
})
```

`when` skips the step but `ctx` is still typed as though it ran. A branch always produces the keys.

### MEDIUM Arms returning different shapes

Wrong:
```ts
onTrue: () => ({ sha: "abc" }),
onFalse: () => ({ commit: "abc" }), // compile error on onFalse
```

Correct:
```ts
onTrue: () => ({ sha: "abc" }),
onFalse: () => ({ sha: "abc" }),
```

`onTrue`'s return type fixes `Out`; `onFalse` must be assignable to it. If one path has no value, return an explicit default (`{ sha: undefined }` on both arms, or `sha: string | undefined` in `onTrue`) rather than omitting the key.

### MEDIUM Expecting `rollback`, `cache`, `clean` or `when` on a branch

Wrong:
```ts
.addBranch({ name: "b", condition, onTrue, onFalse, rollback: async () => {} }) // not accepted
```

Correct:
```ts
// If the work needs compensation, make it a plain addStep with its own rollback
// and branch inside the handler; cache the enclosing phase; clean in a later step.
.addStep({
  name: "provision",
  handler: async ({ input }) => ({ id: input.existingId ?? (await create()) }),
  rollback: async ({ output }) => destroy(output.id),
})
```

A branch is intentionally minimal: no compensation, no step-level cache, no `clean`, no `when`.

Source: docs/guides/phases-and-steps.md; src/types.ts `BranchDef`

See also: skills/compensation-safety/conditional-steps/SKILL.md — `when` is for work that may simply not happen; `addBranch` is for work that always happens in one of two ways.
