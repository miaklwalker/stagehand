import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CacheShapeError, StepDefinitionError } from "./errors.js";

import type {
  CacheMode,
  CacheOptions,
  CacheSource,
  CacheStore,
  CachedEntry,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Stores                                                                      */
/* -------------------------------------------------------------------------- */

/** Lives for the lifetime of the process. Useful in tests, and for re-runs. */
export function memoryStore(): CacheStore {
  const slots = new Map<string, CachedEntry>();
  return {
    read: (slot) => slots.get(slot),
    write: (slot, entry) => {
      slots.set(slot, entry);
    },
    clear: (slot) => {
      slots.delete(slot);
    },
  };
}

/**
 * In-process write queues, keyed by resolved path so two `fileStore` calls on
 * the same file share one.
 *
 * Every write is a read-modify-write of the whole file, which is only correct
 * if writes to that file never overlap. They otherwise lose each other's slots
 * and race on the temp file. Cross-process safety is out of scope: two `node`
 * processes writing one cache file can still interleave.
 */
const writeQueues = new Map<string, Promise<unknown>>();
let tempCounter = 0;

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (writeQueues.get(key) ?? Promise.resolve()).then(task, task);
  // A failed write must not poison the writes queued behind it.
  writeQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * One JSON file, holding every slot that points at it. Several phases may
 * share a path safely, and concurrent writes to one path are serialised.
 *
 * A missing, unreadable or malformed file all mean the same thing — no cache
 * yet — so deleting the file is always a valid way to start over. Values must
 * survive `JSON.stringify`; anything that does not (a `Date`, a class
 * instance) comes back as its JSON shape.
 */
export function fileStore(filePath: string): CacheStore {
  const target = resolve(filePath);

  const readAll = async (): Promise<Record<string, unknown>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
      if (parsed === null || typeof parsed !== "object") return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  // Written through a temp file so an interrupted run cannot leave a
  // half-serialised cache behind for the next one to choke on. The temp name
  // carries a counter as well as the pid — the pid alone is shared by every
  // write in the process, which is exactly how concurrent writes used to
  // rename each other's files out from under themselves.
  const writeAll = async (data: Record<string, unknown>): Promise<void> => {
    await mkdir(dirname(target), { recursive: true });
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    const temp = `${target}.${process.pid}.${(tempCounter += 1)}.tmp`;

    try {
      await writeFile(temp, payload, "utf8");
      try {
        await rename(temp, target);
      } catch (error) {
        // Windows, antivirus, editors and file watchers can all hold the
        // destination open and refuse the atomic swap. Writing in place gives
        // up atomicity rather than the write.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY" && code !== "EEXIST") {
          throw error;
        }
        await writeFile(target, payload, "utf8");
      }
    } finally {
      await rm(temp, { force: true });
    }
  };

  const update = (mutate: (data: Record<string, unknown>) => boolean): Promise<void> =>
    serialize(target, async () => {
      const data = await readAll();
      if (!mutate(data)) return;
      await writeAll(data);
    });

  return {
    async read(slot) {
      const entry = (await readAll())[slot];
      return isEntry(entry) ? entry : undefined;
    },
    write(slot, entry) {
      return update((data) => {
        data[slot] = entry;
        return true;
      });
    },
    clear(slot) {
      return update((data) => {
        if (!Object.hasOwn(data, slot)) return false;
        delete data[slot];
        return true;
      });
    },
  };
}

/** A hand-edited or older-format file should read as a miss, not as a crash. */
function isEntry(value: unknown): value is CachedEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof (value as CachedEntry).savedAt === "number"
  );
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                     */
/* -------------------------------------------------------------------------- */

/** `cache: someStore` is shorthand for `cache: { store: someStore }`. */
export function normalizeCache(source: CacheSource | undefined): CacheOptions | undefined {
  if (!source) return undefined;
  if (typeof (source as CacheStore).read === "function") {
    return { store: source as CacheStore };
  }
  return source as CacheOptions;
}

export type CacheLookup =
  | { hit: true; value: unknown; ageMs: number }
  | { hit: false };

const MISS: CacheLookup = { hit: false };

/**
 * Read an entry and put it through every gate. A failure at any gate is a
 * miss — the work runs and the entry is replaced — never an error.
 */
export async function readCache(
  cache: CacheOptions,
  slot: string,
  input: unknown,
  ctx: unknown,
  mode: CacheMode,
): Promise<CacheLookup> {
  if (mode === "off" || mode === "refresh") return MISS;

  const entry = await cache.store.read(slot);
  if (!entry) return MISS;

  let value = entry.value;

  if (cache.schema) {
    const result = await cache.schema["~standard"].validate(value);
    if (result.issues) return MISS;
    value = result.value;
  }

  const ageMs = Math.max(0, Date.now() - entry.savedAt);
  if (cache.stale && (await cache.stale({ value, input, ctx, savedAt: entry.savedAt, ageMs }))) {
    return MISS;
  }

  return { hit: true, value, ageMs };
}

