---
title: "Caching"
description: "Reuse a phase's or step's work across runs with a pluggable store, and reach the cache from inside a step."
---

A phase or a step can reuse what it produced on an earlier run. Point it at a
store and it stops repeating the work:

```ts
import { Script, fileStore } from "@michaelrwalker/stagehand";

const cache = fileStore("./.stagehand-cache.json");

new Script<Input>({ name: "deploy" })
  .addPhase("Build", { cache })
  .addStep({ name: "install", handler: async () => { /* ... */ } })
  .addStep({ name: "compile", handler: async () => { /* ... */ } })

  .addPhase("Release")
  .addStep({ name: "warm CDN", cache, handler: async () => { /* ... */ } });
```

On a hit, the work is skipped and the stored value is merged into the context:
downstream steps see the same keys, at the same types, whether the value came
from the handler running or from the store.

## What gets stored

A **phase** stores its **delta**: the keys its steps contributed, minus
anything they `clean`ed. Keys from earlier phases are never part of it, so a hit
can't overwrite a value this run just computed for an earlier, uncached phase. A
**step** stores exactly what its handler returned.

## There is no key

The store *is* the identity: there is no cache key to pass in, because a slot's
name is derived from the phase's or step's own name (`"phase::step"` for a
step). Whether an entry is still good is entirely `stale`'s job:

```ts
.addPhase("Build", {
  cache: {
    store: cache,
    stale: ({ value, ctx, ageMs }) => ageMs > 3_600_000 || value.sha !== ctx.sha,
    schema: BuildSchema,   // optional; a value that no longer fits is a miss
  },
})
```

`stale` and `schema` both see the context as it stands when the phase is
reached, so `ctx` is typed with no annotation needed. `value` arrives as
`unknown`: annotate the parameter yourself, or hand over a `schema` and let it
narrow. A stored value that fails its schema is treated as a **miss**, not an
error, which is what stops a cache written by an older version of the script
from feeding the wrong shape into the context.

`CacheOptions` also accepts a bare `CacheStore` when neither `stale` nor
`schema` is needed: `cache: someStore` is shorthand for
`cache: { store: someStore }`.

## Rollback and caching

