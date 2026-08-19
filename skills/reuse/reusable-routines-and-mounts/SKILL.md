---
name: 'reusable-routines-and-mounts'
description: >
  Covers routineFor<In, Ctx>() for declaring a mountable group of phases, and Script.use(routine | script, { as?, input? })
  for splicing it into a host with optional renaming and per-mount input mapping. Load this for "share a fetch-and-normalize
  pipeline across scripts," "mount the same routine twice for two tenants," or "feed a mounted fragment its own input."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/reusable-scripts.md'
  - 'miaklwalker/stagehand:docs/guides/caching.md'
  - 'miaklwalker/stagehand:docs/reference/errors.md'
  - 'miaklwalker/stagehand:docs/reference/script.md'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:test/routine.test.ts'
---

# Stagehand — Reusable Routines and Mounts

`routineFor` declares a group of phases away from any particular script; `use()` splices that routine (or a plain `Script`) into a host, in order, merging everything it produces into the host's typed context.

## Setup

```ts
// routines/channel.ts
import { routineFor } from "@michaelrwalker/stagehand";

export const fetchChannel = routineFor<{ channel: string }>()("fetch channel", (script) =>
  script
    .addPhase("Fetch")
    .addStep({ name: "authenticate", handler: ({ input }) => ({ token: `t_${input.channel}` }) })
    .addStep({ name: "pull orders", handler: ({ ctx }) => ({ orders: [{ id: `${ctx.token}_o1`, total: 10 }] }) })
    .addPhase("Normalize")
    .addStep({ name: "dedupe", handler: ({ ctx }) => ({ orderCount: ctx.orders.length }) }),
);
```

```ts
// somewhere-else.ts
import { Script } from "@michaelrwalker/stagehand";
import { fetchChannel } from "./routines/channel";

const report = await new Script<{ channel: string }>({ name: "report" })
  .use(fetchChannel)
  .addPhase("Report")
  .addStep({ name: "aggregate", handler: ({ ctx }) => ({ total: ctx.orderCount }) })
  .run({ channel: "amazon" });
```

`routineFor<In, Ctx>()` takes the **minimum** the fragment needs: the input it reads (`In`) and the context it expects to already exist (`Ctx`). Both are checked at the `use()` call site — a host missing `channel` on its input, or missing an upstream key the routine needs in `ctx`, is a compile error there, not an `undefined` at run time.

## Core Patterns

### Mount the same routine twice for two tenants

```ts
new Script<{ since: string; amazonKey: string; shopifyKey: string }>({ name: "all channels" })
  .use(fetchChannel, {
    as: "Amazon",
    input: ({ input }) => ({ channel: "amazon" }),
  })
  .use(fetchChannel, {
    as: "Shopify",
    input: ({ input }) => ({ channel: "shopify" }),
  });
```

`as` prefixes every phase name the mount brings in (`"Amazon / Fetch"`, `"Amazon / Normalize"`), keeping them unique so a second mount of the same routine doesn't collide.

### Mount a plain `Script`, still runnable on its own

```ts
const pipeline = new Script<{ channel: string }>({ name: "pull" })
  .addPhase("Fetch")
  .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.channel] }) });

await pipeline.run({ channel: "etsy" }); // runs standalone today

const mounted = await new Script<{ channel: string }>({ name: "report" })
  .use(pipeline) // mounts into something bigger tomorrow
  .addPhase("Report")
  .addStep({ name: "count", handler: ({ ctx }) => ({ n: ctx.rows.length }) })
  .run({ channel: "etsy" });
```

`use()` accepts anything built with `routineFor` or an ordinary `Script` — the same module works alone or spliced into a host.

### Give a mount its own input, decoupled from the host's shape

```ts
export const pullChannel = routineFor<{ channel: string; apiKey: string }>()("pull channel", (script) =>
  script.addPhase("Fetch").addStep({
    name: "pull",
    handler: ({ input }) => ({ pulled: `${input.channel}:${input.apiKey}` }),
  }),
);

const result = await new Script<{ region: string }>({ name: "t" })
  .use(pullChannel, {
    input: ({ input }) => ({ channel: input.region, apiKey: "k" }),
  })
  .run({ region: "eu" });
```

`input` takes a fixed value or an `{ input, ctx } => SubIn` mapper, may be async, and is resolved once per mount at the moment the mount is reached — the host no longer has to match the routine's input shape, only produce it.

## Common Mistakes

### HIGH Chaining addStep() directly after use() without a new phase

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

A routine owns whole phases, so the last phase spliced in by `use()` belongs to the fragment — a bare `addStep` right after it throws `StepDefinitionError` at build time even though the fluent chain reads naturally.

Source: src/script.ts currentPhase() StepDefinitionError; docs/guides/reusable-scripts.md

### MEDIUM Assuming a mounted routine's when() sees the host's own input

