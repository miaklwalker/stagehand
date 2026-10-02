---
title: "Phases and Steps"
description: "How addPhase and addStep build a script, and what phase boundaries mean for rollback scope and cache slots."
---

A script is built by chaining `addPhase` and `addStep` calls on a `Script`
instance. Each call returns a (re-typed) `Script`, so the chain reads as the
script's own outline.

## Adding a phase

```ts
new Script<Input>({ name: "deploy" })
  .addPhase("Validation")
  .addStep({ /* ... */ })
  .addStep({ /* ... */ })
  .addPhase("Release")
  .addStep({ /* ... */ });
```

`addPhase` opens a new phase; every `addStep` call after it lands in that phase
until the next `addPhase`. A phase needs a name, which must be unique across the
whole script: two phases (or two steps within one phase) sharing a name throws
`DuplicateNameError` when the script is built, not at run time. Names are not
cosmetic: they label the frame, they are what `outline()` reports, and, once a
phase caches, they identify its cache entry.

If you never call `addPhase`, `addStep` creates an implicit phase named `"Main"`
the first time it is called.

### Phase options

```ts
.addPhase("Release", {
  description: "Ship the built artifact",
  when: ({ input, ctx }) => input.environment === "production",
  cache: { store, stale: ({ ctx }) => ctx.sha !== lastBuiltSha },
})
```

`when` skips every step in the phase (see below). `cache` is covered in
[Caching](../guides/caching).

### The callback form

`addPhase` also accepts a callback, which groups a phase's steps visually while
keeping the same type flow as the flat form:

```ts
new Script<{ n: number }>({ name: "t" })
  .addPhase("A", (script) =>
    script
      .addStep({ name: "double", handler: ({ input }) => ({ doubled: input.n * 2 }) })
      .addStep({ name: "label", handler: ({ ctx }) => ({ label: `n=${ctx.doubled}` }) }),
  )
  .addPhase("B")
  .addStep({ name: "use", handler: ({ ctx }) => ({ echo: ctx.label }) });
```

The two forms are interchangeable. The callback exists purely for readability
when a phase has several steps and you want its boundary visible in the source.

## Adding a step

```ts
.addStep({
  name: "resolve commit",
  description: "look up the HEAD sha for this ref",
  handler: async ({ input, ctx, status }) => {
    status("querying git");
    return { sha: await git.head(input.service) };
  },
})
```

`name` must be unique within its phase (the same name in two different phases is
fine, since a step's cache slot is `"phase::step"`, so nothing collides). `handler` is
the only required field; everything else (`rollback`, `rollbackKeys`, `clean`,
`when`, `cache`, `retry`, `timeoutMs`, `description`) is optional. Each of those
has its own guide: [Rollbacks](../guides/rollbacks) for `rollback`/`rollbackKeys`,
[Cleaning Context Keys](../guides/cleaning-context) for `clean`,
[Caching](../guides/caching) for `cache`, and
[Script Options and Results](../guides/script-options-and-result) for `retry` and
`timeoutMs`.

## `when`: conditional steps and phases

Both `addStep` and `addPhase` accept `when`, a function of `{ input, ctx }` that
may be async:

```ts
.addStep({
  name: "notify slack",
  when: ({ input }) => input.environment === "production",
  handler: async () => { /* ... */ },
})
```

A step whose `when` resolves falsy is marked **skipped** — its `rollback`, if it
has one, never runs, because the step never did anything to compensate for.
Phase-level `when` skips every step in the phase the same way. `clean` still
applies to a skipped step: it is part of the declared shape of the context, not
of the work done, so the type and the runtime state never disagree about what a
skipped step removed. See [Cleaning Context Keys](../guides/cleaning-context) for
why that matters.

## `addBranch`: one step, two ways to do it

`when` can only skip a step, which is the wrong tool when later steps need what
that step produces: the skipped step leaves nothing behind, but `ctx` is typed
as if it had run. A branch picks between two arms that **return the same
shape**, so `ctx` is true whichever one ran. An override flag is the typical
case: use the supplied value, or work it out.

```ts
new Script<{ service: string }>({ name: "deploy" })
  .defineFlag({ name: "sha" })
  .addPhase("Resolve")
  .addBranch({
    name: "resolve commit",
    condition: ({ flags }) => Boolean(flags.sha),
    onTrue: ({ flags }) => ({ sha: flags.sha as string }),
    onFalse: async ({ input }) => ({ sha: await git.head(input.service) }),
  })
  .addStep({ name: "build", handler: ({ ctx }) => ({ image: `app:${ctx.sha}` }) });
```

`condition`, `onTrue` and `onFalse` all receive the full handler context
(`input`, `ctx`, `flags`, `status`, `prompt`, ...), and `condition` may be
async. It runs once per attempt; only the chosen arm executes.

`onTrue`'s return type fixes the step's output, and `onFalse` has to return
something assignable to it. Return different shapes and it is a compile error
on `onFalse`, rather than a union that every later step has to narrow.

A branch is deliberately small. It takes `name`, `description`, `retry` and
`timeoutMs`, which cover the whole step (condition and arm together), and
nothing else: no `rollback`, `cache`, `clean` or `when`. To cache the result,
cache the [phase](../guides/caching) the branch sits in; to drop a key, `clean`
it in a later step.

## `outline()`

Every `Script` exposes `outline()`, which reports the declared structure without
running anything, handy for tests and for generating documentation of a script
from itself:

```ts
script.outline();
// [
//   { phase: "Validation", steps: ["resolve commit", "check permissions"] },
//   { phase: "Build", steps: ["install dependencies", "compile bundle"] },
// ]
```

## Why phase boundaries matter beyond grouping

Two behaviors key off which phase a step belongs to, not just its position in
the overall sequence:

- **Rollback scope.** `rollback: "phase"` (a `ScriptOptions` setting) unwinds
  only the steps in the phase that failed, not the whole script. See
  [Rollbacks](../guides/rollbacks).
- **Cache slots.** A cached phase stores its steps' combined delta under a slot
  named after the phase. A cached step stores under `"phase::step"`. Both are
  addressable from `context.cache` inside any step declared afterward. See
  [Caching](../guides/caching).

So a phase is not just an outline label — it is the unit both of compensation
scope and of cache identity, which is why splitting work into phases is worth
doing deliberately rather than defaulting everything into `"Main"`.
