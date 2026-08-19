---
name: 'caching-expensive-work'
description: >
  fileStore/memoryStore, per-slot stale/schema options, per-run CacheMode
  ("on"/"off"/"refresh"/"read-only"), and reaching a cached slot with
  context.cache (read/write/clear/ageOf) from a later step or rollback. Load
  this for "skip re-running an expensive phase," "invalidate a cache entry
  from a later step," "correct a cached value without resetting its TTL," or
  "guard a cache entry against an old script shape."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/caching.md'
  - 'miaklwalker/stagehand:docs/reference/cache.md'
  - 'miaklwalker/stagehand:src/cache.ts'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:test/cache.test.ts'
  - 'miaklwalker/stagehand:test/context-cache.test.ts'
---

# Stagehand — Caching Expensive Work

A phase or step can point at a store and stop repeating its work on later
runs. There is no cache key to pass: a slot's name is derived from the
phase's or step's own name, and whether a hit is still good is entirely
`stale`'s job.

## Setup

```ts
import { Script, fileStore } from "@michaelrwalker/stagehand";

const cache = fileStore("./.stagehand-cache.json");

interface Input {
  ref: string;
}

const deploy = new Script<Input>({ name: "deploy" })
  .addPhase("Build", { cache })
  .addStep({
    name: "compile",
    handler: async ({ input }) => ({ artifact: `dist/${input.ref}.tgz` }),
  })

  .addPhase("Release")
  .addStep({
    name: "ship",
    handler: async ({ ctx }) => ({ shipped: ctx.artifact }),
  });

await deploy.run({ ref: "main" });
```

On the second run with the same `ref`, `compile` is skipped and `artifact`
is merged into the context from the store instead of being recomputed.

## Core Patterns

### Caching a step with `stale` and `schema`

```ts
import { z } from "zod";

const BuildSchema = z.object({ artifact: z.string() });

.addPhase("Build")
.addStep({
  name: "compile",
  cache: {
    store: cache,
    stale: ({ value, ctx, ageMs }) => ageMs > 3_600_000,
    schema: BuildSchema,
  },
  handler: async ({ input }) => ({ artifact: `dist/${input.ref}.tgz` }),
})
```

`stale` and `schema` both see the live context as of that step; a stored
value that fails `schema` is treated as a miss, not an error.

### Controlling caching per run without touching the script

```ts
await deploy.run(
  { ref: "main" },
  { cache: process.argv.includes("--no-cache") ? "off" : "on" },
);
```

`"on"` (default) reads and writes, `"off"` ignores caching entirely,
`"refresh"` runs everything and overwrites every entry, `"read-only"` uses
hits but never writes.

### Reaching a cached slot from a later step

```ts
.addPhase("Fetch", { cache: { store: cache } })
.addStep({
  name: "pull",
  handler: async () => ({ orders: [{ sku: "a", qty: 2 }] }),
})

.addPhase("Adjust")
.addStep({
  name: "restock",
  handler: async ({ ctx, cache }) => {
    await cache.clear("Fetch");
    await cache.write("Fetch", { orders: ctx.orders }, { keepAge: true });
    const age = await cache.ageOf("Fetch");
    return { restockedAt: age };
  },
})
```

`context.cache` is typed to exactly the cached phases and steps declared
before the current one; a typo or a not-yet-declared slot is a compile
error, not a silent no-op.

### Opting out of the shape guard before a value enters ctx

```ts
import { CacheShapeError } from "@michaelrwalker/stagehand";

.addStep({
  name: "restock",
  handler: async ({ cache }) => {
    try {
      const stored = await cache.read("Fetch", { raw: true });
      return { orders: stored };
    } catch (error) {
      if (!(error instanceof CacheShapeError)) throw error;
      await cache.clear("Fetch");
      return { orders: [] };
    }
  },
})
```

## Common Mistakes

### HIGH Toggling `cache:` with a ternary instead of `run()`

Wrong:
```ts
.addStep({
  name: "build",
  cache: isProd ? store : undefined,   // no compile error, but no typed slot either
  handler: async () => ({ artifact: await build() }),
})
// later: context.cache.clear("build") — compile error, "build" is not a known slot
```

Correct:
```ts
.addStep({
  name: "build",
  cache: { store },                    // always a concrete CacheSource — gets a typed slot
  handler: async () => ({ artifact: await build() }),
})
// toggle it from the call site instead:
await script.run(input, { cache: isProd ? "on" : "off" });
```

