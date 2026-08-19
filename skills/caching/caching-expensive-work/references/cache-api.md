# Cache API Reference

Full type surface for Stagehand's caching layer, from `src/cache.ts` and
`src/types.ts`. Narrative coverage lives in the main `SKILL.md`.

## `fileStore(filePath): CacheStore`

```ts
function fileStore(filePath: string): CacheStore
```

Backs every slot passed to it with one JSON file at `filePath`, resolved to
an absolute path via `node:path`'s `resolve`.

- **Missing / unreadable / malformed file** all read as no cache at all — a
  `JSON.parse` failure, a missing file, or a non-object root all fall back to
  `{}`. Deleting the file is always a valid way to reset every slot it held.
- **Serialization**: values must survive `JSON.stringify`. Anything that
  doesn't (a `Date`, a class instance) comes back as its JSON shape on the
  next read, not as the original type.
- **Atomic writes**: every write does mkdir (recursive) on the file's parent
  directory, then writes the whole file's data to a temp file named
  `${target}.${process.pid}.${tempCounter}.tmp` (a monotonically increasing
  counter, not just the pid, because two writes in the same process sharing a
  pid-only temp name used to rename each other's files out from under
  themselves), then `rename`s the temp file onto the target path.
  - If the rename fails with `EPERM`, `EACCES`, `EBUSY`, or `EEXIST` (Windows,
    antivirus, an editor, or a file watcher holding the destination open),
    it falls back to an in-place `writeFile` on the target — atomicity is
    given up, the write is not.
  - Any other rename error is rethrown.
  - The temp file is always removed in a `finally` (`rm(temp, { force: true })`).
- **Read-modify-write queueing**: every `write` and `clear` goes through an
  in-process `Map<string, Promise<unknown>>` keyed by the *resolved* target
  path, so two `fileStore(path)` calls on the same file (even spelled
  differently, e.g. with a redundant `..` segment) share one writer and never
  race. A failed write does not poison writes queued behind it. This
  serialization is in-process only — two separate `node` processes writing
  the same file can still interleave.
- `read(slot)` re-reads and re-parses the whole file each call and returns
  the entry at `slot` only if it passes `isEntry` (an object with a `value`
  key and a numeric `savedAt`); otherwise `undefined`, including for a
  hand-edited or older-format file.
- `clear(slot)` is a no-op (skips the write entirely) if the slot isn't
  present via `Object.hasOwn`.

## `memoryStore(): CacheStore`

```ts
function memoryStore(): CacheStore
```

Backs every slot with a plain `Map<string, CachedEntry>` that lives for the
process. `read`/`write`/`clear` are synchronous under the hood (still
`Awaitable`-compatible). Useful for tests or a long-lived process that wants
hits to persist across repeated runs without touching disk.

## `CacheStore`

```ts
interface CacheStore {
  read(slot: string): Awaitable<CachedEntry | undefined>;
  write(slot: string, entry: CachedEntry): Awaitable<void>;
  clear(slot: string): Awaitable<void>;
}
```

`Awaitable<T>` is `T | Promise<T>` — each method may be sync or async. `slot`
is derived from a phase's or step's own name and passed in by the script; a
store never generates or interprets it. A custom backing store (Redis, S3,
...) only needs these three methods.

Slot naming, computed internally (never passed by script authors):

```ts
const phaseSlot = (phase: string): string => phase;
const stepSlot = (phase: string, step: string): string => `${phase}::${step}`;
```

## `CachedEntry`

```ts
interface CachedEntry {
  value: unknown;
  savedAt: number; // Date.now() at the moment it was written
}
```

The exact shape a `CacheStore` reads and writes — one stored result plus its
write timestamp.

## `CacheSource<In, Ctx, Value>`

```ts
type CacheSource<In = unknown, Ctx = unknown, Value = unknown> =
  | CacheStore
  | CacheOptions<In, Ctx, Value>;
```

What `cache` accepts on a phase or a step. `normalizeCache` in `src/cache.ts`
detects a bare `CacheStore` by duck-typing a `read` function on it and
expands it to `{ store: source }`; anything else is passed through as
`CacheOptions` unchanged.

## `CacheOptions<In, Ctx, Value>`

```ts
interface CacheOptions<In = unknown, Ctx = unknown, Value = unknown> {
  store: CacheStore;
  stale?: (context: StaleContext<In, Ctx>) => Awaitable<boolean>;
  schema?: StandardSchemaV1<unknown, Value>;
}
```

- `store` is required; `stale` and `schema` are both optional.
- `stale` returning `true` treats a stored entry as a miss — the work runs
  again and the entry is overwritten on success.
- `schema`, when given, validates the stored value on every read via
  `schema["~standard"].validate(value)`; a value with `issues` is also a
  miss, never a thrown error. This is what stops a cache written by an older
  version of the script from feeding the wrong shape into the context.
- When no `schema` is set, the reads-back type is instead the phase's or
  step's own inferred delta type (see `SlotValue` below).

### `StaleContext<In, Ctx>`

```ts
interface StaleContext<In, Ctx> {
  value: unknown;
  input: In;
  ctx: Ctx;       // the live context as it stands when the phase/step is reached
  savedAt: number;
  ageMs: number;
}
```