/** Only ever called after the phase or step has fully succeeded. */
export async function writeCache(
  cache: CacheOptions,
  slot: string,
  value: unknown,
  mode: CacheMode,
): Promise<void> {
  if (mode === "off" || mode === "read-only") return;
  await cache.store.write(slot, { value, savedAt: Date.now() });
}

/** Identifies a phase's entry. Steps hang off their phase to avoid collisions. */
export const phaseSlot = (phase: string): string => phase;
export const stepSlot = (phase: string, step: string): string => `${phase}::${step}`;

/* -------------------------------------------------------------------------- */
/* Shape guard                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Properties every JavaScript runtime reaches for on an arbitrary object.
 * Trapping them breaks `await` (which probes `then`), `JSON.stringify`,
 * `console.log` and template interpolation — so they pass straight through.
 */
const PASSTHROUGH = new Set([
  "then",
  "toJSON",
  "constructor",
  "valueOf",
  "toString",
  "inspect",
  "length",
]);

/**
 * Wrap a value read back from a store so that touching a field it does not
 * have throws {@link CacheShapeError} instead of yielding `undefined`.
 *
 * Only reads are trapped. Assigning a new property is how you'd legitimately
 * patch an entry before writing it back, so it is left alone — the lie is
 * always on the read side, where the type promised something the JSON lacks.
 *
 * Absent array indices pass through too: `orders[9]` on a short list is
 * ordinary JavaScript, not a shape mismatch.
 */
export function guardShape<T>(value: T, slot: string, path = ""): T {
  if (value === null || typeof value !== "object") return value;

  return new Proxy(value as object, {
    get(target, key, receiver) {
      const actual = Reflect.get(target, key, receiver);
      if (typeof key === "symbol" || PASSTHROUGH.has(key)) return actual;

      const isIndex = Array.isArray(target) && /^(0|[1-9]\d*)$/.test(key);
      const known = Object.hasOwn(target, key) || key in (Object.getPrototypeOf(target) ?? {});
      if (!isIndex && !known) throw new CacheShapeError(slot, path ? `${path}.${key}` : key);

      return guardShape(actual, slot, path ? `${path}.${key}` : key);
    },
  }) as T;
}

/* -------------------------------------------------------------------------- */
/* Handler-facing handle                                                       */
/* -------------------------------------------------------------------------- */

/** Which store backs each slot, and whether that slot validates on read. */
export interface SlotBinding {
  store: CacheStore;
  schema: boolean;
}

/**
 * Build the `cache` handle a handler sees. Slots it does not know about are
 * already unreachable through the types; at runtime they throw rather than
 * silently doing nothing, which is what a plain `store.clear("typo")` does.
 */
export function createCacheHandle(slots: Map<string, SlotBinding>): {
  read(slot: string, options?: { raw?: boolean }): Promise<unknown>;
  write(slot: string, value: unknown, options?: { keepAge?: boolean }): Promise<void>;
  clear(slot: string): Promise<void>;
  ageOf(slot: string): Promise<number | undefined>;
} {
  const bindingFor = (slot: string): SlotBinding => {
    const binding = slots.get(slot);
    if (!binding) {
      const known = [...slots.keys()].map((name) => `"${name}"`).join(", ") || "none";
      throw new StepDefinitionError(
        slot,
        `No cached phase named "${slot}" has been declared before this step. Known slots: ${known}.`,
      );
    }
    return binding;
  };

  return {
    async read(slot, options) {
      const binding = bindingFor(slot);
      const entry = await binding.store.read(slot);
      if (!entry) return undefined;
      // A slot with a schema was validated on the way in, so its type is
      // already backed by a check; only the inferred kind needs guarding.
      if (options?.raw || binding.schema) return entry.value;
      return guardShape(entry.value, slot);
    },
    async write(slot, value, options) {
      const store = bindingFor(slot).store;
      const previous = options?.keepAge ? await store.read(slot) : undefined;
      await store.write(slot, { value, savedAt: previous?.savedAt ?? Date.now() });
    },
    async clear(slot) {
      await bindingFor(slot).store.clear(slot);
    },
    async ageOf(slot) {
      const entry = await bindingFor(slot).store.read(slot);
      return entry ? Math.max(0, Date.now() - entry.savedAt) : undefined;
    },
  };
}
