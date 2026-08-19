---
name: 'typed-context-and-input'
description: >
  Covers how a Script's Ctx type parameter accumulates purely from addStep handler
  return types (no hand-written generics), the input-vs-ctx distinction (input is
  fixed for the run, ctx grows step by step), and defineInput for validating run()
  input against any Standard Schema library (Zod, Valibot, ArkType, Effect Schema).
  Load this for "validate my script's input," "why is this key missing from ctx,"
  or "should I read input.x or ctx.x here."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/typed-context.md'
  - 'miaklwalker/stagehand:docs/reference/errors.md'
  - 'miaklwalker/stagehand:docs/reference/script.md'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:src/types.ts'
---

# Stagehand — The Typed Context and Validated Input

`Ctx`, the second type parameter on `Script`, starts as `{}` and widens every
time `addStep` sees a handler that returns an object. Nothing about `Ctx` is
ever written by hand — it is inferred purely from handler return types.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";
import { z } from "zod";

const deploy = new Script({ name: "deploy" })
  .defineInput(z.object({ service: z.string() }))
  .addStep({
    name: "resolve commit",
    handler: async ({ input }) => ({ sha: await git.head(input.service) }),
    //                     ^ input.service: string
  })
  .addStep({
    name: "build",
    handler: ({ ctx }) => ({ artifact: `${ctx.sha}.tar.gz` }),
    //                ^ ctx.sha: string, from the previous step
  });

const result = await deploy.run({ service: "api" });
```

## Core Patterns

### Context widens automatically from return values

```ts
new Script({ name: "pipeline" })
  .addStep({ name: "one", handler: () => ({ token: "x" }) })
  // Ctx = { token: string }
  .addStep({ name: "two", handler: ({ ctx }) => ({ n: ctx.token.length }) });
  // Ctx = { token: string; n: number }
```

Each `ctx` parameter is typed as everything every earlier step produced (minus
anything cleaned). A handler that returns nothing (`void`/`undefined`) leaves
`Ctx` unchanged; returning a key that already exists overwrites it, both at
the type level and at runtime, using `Object.assign` semantics.

### Reading `input` vs `ctx`

```ts
new Script({ name: "sync" })
  .defineInput(z.object({ tenantId: z.string() }))
  .addStep({
    name: "fetch",
    // input.tenantId is fixed for the whole run
    // ctx starts empty here, since no earlier step has run
    handler: async ({ input }) => ({ rows: await fetchRows(input.tenantId) }),
  })
  .addStep({
    name: "summarize",
    // ctx.rows is available now; input.tenantId still is too
    handler: ({ input, ctx }) => ({
      summary: `${input.tenantId}: ${ctx.rows.length} rows`,
    }),
  });
```

`input` never changes shape mid-script (unless the step belongs to a mounted
routine with its own mapped input). `ctx` grows step by step — that is the
whole reason it carries the accumulating type parameter and `input` does not.

### Validating `run()` input with any Standard Schema library

```ts
import { z } from "zod";
import { SchemaValidationError } from "@michaelrwalker/stagehand";

const deploy = new Script({ name: "deploy" })
  .defineInput(z.object({ service: z.string() }));

try {
  const result = await deploy.run({ service: "api" });
} catch (error) {
  if (error instanceof SchemaValidationError) {
    // error.issues: ReadonlyArray<StandardSchemaV1.Issue>
    console.error(error.message); // "service: Required" etc., joined with "; "
  } else {
    throw error;
  }
}
```

`defineInput` accepts any [Standard Schema](https://standardschema.dev)
validator (Zod, Valibot, ArkType, Effect Schema, or hand-rolled) and infers
`In` from its output type. Validation runs before any phase executes.

## Common Mistakes

### HIGH Mutating ctx directly instead of returning new keys

Wrong:
```ts
.addStep({
  name: "increment",
  handler: ({ ctx }) => {
    ctx.total = ctx.total + 1; // "works" locally, breaks caching/rollback
  },
})
```

Correct:
```ts
.addStep({
  name: "increment",
  handler: ({ ctx }) => ({ total: ctx.total + 1 }),
})
```

`ctx` is the same live object every handler shares, so a stray assignment does not throw — but only a handler's *return value* is folded into a cached phase's delta and into a rollback's `rollbackKeys` pick, so a directly-mutated key is silently never cached and invisible to any rollback that asks for it.

Source: src/script.ts (merge() applied only to handler output); docs/guides/cleaning-context.md

### MEDIUM Calling defineInput after addStep/addPhase, expecting it to retype earlier steps

Wrong:
```ts
new Script({ name: "t" })
  .addStep({ name: "one", handler: ({ input }) => ({}) }) // sees old In
  .defineInput(z.object({ service: z.string() }));
```

Correct:
```ts
new Script({ name: "t" })
  .defineInput(z.object({ service: z.string() }))
  .addStep({ name: "one", handler: ({ input }) => ({}) }); // input.service: string
```

`defineInput` returns a re-typed `Script`; it does not retroactively change steps already added, which still see the old `In` — it must be called first, immediately after construction.

Source: docs/guides/typed-context.md; src/script.ts defineInput()

### HIGH Assuming a failed defineInput validation shows up in RunResult

Wrong:
```ts
const result = await deploy.run(rawInput);
if (!result.ok) { /* never reached on bad input — it throws instead */ }
```

Correct:
```ts
try {
  const result = await deploy.run(rawInput);
} catch (error) {
  if (error instanceof SchemaValidationError) console.error(error.issues);
  else throw error;
}
```

`SchemaValidationError` is always thrown directly by `run()`, never returned as `{ ok: false }`, and is unaffected by `throwOnError` — there is no partial result to produce since no phase executed.

Source: docs/guides/typed-context.md; docs/reference/errors.md

See also: skills/compensation-safety/cleaning-context/SKILL.md — mutating ctx directly instead of returning it from a handler is the same "context is not just a plain mutable object" mental model both skills depend on.

## References

- [Context type utilities reference](references/context-type-utilities.md)