`value` always arrives as `unknown` inside `stale` — annotate it yourself,
or supply `schema` to get a checked, narrowed value on the `read` path
instead. `ageMs` is `Math.max(0, Date.now() - entry.savedAt)`, so it is never
negative even with clock skew.

## `CacheMode`

```ts
type CacheMode = "on" | "off" | "refresh" | "read-only";
```

Passed as `run(input, { cache })`. Default is `"on"`.

| Mode | read | write |
| --- | --- | --- |
| `"on"` | yes | yes |
| `"off"` | no (`readCache` short-circuits to a miss) | no |
| `"refresh"` | no (forces every entry to recompute) | yes (overwrites) |
| `"read-only"` | yes | no |

Implementation detail from `src/cache.ts`:

```ts
export async function readCache(cache, slot, input, ctx, mode) {
  if (mode === "off" || mode === "refresh") return MISS;
  // ...store.read, schema validate, stale check...
}

export async function writeCache(cache, slot, value, mode) {
  if (mode === "off" || mode === "read-only") return;
  await cache.store.write(slot, { value, savedAt: Date.now() });
}
```

A store or `stale`/`schema` call that throws is caught elsewhere in
`script.ts` and treated as a miss with a logged warning — caching never
decides whether the run itself passes or fails.

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

This is the `cache` property on both `StepContext` and `RollbackContext`
(`readonly cache: CacheHandle<Slots>`), typed to exactly the cached phases
and steps declared *before* the current one in the script. An uncached phase
contributes no slot at all.

Runtime behavior (`createCacheHandle` in `src/cache.ts`), built from a
`Map<string, SlotBinding>` where `SlotBinding = { store: CacheStore; schema: boolean }`:

- **`read(slot, options?)`**: looks up the slot's binding — a slot the script
  never declared throws `StepDefinitionError` at runtime (listing the known
  slot names), though this case is normally already excluded by the types.
  On a store miss, returns `undefined`. On a hit:
  - if `options.raw` is true, or the slot declared a `schema` (already
    checked on the way in), returns `entry.value` as-is.
  - otherwise wraps it with `guardShape(entry.value, slot)` (see below).
- **`write(slot, value, options?)`**: if `options.keepAge` is true, first
  reads the existing entry and reuses its `savedAt`; otherwise stamps
  `savedAt: Date.now()`. Always writes `{ value, savedAt }` to the slot's
  store — `write` does not merge with the previous value, it replaces it.
- **`clear(slot)`**: delegates straight to the slot's `store.clear(slot)`.
- **`ageOf(slot)`**: reads the entry and returns
  `Math.max(0, Date.now() - entry.savedAt)`, or `undefined` if there is no
  entry.

Invalidation flows backward only: a later step can drop or correct an
earlier phase's entry, never the reverse — a phase's slot is only known to
the type system once that phase has actually been declared earlier in the
chain.

## `SlotValue<Schema, Delta>`

```ts
type SlotValue<Schema, Delta> = unknown extends Schema ? Delta : Schema;
```

Type-level only, not called directly. Drives what `CacheHandle<Slots>`
infers a slot reads back as: the `schema`'s output type when one was
declared on that phase/step, otherwise the phase's (or step's) own inferred
delta type.

## Shape guard: `guardShape` and `CacheShapeError`

```ts
function guardShape<T>(value: T, slot: string, path?: string): T
```

Wraps an object or array read back from a store (recursively, on further
property access) in a `Proxy` so that touching a field the stored object
does not actually have throws `CacheShapeError` instead of silently
returning `undefined`. Exists because, without a declared `schema`, the
type a slot reads back as is just the phase's/step's own inferred delta —
correct until an entry written by an older version of the script (with a
different shape) outlives the code that wrote it.

Mechanics:

- Only the `get` trap is installed — `set` (patching a field before writing
  it back) is left alone, since assignment is how a value gets corrected
  before a `cache.write`.
- A fixed passthrough set of property names is never guarded, because
  runtime machinery probes them on arbitrary objects: `then` (so `await`
  works), `toJSON`, `constructor`, `valueOf`, `toString`, `inspect`,
  `length`. All symbol keys pass through too.
- An array index (`/^(0|[1-9]\d*)$/`) is treated as ordinary JS and never
  throws even if out of bounds — `orders[9]` on a 3-item array is a normal
  miss, not a shape violation.
- Any other key throws `CacheShapeError` unless it is present via
  `Object.hasOwn(target, key)` or found on the prototype chain
  (`key in (Object.getPrototypeOf(target) ?? {})`).
- On a legal access, the returned value is itself wrapped again with
  `guardShape`, carrying forward a dotted `path` (e.g. `"orders.0.date"`) so
  the eventual `CacheShapeError` names the exact field.
- A slot with a declared `schema` skips this wrapping entirely on `read`
  (`createCacheHandle`'s `options?.raw || binding.schema` check) — the
  schema validation on the way in already guarantees the shape.

Where the throw actually happens matters: because the guard is a live Proxy,
it travels with the value into `ctx` if you return it from a handler without
`{ raw: true }`. The `CacheShapeError` then throws wherever a later step
first touches the missing field — not at the original `cache.read()` call
site.

`CacheShapeError` (from `src/errors.ts`, re-exported from the package root)
carries the slot name and the offending dotted path; its message names both
and suggests either `cache.clear(slot)` or adding a `schema` to reject
mismatches on read instead of throwing downstream.
