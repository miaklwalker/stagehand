---
name: 'cleaning-context'
description: >
  Covers the `clean` field on `addStep` — dropping keys from both the runtime context and the type every later step sees — and its hard interaction with `rollbackKeys` reservation, which permanently blocks a key from `clean` for the rest of the script. Load this for "drop a secret from context once it's no longer needed," "why does clean reject this key," or any `StepDefinitionError` mentioning "reserved by rollbackKeys."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/cleaning-context.md'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:test/rollback-keys.test.ts'
  - 'miaklwalker/stagehand:test/clean.test.ts'
---

# Stagehand — Cleaning Context Keys

A handler's return value stays in the context for the rest of the script by default. Listing keys in a step's `clean` deletes them from the runtime context **and** removes them from the type every later step sees.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

const result = await new Script<{ password: string; email: string }>({ name: "signup" })
  .addStep({
    name: "read input",
    handler: ({ input }) => ({ ...input }),
  })
  .addStep({
    name: "hash",
    handler: async ({ ctx }) => ({ hash: await hashIt(ctx.password) }),
    clean: ["password"], // not needed past this point
  })
  .addStep({
    name: "persist",
    handler: ({ ctx }) => {
      ctx.hash; // string
      ctx.email; // string
      // ctx.password;  // would be a compile error — cleaned away
      return {};
    },
  })
  .run({ password: "hunter2", email: "a@b.com" });

async function hashIt(s: string) {
  return s;
}
```

## Core Patterns

### Drop a key immediately after the step that consumes it

```ts
.addStep({
  name: "derive",
  handler: ({ ctx }) => ({ temp: ctx.a * 10, b: ctx.a + 1 }),
  clean: ["a"], // "a" is gone; "temp" and "b" remain
})
```

A step can clean any key from its *incoming* context while adding new keys of its own in the same handler.

### Clean under a skipped step or a cache hit

```ts
new Script<{ secret: string }>({ name: "t" })
  .addStep({ name: "seed", handler: ({ input }) => ({ secret: input.secret }) })
  .addStep({
    name: "optional",
    when: () => false,
    handler: () => ({ used: true }),
    clean: ["secret"],
  })
  .run({ secret: "hush" });
// result.ctx is {} — "secret" is gone even though "optional" never ran
```

`clean` describes the declared shape of the context, not the work performed, so it applies whether the step actually ran, was skipped by `when`, or was served from cache.

### A step's own `output` survives clean, for its rollback

```ts
.addStep({
  name: "one",
  handler: () => ({ token: "tok_1", scratch: "temp" }),
  rollbackKeys: ["a"],
  rollback: ({ ctx, output }) => {
    // output is still { token: "tok_1", scratch: "temp" } in full,
    // regardless of what a later step cleans from the live context
  },
})
.addStep({ name: "drop it", handler: () => ({}), clean: ["scratch"] })
```

## Common Mistakes

### MEDIUM Trying to clean a key the step itself just produced

Wrong:
```ts
.addStep({
  name: "s",
  handler: ({ ctx }) => ({ temp: ctx.a * 10 }),
  clean: ["temp"], // compile error — "temp" is this step's output, not its input
})
```

Correct:
```ts
.addStep({ name: "s", handler: ({ ctx }) => ({ temp: ctx.a * 10 }) })
.addStep({ name: "next", handler: () => ({}), clean: ["temp"] })
```

`clean` is checked against the context as it stands entering the step, before the handler's own output is merged, so a step's own output does not exist yet at the point `clean` is evaluated — it's a compile error to list it.

Source: docs/guides/cleaning-context.md

### CRITICAL Cleaning a key reserved by rollbackKeys, even from the reserving step

Wrong:
```ts
.addStep({ name: "one", handler: () => {}, rollbackKeys: ["a"], rollback: async () => {} })
.addStep({ name: "two", handler: () => {}, clean: ["a"] });
// StepDefinitionError: reserved by rollbackKeys
```

Correct:
```ts
.addStep({ name: "one", handler: () => {}, rollbackKeys: ["a"], rollback: async () => {} })
.addStep({ name: "two", handler: () => {} }); // leave "a" alone; it stays reserved
```

Once a key is reserved by any step's `rollbackKeys`, no step — including that one — may list it in `clean`, for the rest of the script, across phase boundaries; `addStep` throws `StepDefinitionError` at build time, before anything runs.

Source: src/script.ts addStep() conflicts check; docs/guides/cleaning-context.md; test/rollback-keys.test.ts

### MEDIUM Assuming a skipped step (when: false) does not run its clean

Wrong:
```ts
// developer expects `secret` to survive because "optional" never ran
.addStep({ name: "seed", handler: ({ input }) => ({ secret: input.secret }) })
.addStep({ name: "optional", when: () => false, handler: () => ({}), clean: ["secret"] })
.addStep({ name: "later", handler: ({ ctx }) => { ctx.secret; /* compile error — gone */ } });
```

Correct:
```ts
// if "secret" should only be dropped when "optional" actually ran, clean elsewhere
.addStep({ name: "seed", handler: ({ input }) => ({ secret: input.secret }) })
.addStep({ name: "optional", when: () => false, handler: () => ({}) })
.addStep({ name: "use it then drop it", handler: ({ ctx }) => ({}), clean: ["secret"] });
```

`clean` is part of the declared shape of the context, not of the work performed, so it applies even when the step is skipped by `when` — runtime and types never disagree about what a skipped step removed.

Source: docs/guides/cleaning-context.md; src/script.ts phaseLoop skip branch (drop(ctx, item.def.clean))

### HIGH Tension: Simple first draft vs. rollbackKeys reservation permanence

Adding a rollback to a working script pulls in a permanent constraint that a plain script never had to deal with. Agents optimizing for this skill's goal (a clean, minimal context) tend to leave existing `clean` calls untouched when a rollback is added elsewhere, then hit an unrelated `StepDefinitionError` because they don't account for `rollbackKeys` permanently reserving that key across the whole script, including earlier or later phases.

See also: skills/compensation-safety/adding-rollbacks/SKILL.md § Common Mistakes
