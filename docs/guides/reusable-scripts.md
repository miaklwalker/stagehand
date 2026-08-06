---
title: "Reusable Scripts and Mounts"
description: "routineFor declares a reusable fragment of phases; use() mounts it, a whole plain Script, or the same routine twice with its own input."
---

`routineFor` does for whole phases what `stepFor` does for one step: it lets a
group of phases be declared once, away from any particular script, and mounted
wherever it is needed.

```ts
// routines/channel.ts
import { fileStore, routineFor } from "@michaelrwalker/stagehand";

const cache = fileStore("./.stagehand-cache.json");

export const pullChannel = routineFor<{ channel: string; since: string; apiKey: string }>()(
  "pull channel",
  (script) =>
    script
      .addPhase("Fetch", { cache: { store: cache, stale: ({ ageMs }) => ageMs > 3_600_000 } })
      .addStep({ name: "authenticate", handler: async ({ input }) => ({ token: input.apiKey }) })
      .addStep({ name: "pull orders", handler: async ({ input }) => ({ orders: await pull(input.channel) }) })
      .addPhase("Normalize")
      .addStep({ name: "dedupe and total", handler: ({ ctx }) => ({
        orderCount: ctx.orders.length,
        gross: ctx.orders.reduce((sum, o) => sum + o.total, 0),
      }) }),
);
```

```ts
new Script<Input>({ name: "channel sync" })
  .use(pullChannel)
  .addPhase("Validation")
  .addStep({ name: "check totals", handler: ({ ctx }) => /* ctx.orderCount, ctx.gross */ ({}) })

// months later, a different job entirely
new Script<ReportInput>({ name: "monthly report" })
  .use(pullChannel)
  .addPhase("Report")
  .addStep({ name: "build summary", handler: ({ ctx }) => /* ... */ ({}) })
```

The two type parameters on `routineFor<In, Ctx>()` are the **minimum** the
fragment needs — the input it reads and the context it expects to already
exist. Both are checked at the `use()` call site, not inside the routine's own
definition:

```text
Property 'hash' is missing in type '{}' but required in type '{ hash: string; }'.
```

## Mounting

```ts
new Script<Input>({ name: "channel sync" }).use(pullChannel)
```

`use()` splices the routine's phases into the host script, in order. Everything
the routine produces is merged into the context, so steps that follow `use()`
see it, typed, exactly as if they had been written inline. A `Routine`'s own
phase- and step-level options travel with it in full: phase-level `when` and
`cache`, step-level `retry`, `clean`, `rollback`. A spliced rollback compensates
during the host's unwind, and any keys it reserved through `rollbackKeys` stay
reserved in the host, so a later `clean` there still cannot remove them.

**A plain `Script` mounts too** — not just something built with `routineFor` —
which is what keeps a pipeline runnable on its own:

```ts
const pipeline = new Script<{ channel: string }>({ name: "pull" })
  .addPhase("Fetch")
  .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.channel] }) });

await pipeline.run({ channel: "etsy" }); // runs standalone today

new Script<{ channel: string }>({ name: "report" })
  .use(pipeline) // mounts into something bigger tomorrow
  .addPhase("Report")
  .addStep({ name: "count", handler: ({ ctx }) => ({ n: ctx.rows.length }) });
```

A mounted `Script`'s own `ScriptOptions` (its `rollback` mode, `logPlacement`,
`silent`) are ignored in favor of the host's. Only its phases and steps come
across; the host decides how the whole run is governed.

## Cache slots travel with the mount

Mounting a routine whose phase caches means the second script to mount it gets
the data the first one already pulled, without re-declaring the cache at all:

```text
› Fetch
  ⊙ authenticate  cached
  ⊙ pull orders  cached
› Report
  ✔ build summary (avg 24.50)  263ms
```

That works because the cache store lives inside the routine's own module
(`const cache = fileStore(...)` above, module-scoped): every script that
imports and mounts the routine shares the same store, and the slot is derived
from the phase name, which is identical across mounts unless renamed by `as`.

## Giving a mount its own input

A mount can feed its fragment something other than the host's own input, which
is what lets one routine serve two storefronts, each with its own credentials,
inside a single script:

```ts
new Script<{ since: string; amazonKey: string; shopifyKey: string }>({ name: "all channels" })
  .use(pullChannel, {
    as: "Amazon",
    input: ({ input }) => ({ channel: "amazon", since: input.since, apiKey: input.amazonKey }),
  })
  .use(pullChannel, {
    as: "Shopify",
    input: ({ input }) => ({ channel: "shopify", since: input.since, apiKey: input.shopifyKey }),
  })
```

`input` takes a fixed value or a function of `{ input, ctx }`, and it may be
async. It is resolved **once per mount**, at the moment the mount is reached in
execution order, and every phase and step of that fragment sees the result,
including its `when`, its `cache`, and its rollbacks during an unwind (a mounted
step's `rollback` gets the mount's input, not the host's own).

With a mapper, the host no longer has to match the routine's input shape at
all — it only has to *produce* it. TypeScript checks the return value against
the routine's declared `In`:

```text
Property 'apiKey' is missing in type '{ channel: string; }' but required in type 'ChannelInput'.
```

Without a mapper, the host's own input must satisfy the routine's requirement
directly, the same way `stepFor` steps require of a script that mounts them.

## Mounting twice

Mounting the same routine more than once requires `as`, because phase names
have to stay unique within a script:

```ts
.use(pullChannel, { as: "Amazon" })     // → "Amazon / Fetch", "Amazon / Normalize"
.use(pullChannel, { as: "Shopify" })    // → "Shopify / Fetch", "Shopify / Normalize"
```

Without `as`, mounting twice throws `DuplicateNameError` at build time: the
same rule two identically-named phases anywhere in a script are refused under,
routine or not. Names label the frame, are what `outline()` reports, and
identify a cache entry; two units sharing a name would share a slot, which
surfaces as wrong data rather than as a failure, so it is refused up front
instead.

`as` also renames the mounted fragment's cache slots, not just its phases, so
the moment you add `{ as: "Amazon" }`, every `cache.clear("Fetch")` written
against the original phase name goes red at compile time and offers
`"Amazon / Fetch"` in its place. See
[Caching](../guides/caching#reaching-the-cache-from-a-step) for how that
interacts with `context.cache`.

## `addStep` after `use()` is refused

A routine owns whole phases, so appending a bare step directly after `use()` is
a build-time error. Open a phase of your own first, rather than quietly
appending to a fragment some other script also mounts:

```ts
new Script({ name: "t" })
  .use(pullChannel)
  .addStep({ name: "sneaky", handler: () => ({}) });
  // StepDefinitionError: Cannot add a step after use(): "Normalize" belongs
  // to a mounted fragment. Open a phase of your own with addPhase() first.
```
