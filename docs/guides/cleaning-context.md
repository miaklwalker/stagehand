---
title: "Cleaning Context Keys"
description: "How clean drops context keys at runtime and from the type, and the rules that keep it consistent with rollbackKeys."
---

A handler's return value stays in the context for the rest of the script by
default. When a step produces or receives data that later steps do not need,
listing those keys in `clean` deletes them from the context at runtime **and**
removes them from the type every later step sees:

```ts
new Script<{ password: string; email: string }>({ name: "signup" })
  .addStep({
    name: "read input",
    handler: ({ input }) => ({ ...input }),
  })
  .addStep({
    name: "hash",
    handler: async ({ ctx }) => ({ hash: await hashIt(ctx.password) }),
    clean: ["password"],   // not needed past this point
  })
  .addStep({
    name: "persist",
    handler: ({ ctx }) => {
      ctx.hash;      // string
      ctx.email;     // string
      ctx.password;  // compile error — cleaned away
    },
  });
```

## The rules

- **Keys are checked against the context as it stands *entering* that step.** An
  unknown key is a compile error, and the editor autocompletes only the valid
  ones. A step cannot clean a key it produces itself — that key does not exist
  yet at the point `clean` is evaluated, since a step's own output and its
  `clean` list are resolved from the same incoming context.

  ```ts
  .addStep({
    name: "s",
    handler: ({ ctx }) => ({ temp: ctx.a * 10 }),
    clean: [
      // @ts-expect-error - "temp" is this step's output, not its input
      "temp",
    ],
  })
  ```

- **A key reserved by any step's `rollbackKeys` can never be cleaned**, by that
  step or any later one. Trying to throws `StepDefinitionError` from `addStep`,
  at script build time, before anything runs. See
  [Rollbacks](../guides/rollbacks#reserved-keys-and-clean) for why the
  reservation exists.

- **`clean` is part of the declared shape, not of the work**, so it applies even
  when the step is skipped by `when`: runtime and types never disagree about
  what a skipped step removed:

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

  The same is true for a step served from cache: `clean` still applies on a hit,
  since it describes the shape the context has after the step settles, regardless
  of how it settled.

- **A step's own `output` is kept separately and is never cleaned**, so its
  `rollback` still sees everything the handler returned, even if `clean` removed
  those same keys from the live context:

  ```ts
  .addStep({
    name: "one",
    handler: () => ({ token: "tok_1", scratch: "temp" }),
    rollbackKeys: ["a"],
    rollback: ({ ctx, output }) => {
      // output is still { token: "tok_1", scratch: "temp" } in full
    },
  })
  .addStep({ name: "drop it", handler: () => ({}), clean: ["scratch"] })
  ```

## Why clean exists as its own field

An alternative design would let a handler just... not return a key it wants
gone, or delete it from `ctx` directly. Neither works here: a handler's return
value is what defines the type widening for `addStep`, so the type has to be
declared statically rather than computed from what a function chooses to omit at
runtime, and `ctx` inside a handler is read-only by contract even though nothing
stops a stray mutation at the JS level. `clean` is a separate, declarative field
precisely so the compiler can check it against the context as it enters the
step — the same mechanism that lets it also enforce the `rollbackKeys`
reservation rule above.

## Interaction with caching

A cached phase stores its **delta**: the keys its steps contributed, minus
anything they cleaned. Because `clean` runs before the delta is committed, a
cache entry never contains a key that would have been unreachable from the
context anyway; a later run's cache hit reproduces the same shape the phase
would have left behind if it had actually executed. See
[Caching](../guides/caching) for the full mechanics of what gets stored.