Cached work never ran, so its `rollback` can't fire during a later unwind. The
side effect belongs to the run that wrote the entry, and it was never undone by
this one. For the same reason, a failure downstream of a cache hit leaves that
entry alone; nothing about a later, unrelated failure implies the cached work
was wrong. See [Rollbacks](../guides/rollbacks#cached-work-never-rolls-back).

## Per-run cache control

Without touching the script itself:

```ts
await deploy.run(input, { cache: argv.includes("--no-cache") ? "off" : "on" });
```

| `CacheMode` | behavior |
| --- | --- |
| `"on"` (default) | read and write |
| `"off"` | ignore caching entirely, nothing read, nothing written |
| `"refresh"` | run everything, then overwrite every entry |
| `"read-only"` | use hits, but never write |

## Reaching the cache from a step

Every handler and rollback gets a `cache` handle, typed to the cached phases (or
cached steps) declared **before** it in the script:

```ts
.addPhase("Fetch", { cache: { store } })
.addStep({ name: "pull orders", handler: async () => { /* ... */ } })       // → { orders }

.addPhase("Adjust")
.addStep({
  name: "restock",
  handler: async ({ ctx, cache }) => {
    await cache.clear("Fetch");                     // next run refetches
    await cache.write("Fetch", { orders: ctx.orders }, { keepAge: true });
    const age = await cache.ageOf("Fetch");
  },
})
```

Slot names are checked, not stringly-typed. An uncached phase is not a slot at
all, and `as` on a mount (see
[Reusable Scripts and Mounts](../guides/reusable-scripts)) renames a mounted
routine's slots along with its phases, so the moment you write
`.use(pullChannel, { as: "Amazon" })`, every `cache.clear("Fetch")` written
against the routine's original name goes red and offers `"Amazon / Fetch"`
instead. That is the failure a hand-written string key can't catch: it would
keep compiling while silently addressing nothing.

Invalidation flows backward only: a later step can drop or correct an earlier
phase's entry, never the reverse, since a phase's cache slot is only known once
that phase has actually been declared.

### `read`, `write`, `clear`, `ageOf`

```ts
interface CacheHandle<Slots> {
  read<K extends keyof Slots & string>(
    slot: K,
    options?: { raw?: boolean },
  ): Promise<Slots[K] | undefined>;
  write<K extends keyof Slots & string>(
    slot: K,
    value: unknown,
    options?: { keepAge?: boolean },
  ): Promise<void>;
  clear(slot: keyof Slots & string): Promise<void>;
  ageOf(slot: keyof Slots & string): Promise<number | undefined>;
}
```

`write` restamps the entry as written *now*, unless `keepAge` is passed. Reach
for `keepAge` when correcting a value rather than refreshing it: restamping
silently buys another full TTL for data that is exactly as old as it was a
moment ago — the opposite of what you want when the cache exists to keep you
inside a rate limit.

```ts
await cache.write(
  "Fetch",
  { orders: corrected, discountApplied: ctx.discountApplied },
  { keepAge: true },
);
```

### The shape guard

A slot with a declared `schema` reads back as the schema's output type, because
that is the one thing actually *checked* against the stored JSON. Without a
schema, the phase's own inferred delta stands in for the type — convenient, and
correct right up until an entry written by an older version of the script
outlives the code that wrote it. For that case, `read` wraps the value in a
guard that throws `CacheShapeError` the moment a field the stored object does
not have is actually touched:

```text
CacheShapeError: Read "orders.0.date_fixed" from cache slot "Fetch", but the
stored value has no such property. The entry was probably written before this
script's shape changed — drop it with cache.clear("Fetch"), or declare a schema
on the slot to have mismatches rejected on read.
```

Only reads are trapped: assigning a new property is how you would patch an
entry before writing it back. Missing array indices, `JSON.stringify`, `await`,
and iteration all behave normally; the guard only fires on an actual property
access the underlying object cannot satisfy. Pass `{ raw: true }` to opt out.
Do that before putting the value into the context, since the guard would
otherwise travel with it into every later step that reads it from `ctx`.

```ts
try {
  const stored = await cache.read("Fetch");
  if (stored?.discountApplied) log("discount already applied");
} catch (error) {
  if (!(error instanceof CacheShapeError)) throw error;
  await cache.clear("Fetch");
}
```

## Writing a store

A `CacheStore` is three methods — a Redis or S3 backing is a dozen lines:

```ts
interface CacheStore {
  read(slot: string): Awaitable<CachedEntry | undefined>;
  write(slot: string, entry: CachedEntry): Awaitable<void>;
  clear(slot: string): Awaitable<void>;
}

interface CachedEntry {
  value: unknown;
  savedAt: number; // Date.now() at write time
}
```

`slot` is derived from the phase or step name; scripts never write it directly.
Several phases (or scripts) can point at the same store safely, since each has
its own slot.

Two stores ship with the package:

- **`fileStore(path)`** keeps every slot in one JSON file. A missing, unreadable,
  or corrupt file all read as no cache at all, so deleting it is always a valid
  reset. Writes go through a temp file and an atomic rename, with per-path write
  queueing, so concurrent writes to the same file are serialized rather than
  racing (cross-process safety is out of scope: two separate `node` processes
  writing one cache file can still interleave).
- **`memoryStore()`** lasts only for the process: useful for tests, or for
  re-running a script within one long-lived process.

Full signatures and behavior are in [Cache Stores](../reference/cache).

A store that throws — an unreadable file, a full disk, a `stale` predicate with
a bug — logs a warning and the work runs anyway. Caching never decides whether a
run passes or fails.
