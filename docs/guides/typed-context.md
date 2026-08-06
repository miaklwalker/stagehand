---
title: "The Typed Context"
description: "How the context type accumulates from handler return values, and how to validate run() input with defineInput."
---

The second type parameter on `Script` (the context, `Ctx`) is never written by
hand. It starts as `{}` and widens every time `addStep` sees a handler that
returns an object:

```ts
new Script<{ id: string }>()               // Ctx = {}
  .addStep({ handler: () => ({ token: "x" }) })      // Ctx = { token: string }
  .addStep({ handler: ({ ctx }) => ({ n: ctx.token.length }) })
                                             // Ctx = { token: string; n: number }
```

Each `ctx` parameter is typed as the context *entering* that step — everything
every earlier step produced, minus anything cleaned along the way (see
[Cleaning Context Keys](../guides/cleaning-context)). Reaching for a key no
earlier step produced is a compile error, caught before the script runs, not an
`undefined` discovered while it's running.

## Merging rules

A handler's return value is merged into the context with `Object.assign`
semantics: later keys win over earlier ones of the same name, and a handler that
returns nothing (`void` or `undefined`) leaves the context completely unchanged,
both at the type level and at runtime.

```ts
new Script({ name: "t" })
  .addPhase("A")
  .addStep({ name: "one", handler: () => ({ v: "first" }) })
  .addStep({ name: "two", handler: () => ({ v: 2 }) })
  .run();
// result.ctx is { v: 2 }
```

## `input` vs `ctx`

Every handler receives both:

- `input` is the value passed to `run()`, fixed for the whole script (unless the
  step belongs to a mounted routine with its own mapped input; see
  [Reusable Scripts and Mounts](../guides/reusable-scripts)).
- `ctx` is what earlier steps have produced so far: it grows as the script
  progresses.

`input` never changes shape mid-script; `ctx` does, which is exactly why it is
the one with the accumulating type parameter.

## Validating input with `defineInput`

Writing `In` by hand is one option (`new Script<Input>({...})`), but `In` can
also be inferred from a runtime validator. `defineInput` accepts any
[Standard Schema](https://standardschema.dev)-compliant library: Zod, Valibot,
ArkType, Effect Schema, or a hand-rolled validator, since the spec is one method.
It infers `In` from the schema's output type and validates whatever is passed to
`run()` before any phase executes, throwing `SchemaValidationError` on failure:

```ts
import { z } from "zod";

const deploy = new Script({ name: "deploy" })
  .defineInput(z.object({ service: z.string() }))
  .addStep({
    name: "resolve commit",
    handler: async ({ input }) => ({ sha: await git.head(input.service) }),
    //                     ^ input.service: string
  });
```

Call `defineInput` first, right after construction. Any `addStep` or `addPhase`
called before it still sees the previous `In` — the method returns a re-typed
`Script`, it does not retroactively change steps already added.

```ts
try {
  await deploy.run(rawInput);
} catch (error) {
  if (error instanceof SchemaValidationError) {
    // error.issues: ReadonlyArray<StandardSchemaV1.Issue>
    console.error(error.message); // "service: Required" etc., joined with "; "
  }
}
```

No step runs when validation fails. The rejection happens before the first
phase starts, which is also why `defineInput` is unaffected by `throwOnError`:
`run()` always throws `SchemaValidationError` on bad input, since there is no
partial result to return.

## `Prettify`

Types exported from the package include `Prettify<T>`, a small utility that
flattens intersections (`Omit<Ctx, K> & Out`) into a single object type so
editor hovers show the real shape rather than a chain of `&` operators. It is
applied automatically wherever the context type is constructed (`result.ctx`,
a step's `ctx` parameter), so there is nothing to opt into.
