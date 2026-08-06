---
title: "Cache Stores"
description: "fileStore and memoryStore, the CacheStore interface, and the types that describe a cache slot's options and value."
---

Narrative coverage of caching (what gets stored, `stale`, the shape guard,
reaching the cache from a step) is in [Caching](../guides/caching). This page
is the flat reference for the store-level exports and types.

## `fileStore(filePath)`

```ts
function fileStore(filePath: string): CacheStore
```

Backs every slot passed to it with one JSON file at `filePath` (resolved to an
absolute path). A missing, unreadable, or malformed file all read as no cache at
all — deleting the file is always a valid way to reset every slot it held.
Values must survive `JSON.stringify`; anything that does not (a `Date`, a class
instance) comes back as its JSON shape on the next read, not as the original
type.

Writes go through a temp file and an atomic rename where the platform allows it
(falling back to an in-place write if the rename is blocked by an antivirus,
editor, or file watcher holding the destination open). Concurrent writes to the
same resolved path are serialized through an in-process queue, so two
`fileStore(path)` calls on the same file (even spelled differently, e.g. with a
redundant `..` segment) share one writer and never race each other. This
serialization is in-process only: two separate `node` processes writing the same
file can still interleave.

## `memoryStore()`

```ts
function memoryStore(): CacheStore
```

Backs every slot with a `Map` that lives for the process. Useful in tests, or
for a long-lived process that re-runs the same script and wants hits to persist
between runs without touching disk.

## `CacheStore`

```ts
interface CacheStore {
  read(slot: string): Awaitable<CachedEntry | undefined>;
  write(slot: string, entry: CachedEntry): Awaitable<void>;
  clear(slot: string): Awaitable<void>;
}
```

The interface a custom store implements: three methods, each free to be sync
or async (`Awaitable<T>` is `T | Promise<T>`). `slot` is derived from a phase's
or step's name and passed in by the script; a store never generates or
interprets it.

## `CachedEntry`

```ts
interface CachedEntry {
  value: unknown;
  savedAt: number; // Date.now() at the moment it was written
}
```

One stored result, exactly as a `CacheStore` reads and writes it.

## `CacheSource<In, Ctx, Value>`

```ts
type CacheSource<In, Ctx, Value> = CacheStore | CacheOptions<In, Ctx, Value>;
```

What `cache` accepts on a phase or a step: a bare `CacheStore` (shorthand for
`{ store }`), or the fuller `CacheOptions`.

## `CacheOptions<In, Ctx, Value>`

```ts
interface CacheOptions<In, Ctx, Value> {
  store: CacheStore;
  stale?: (context: StaleContext<In, Ctx>) => Awaitable<boolean>;
  schema?: StandardSchemaV1<unknown, Value>;
}

interface StaleContext<In, Ctx> {
  value: unknown;
  input: In;
  ctx: Ctx;       // the live context as it stands when the phase/step is reached
  savedAt: number;
  ageMs: number;
}
```

`stale` returning `true` treats a stored entry as a miss — the work runs again
and the entry is overwritten. `schema`, when given, is what the stored value is
validated against on every read; a value that fails is also a miss, not a
thrown error.

## `CacheMode`

```ts
type CacheMode = "on" | "off" | "refresh" | "read-only";
```

Passed as `run(input, { cache })` to control caching for one run without editing
the script. `"on"` is the default.

## `CacheHandle<Slots>`

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

The `cache` property on both `StepContext` and `RollbackContext`, typed to the
cached phases and steps declared before the current one; see
[Caching](../guides/caching#reaching-the-cache-from-a-step). `read` wraps the
result in a guard that throws `CacheShapeError` on a field the stored value
lacks, unless the slot declared a `schema` or `{ raw: true }` was passed.

## `SlotValue<Schema, Delta>`

```ts
type SlotValue<Schema, Delta> = unknown extends Schema ? Delta : Schema;
```

The type-level rule for what a slot reads back as: the `schema`'s output type
when one was declared, otherwise the phase's (or step's) own inferred delta.
Not something called directly; it is what drives `CacheHandle<Slots>`'s
inference as phases are declared.
