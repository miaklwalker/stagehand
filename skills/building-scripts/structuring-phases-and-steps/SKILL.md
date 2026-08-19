---
name: 'structuring-phases-and-steps'
description: >
  addPhase/addStep mechanics (flat and callback form), the implicit "Main" phase created on the first addStep, step and phase naming/uniqueness rules and DuplicateNameError, per-step retry/timeoutMs, and outline() for inspecting a script's declared structure without running it. Load this for "group these steps into phases," "retry a flaky step," "add a timeout to a step," or "inspect a script's structure without running it."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/phases-and-steps.md'
  - 'miaklwalker/stagehand:docs/guides/script-options-and-result.md'
  - 'miaklwalker/stagehand:docs/guides/reusable-scripts.md'
  - 'miaklwalker/stagehand:docs/reference/errors.md'
  - 'miaklwalker/stagehand:docs/reference/script.md'
  - 'miaklwalker/stagehand:src/script.ts'
---

# Stagehand — Structuring Phases and Steps

A script is built by chaining `addPhase` and `addStep` on a `Script` instance; each call returns a re-typed `Script`, so the chain itself is the script's outline. Phase boundaries are not cosmetic — they scope rollback (`rollback: "phase"`) and identify cache slots (`"phase"` for a cached phase, `"phase::step"` for a cached step).

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

interface Input {
  service: string;
}

const deploy = new Script<Input>({ name: "deploy" })
  .addPhase("Validation")
  .addStep({
    name: "resolve commit",
    handler: async ({ input }) => ({ sha: await Promise.resolve(`${input.service}-sha`) }),
  })
  .addPhase("Release")
  .addStep({
    name: "shift traffic",
    handler: async ({ ctx }) => ({ released: ctx.sha }),
  });

const result = await deploy.run({ service: "checkout" });
```

## Core Patterns

### Group steps into phases (flat and callback form)

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

The callback form groups a phase's steps visually while preserving the same type flow as the flat form; the two are interchangeable.

### Retry with backoff and veto specific errors

```ts
.addStep({
  name: "publish",
  retry: {
    attempts: 4,
    delayMs: (attempt) => attempt * 200,
    retryIf: (error) => !/^4\d\d/.test((error as Error).message),
  },
  handler: async ({ attempt, warn }) => {
    if (attempt > 1) warn(`retrying (attempt ${attempt})`);
    await publish();
  },
})
```

`attempts` is the total number of tries including the first; `delayMs` runs between failed attempts, and `retryIf` can veto a retry for an error that will never succeed by retrying (a 401, for instance).

### Time out a step

```ts
.addStep({
  name: "publish",
  timeoutMs: 30_000,
  handler: async ({ signal }) => publishWithSignal(signal),
})
```

`timeoutMs` aborts the step's `signal` once elapsed, surfacing as `StepTimeoutError`; a timeout counts as a failed attempt, subject to the same `retryIf` if `retry` is also set.

### Inspect a script's structure without running it

```ts
deploy.outline();
// [
//   { phase: "Validation", steps: ["resolve commit"] },
//   { phase: "Release", steps: ["shift traffic"] },
// ]
```

`outline()` reports every declared phase and its step names, in order, without executing any handler.

## Common Mistakes

### MEDIUM Reusing a step name within the same phase

Wrong:
```ts
.addStep({ name: "validate", handler: checkA })
.addStep({ name: "validate", handler: checkB })  // DuplicateNameError
```

Correct:
```ts
.addStep({ name: "validate input", handler: checkA })
.addStep({ name: "validate permissions", handler: checkB })
```

A step name must be unique within its own phase, since a step's cache slot is `"phase::step"`; the same name in two different phases is fine, but a duplicate inside one phase throws `DuplicateNameError` at build time, before `run()` is ever called.

Source: src/script.ts addStep() DuplicateNameError check; docs/reference/errors.md

### MEDIUM Never calling addPhase, then relying on rollback: "phase"

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

`addStep` creates an implicit `"Main"` phase the first time it is called if `addPhase` was never used, so with every step in that one phase, `rollback: "phase"` and `rollback: "all"` unwind identically.

Source: src/script.ts currentPhase() implicit "Main"; docs/guides/phases-and-steps.md

### HIGH Chaining .addStep() directly after .use() without opening a new phase

Wrong:
```ts
new Script({ name: "t" })
  .use(pullChannel)
  .addStep({ name: "sneaky", handler: () => ({}) });
// StepDefinitionError: Cannot add a step after use()
```

Correct:
```ts
new Script({ name: "t" })
  .use(pullChannel)
  .addPhase("Report")
  .addStep({ name: "summarize", handler: ({ ctx }) => ({}) });
```

A routine owns whole phases, so the last phase spliced in by `use()` belongs to the fragment, and a bare `addStep` right after it is refused at build time even though the fluent chain reads naturally.

Source: src/script.ts currentPhase() StepDefinitionError; docs/guides/reusable-scripts.md

### MEDIUM Wrapping the whole script in one giant step or phase instead of decomposing the work

Wrong:
```ts
new Script<Input>({ name: "deploy" })
  .addStep({
    name: "deploy",
    handler: async ({ input }) => {
      const sha = await resolveSha(input.ref);
      const artifact = await compile();
      const uploadId = await upload(artifact);
      await shiftTraffic(uploadId);
      return { uploadId };
    },
  });
```

Correct:
```ts
new Script<Input>({ name: "deploy" })
  .addPhase("Validation").addStep({ name: "resolve commit", handler: async ({ input }) => ({ sha: await resolveSha(input.ref) }) })
  .addPhase("Build").addStep({ name: "compile bundle", handler: async () => ({ artifact: await compile() }) })
  .addPhase("Release")
  .addStep({ name: "upload artifact", handler: async ({ ctx }) => ({ uploadId: await upload(ctx.artifact) }), rollbackKeys: ["uploadId"], rollback: async ({ output }) => cleanup(output.uploadId) })
  .addStep({ name: "shift traffic", handler: async ({ ctx }) => { await shiftTraffic(ctx.uploadId); return {}; } });
```

The value of phases and steps — incremental typed context, phase-scoped rollback, per-step retry/caching/observability — only shows up when the work is actually split along its natural boundaries; one opaque step gets none of it: no per-stage rollback, no per-stage cache, and a phase tree that renders as a single spinner instead of legible progress.

Source: maintainer interview ("not breaking things into distinct enough stages... writing a whole script around the framework instead of using the framework to write the whole script")