Wrong:
```ts
// inside routines/channel.ts, built with routineFor<{ channel: string }>()
.addStep({ name: "gate", when: ({ input }) => input.hostOnlyFlag, handler: async () => {} })
// TypeScript already blocks referencing hostOnlyFlag if routineFor's In doesn't include it —
// but this is exactly the trap when In is loosely typed or the mapper over-forwards fields
```

Correct:
```ts
export const pullChannel = routineFor<{ channel: string; since: string }>()(
  "pull channel",
  (script) => script.addStep({
    name: "gate",
    when: ({ input }) => input.channel === "amazon",
    handler: async () => {},
  }),
);
```

A mount's input is resolved once, when the mount is reached, from either a fixed value or an `{ input, ctx } => SubIn` mapper — every `when` inside that fragment (phase- or step-level) is evaluated against the mount's resolved input, never the host's own.

Source: docs/guides/reusable-scripts.md ("Giving a mount its own input"); src/script.ts use()/run() mount input resolution

### HIGH Mounting the same routine twice without as

Wrong:
```ts
new Script({ name: "t" })
  .use(pullChannel)
  .use(pullChannel); // DuplicateNameError: "Fetch" already defined
```

Correct:
```ts
new Script({ name: "t" })
  .use(pullChannel, { as: "Amazon", input: ({ input }) => ({ ...input, channel: "amazon" }) })
  .use(pullChannel, { as: "Shopify", input: ({ input }) => ({ ...input, channel: "shopify" }) });
```

Phase names must stay unique across the whole script; mounting the same routine a second time without a distinguishing `as` prefix throws `DuplicateNameError` at build time.

Source: docs/guides/reusable-scripts.md; docs/reference/errors.md (DuplicateNameError)

### MEDIUM Giving a routine its own ScriptOptions and expecting them to hold once mounted

Wrong:
```ts
// routines/import.ts
const pipeline = new Script({ name: "import", rollback: "none" })
  .addPhase("Fetch")
  .addStep({ name: "pull", handler, rollback: undoPull });
// mounted into a host with rollback: "all" — the host's "all" wins; "pull"'s rollback CAN fire
```

Correct:
```ts
// a mountable fragment's own ScriptOptions are dead weight once mounted — fine to leave them off,
// and expect whichever script mounts it to own rollback/logPlacement/silent for the whole run
```

A mounted `Script`'s own `ScriptOptions` are ignored in favor of the host's; only its phases and steps come across. This is by design, not a bug — a standalone `Script` is meant to be runnable on its own today and mountable into something bigger tomorrow, and the host has to govern the whole run.

Source: docs/guides/reusable-scripts.md ("A mounted Script's own ScriptOptions... are ignored in favor of the host's")

### LOW Renaming a mount with as and forgetting to update cache calls

Wrong:
```ts
.use(pullChannel, { as: "Amazon" })
// elsewhere: cache.clear("Fetch")  — now a compile error, slot is "Amazon / Fetch"
```

Correct:
```ts
.use(pullChannel, { as: "Amazon" })
// elsewhere: cache.clear("Amazon / Fetch")
```

`as` renames a mounted fragment's cache slots along with its phases, so every `context.cache` call written against the unprefixed name goes red at compile time and needs the `"As / PhaseName"` form instead.

Source: docs/guides/reusable-scripts.md ("Mounting twice"); docs/guides/caching.md ("Reaching the cache from a step")

### MEDIUM Assuming a mount's input mapper re-evaluates per step

Wrong:
```ts
.use(pullChannel, { input: ({ input }) => ({ apiKey: getFreshToken() }) })
// assumed: getFreshToken() called again for each step in the fragment — it is called exactly once
```

Correct:
```ts
// if freshness matters per step, resolve it inside the fragment's own step handlers
// instead of the mount mapper
```

Input is resolved once per mount, at the moment the mount is reached in execution order, and every phase/step of that fragment — including `when` and `rollback` — sees that single resolved value, not a fresh evaluation each time.

Source: docs/guides/reusable-scripts.md ("resolved once per mount, at the moment the mount is reached")

### HIGH Tension: Routine authoring instincts vs. host-controlled ScriptOptions

A routine is built as an ordinary `Script`, which makes it natural to set `rollback`/`logPlacement`/`silent` on it as if authoring a standalone safety policy — but every one of those is discarded the moment it is mounted. Agents optimizing for a reusable, "always non-destructive" fragment tend to bake `rollback: "none"` into the sub-script because they don't account for the host's `ScriptOptions` overriding it entirely; that requirement has to be documented for whoever mounts the routine instead.

See also: skills/compensation-safety/adding-rollbacks/SKILL.md § Common Mistakes
See also: skills/observability/log-placement-and-rendering/SKILL.md § Common Mistakes

See also: skills/building-scripts/structuring-phases-and-steps/SKILL.md — a routine owns whole phases; addStep directly after use() is refused, which only makes sense once phase ownership is understood.