`addStep` has a separate overload for a cached step requiring `cache` to be a concrete `CacheSource`; a value typed `CacheStore | undefined` doesn't satisfy it, so TypeScript falls back to the plain overload — the step still caches at runtime whenever the value is truthy, but `context.cache` never gets a typed slot for it.

Source: src/script.ts addStep() overloads; docs/guides/caching.md ("Per-run cache control")

### MEDIUM Expecting `cache.clear()` to force a re-run mid-run

Wrong:
```ts
.addStep({
  name: "restock",
  handler: async ({ ctx, cache }) => {
    await cache.clear("Fetch");
    // assumed: "Fetch" now redoes its work this run — it does not
  },
})
```

Correct:
```ts
// clear now, and let the *next* invocation of the script get the miss
.addStep({
  name: "restock",
  handler: async ({ ctx, cache }) => {
    await cache.clear("Fetch");  // takes effect starting next run
  },
})
```

A phase's cache read happens once, before its steps execute; invalidation only affects the next run that reads the slot, not the phase that already ran or hit cache this run.

Source: docs/guides/caching.md ("Reaching the cache from a step"); src/script.ts run()

### MEDIUM Letting a shape-guarded value travel into ctx unraw

Wrong:
```ts
const stored = await cache.read("Fetch");
return { orders: stored };  // guard travels into ctx.orders
// three steps later: ctx.orders[0].newField throws CacheShapeError there, not here
```

Correct:
```ts
const stored = await cache.read("Fetch", { raw: true });  // opt out before it enters ctx
return { orders: stored };
```

The shape guard on `cache.read` wraps the value in a Proxy that throws `CacheShapeError` the moment a missing field is actually touched, including from a step several hops downstream that just reads it off `ctx`, far from the original `cache.read()` call.

Source: docs/guides/caching.md ("The shape guard"); src/cache.ts guardShape()

### MEDIUM Trusting cache to guarantee a call never runs twice

Wrong:
```ts
// assumes fileStore failure = the run fails loudly, so a "guaranteed once" API call
// is safe to put behind cache alone
.addStep({ cache: { store: fileStore("./cache.json") }, handler: () => callRateLimitedApi() })
```

Correct:
```ts
// add an idempotency key or rate-limit handling in the handler itself; treat cache
// as an optimization, not a guarantee
.addStep({
  cache: { store: fileStore("./cache.json") },
  handler: () => callRateLimitedApi({ idempotencyKey }),
})
```

A store that throws — an unreadable file, a full disk, a buggy `stale` predicate — logs a warning and lets the work run anyway; caching never decides whether a run passes or fails, so it is not a hard guarantee against re-execution.

Source: docs/guides/caching.md ("A store that throws... logs a warning and does the work")

### MEDIUM Patching a value with `cache.write` and losing its age

Wrong:
```ts
await cache.write("Fetch", { orders: corrected }); // resets the TTL clock
```

Correct:
```ts
await cache.write("Fetch", { orders: corrected }, { keepAge: true });
```

`write` restamps the entry as written now unless `keepAge` is passed, so a correction that resets the clock silently buys another full staleness window for data that is exactly as old as it was a moment ago.

Source: docs/guides/caching.md; docs/reference/cache.md

### LOW Renaming a mount with `as` without updating cache calls

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

`as` renames a mounted fragment's cache slots along with its phases, so every `context.cache` call written against the unprefixed name goes red at compile time and needs the "As / PhaseName" form instead.

Source: docs/guides/reusable-scripts.md ("Mounting twice"); docs/guides/caching.md ("Reaching the cache from a step")

### HIGH Tension: Caching speed vs. compensation guarantees

Caching a phase for speed or rate-limit safety quietly removes it from the saga's compensation guarantee, since cached work never actually runs on a hit and its rollback can never fire during a later unwind. Agents optimizing this skill's goal tend to add `cache: store` to an already-rollback-protected phase as a drive-by performance tweak because they don't account for the other skill's guarantee that every mutating step's side effect gets undone on failure.

See also: skills/compensation-safety/adding-rollbacks/SKILL.md § Common Mistakes

See also: skills/reuse/reusable-routines-and-mounts/SKILL.md — cache slots travel with a mount and get renamed by `as`, which changes every context.cache call written against the routine.

## References

- [Cache API reference](references/cache-api.md)
