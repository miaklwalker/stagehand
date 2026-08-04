import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
 * One JSON file, holding every slot that points at it. Several phases may
 * share a path safely.
 *
 * A missing, unreadable or malformed file all mean the same thing — no cache
 * yet — so deleting the file is always a valid way to start over. Values must
 * survive `JSON.stringify`; anything that does not (a `Date`, a class
 * instance) comes back as its JSON shape, which is what `schema` is for.
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
  // half-serialised cache behind for the next one to choke on.
  const writeAll = async (data: Record<string, unknown>): Promise<void> => {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temp, target);
  };

  return {
    async read(slot) {
      const entry = (await readAll())[slot];
      return isEntry(entry) ? entry : undefined;
    },
    async write(slot, entry) {
      const data = await readAll();
      data[slot] = entry;
      await writeAll(data);
    },
    async clear(slot) {
      const data = await readAll();
      if (!Object.hasOwn(data, slot)) return;
      delete data[slot];
      await writeAll(data);
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
