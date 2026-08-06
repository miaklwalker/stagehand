import assert from "node:assert/strict";
import test from "node:test";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  CacheShapeError,
  type Routine,
  Script,
  memoryStore,
  routineFor,
  stepFor,
} from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;

test("a later step can invalidate an earlier phase's entry", async () => {
  const store = memoryStore();
  let pulls = 0;

  const build = (invalidate: boolean) =>
    new Script({ name: "t", ...quiet })
      .addPhase("Fetch", { cache: { store } })
      .addStep({
        name: "pull",
        handler: () => {
          pulls += 1;
          return { orders: [{ sku: "a", qty: 2 }] };
        },
      })
      .addPhase("Adjust")
      .addStep({
        name: "restock",
        handler: async ({ cache }) => {
          if (invalidate) await cache.clear("Fetch");
          return { done: true };
        },
      });

  await build(false).run();
  await build(false).run();
  assert.equal(pulls, 1, "the second run reuses the entry");

  await build(true).run();
  await build(false).run();
  assert.equal(pulls, 2, "clearing forced exactly one refetch");
});

test("a later step can patch an entry without refetching", async () => {
  const store = memoryStore();
  let pulls = 0;

  const build = (patch: boolean) =>
    new Script({ name: "t", ...quiet })
      .addPhase("Fetch", { cache: { store } })
      .addStep({
        name: "pull",
        handler: () => {
          pulls += 1;
          return { orders: [{ sku: "a", qty: 2 }] };
        },
      })
      .addPhase("Adjust")
      .addStep({
        name: "restock",
        handler: async ({ ctx, cache }) => {
          if (patch) {
            const age = await cache.ageOf("Fetch");
            assert.ok(age !== undefined && age >= 0);
            await cache.write("Fetch", { orders: [{ sku: "a", qty: 99 }] });
          }
          return { seen: ctx.orders[0]?.qty };
        },
      });

  await build(false).run();
  await build(true).run();
  const third = await build(false).run();

  assert.equal(pulls, 1, "patching never refetched");
  assert.equal(third.ok && third.ctx.seen, 99);
});

test("reading a field the stored value lacks throws CacheShapeError", async () => {
  const store = memoryStore();
  // Written by an older shape: no `date_fixed` anywhere.
  await store.write("Fetch", { value: { orders: [{ sku: "a" }] }, savedAt: Date.now() });

  let caught: unknown;
  const result = await new Script({ name: "t", ...quiet, rollback: "none" })
    .addPhase("Fetch", { cache: { store } })
    .addStep({ name: "pull", handler: () => ({ orders: [{ sku: "a" }] }) })
    .addPhase("Read")
    .addStep({
      name: "inspect",
      handler: async ({ cache }) => {
        const stored = await cache.read("Fetch");
        try {
          (stored as unknown as { orders: { date_fixed?: string }[] }).orders[0]?.date_fixed;
        } catch (error) {
          caught = error;
        }
        return {};
      },
    })
    .run();

  assert.equal(result.ok, true);
  assert.ok(caught instanceof CacheShapeError);
  assert.equal(caught.slot, "Fetch");
  assert.equal(caught.path, "orders.0.date_fixed");
  assert.match(caught.message, /cache\.clear\("Fetch"\)/);
});

test("the guard leaves ordinary access, JSON and iteration alone", async () => {
  const store = memoryStore();
  const seen: unknown[] = [];

  await new Script({ name: "t", ...quiet })
    .addPhase("Fetch", { cache: { store } })
    .addStep({ name: "pull", handler: () => ({ orders: [{ sku: "a", qty: 2 }], at: "now" }) })
    .addPhase("Read")
    .addStep({
      name: "inspect",
      handler: async ({ cache }) => {
        const stored = await cache.read("Fetch");
        seen.push(stored?.orders.length);
        seen.push(stored?.orders.map((o) => o.qty));
        seen.push(stored?.orders[9]);
        seen.push(JSON.parse(JSON.stringify(stored)));
        seen.push(`${stored?.at}`);
        return {};
      },
    })
    .run();

  assert.deepEqual(seen, [
    1,
    [2],
    undefined,
    { orders: [{ sku: "a", qty: 2 }], at: "now" },
    "now",
  ]);
});

test("raw: true opts out of the guard", async () => {
  const store = memoryStore();

  await new Script({ name: "t", ...quiet })
    .addPhase("Fetch", { cache: { store } })
    .addStep({ name: "pull", handler: () => ({ orders: [{ sku: "a" }] }) })
    .addPhase("Read")
    .addStep({
      name: "inspect",
      handler: async ({ cache }) => {
        const raw = await cache.read("Fetch", { raw: true });
        // No throw: this is a plain object.
        assert.equal((raw as unknown as { nope?: string }).nope, undefined);
        return {};
      },
    })
    .run();

  assert.ok(true);
});

test("a slot with a schema is validated, so it is not guarded", async () => {
  const store = memoryStore();
  const schema: StandardSchemaV1<unknown, { orders: { sku: string }[] }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({ value: value as { orders: { sku: string }[] } }),
    },
  };

  await new Script({ name: "t", ...quiet })
    .addPhase("Fetch", { cache: { store, schema } })
    .addStep({ name: "pull", handler: () => ({ orders: [{ sku: "a" }] }) })
    .addPhase("Read")
    .addStep({
      name: "inspect",
      handler: async ({ cache }) => {
        const stored = await cache.read("Fetch");
        assert.equal((stored as unknown as { nope?: string }).nope, undefined);
        return {};
      },
    })
    .run();

  assert.ok(true);
});

test("a rollback can invalidate the entry describing the work it undid", async () => {
  const store = memoryStore();
  let pulls = 0;

  const build = (fail: boolean) =>
    new Script({ name: "t", ...quiet })
      .addPhase("Fetch", { cache: { store } })
      .addStep({
        name: "pull",
        handler: () => {
          pulls += 1;
          return { orders: ["a"] };
        },
      })
      .addPhase("Publish")
      .addStep({
        name: "publish",
        handler: () => ({ published: true }),
        rollback: async ({ cache }) => {
          await cache.clear("Fetch");
        },
      })
      .addStep({
        name: "verify",
        handler: () => {
          if (fail) throw new Error("nope");
          return {};
        },
      });

  await build(false).run();
  assert.equal(pulls, 1);

  await build(true).run();
  await build(false).run();
  assert.equal(pulls, 2, "the rollback dropped the entry, so the next run refetched");
});

test("an unknown slot throws at runtime for plain-JS callers", async () => {
  const store = memoryStore();
  let caught: unknown;

  await new Script({ name: "t", ...quiet })
    .addPhase("Fetch", { cache: { store } })
    .addStep({ name: "pull", handler: () => ({ a: 1 }) })
    .addPhase("Read")
    .addStep({
      name: "inspect",
      handler: async ({ cache }) => {
        try {
          await (cache as unknown as { clear(s: string): Promise<void> }).clear("Typo");
        } catch (error) {
          caught = error;
        }
        return {};
      },
    })
    .run();

  assert.match((caught as Error).message, /No cached phase named "Typo"/);
  assert.match((caught as Error).message, /Known slots: "Fetch"/);
});

test("a mounted routine's slots are addressable under their prefix", async () => {
  const store = memoryStore();
  const seen: string[] = [];

  const pull = routineFor<{ channel: string }>()("pull", (s) =>
    s
      .addPhase("Fetch", { cache: { store } })
      .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.channel] }) }),
  );

  await new Script<{ channel: string }>({ name: "t", ...quiet })
    .use(pull, { as: "Amazon" })
    .addPhase("Check")
    .addStep({
      name: "look",
      handler: async ({ cache }) => {
        const entry = await cache.read("Amazon / Fetch");
        seen.push(...(entry?.rows ?? []));
        await cache.clear("Amazon / Fetch");
        return {};
      },
    })
    .run({ channel: "amazon" });

  assert.deepEqual(seen, ["amazon"]);
  assert.equal(await store.read("Amazon / Fetch"), undefined);
});

/* -- Types ----------------------------------------------------------------- */

// A real value, not `declare` — the builder below runs even though only its
// types are under test.
const OrdersSchema: StandardSchemaV1<unknown, { orders: { sku: string }[] }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as { orders: { sku: string }[] } }),
  },
};

test("slot names and values are typed", () => {
  const store = memoryStore();

  const pull = routineFor<{ channel: string }>()("pull", (s) =>
    s
      .addPhase("Fetch", { cache: { store } })
      .addStep({ name: "pull", handler: () => ({ orders: [{ sku: "a", qty: 2 }] }) }),
  );

  new Script<{ channel: string }>({ name: "t", ...quiet })
    .use(pull, { as: "Amazon" })
    .addPhase("Shaped", { cache: { store, schema: OrdersSchema } })
    .addStep({ name: "shape", clean: ["orders"], handler: () => ({ products: { a: 1 } }) })
    .addPhase("Plain")
    .addStep({
      name: "inspect",
      handler: async ({ cache }) => {
        // Inferred from the routine's delta, renamed by `as`.
        const raw = await cache.read("Amazon / Fetch");
        raw?.orders[0]?.qty.toFixed(0);
        // @ts-expect-error - not on the inferred delta
        raw?.nope;

        // A declared schema wins over the delta, which here is { products }.
        const shaped = await cache.read("Shaped");
        shaped?.orders[0]?.sku.toUpperCase();
        // @ts-expect-error - the schema says orders, not products
        shaped?.products;

        // @ts-expect-error - "Plain" declared no cache, so it is not a slot
        await cache.clear("Plain");

        // @ts-expect-error - `as` moved it; the bare name no longer exists
        await cache.clear("Fetch");

        await cache.clear("Amazon / Fetch");
        await cache.ageOf("Shaped");
        return {};
      },
    });

  assert.ok(true);
});

test("a slot is not visible to steps declared before it", () => {
  const store = memoryStore();

  new Script({ name: "t", ...quiet })
    .addPhase("Early")
    .addStep({
      name: "too soon",
      handler: async ({ cache }) => {
        // @ts-expect-error - "Later" has not been declared yet
        await cache.clear("Later");
        return {};
      },
    })
    .addPhase("Later", { cache: { store } })
    .addStep({ name: "work", handler: () => ({ a: 1 }) });

  assert.ok(true);
});

test("write restamps the entry, and keepAge preserves the original clock", async () => {
  const store = memoryStore();
  const ancient = Date.now() - 60 * 60_000;
  await store.write("Fetch", { value: { n: 1 }, savedAt: ancient });

  const build = (keepAge: boolean) =>
    new Script({ name: "t", ...quiet })
      .addPhase("Fetch", { cache: { store } })
      .addStep({ name: "pull", handler: () => ({ n: 1 }) })
      .addPhase("Patch")
      .addStep({
        name: "correct",
        handler: async ({ cache }) => {
          await cache.write("Fetch", { n: 2 }, keepAge ? { keepAge: true } : undefined);
          return {};
        },
      });

  await build(true).run();
  assert.equal((await store.read("Fetch"))?.savedAt, ancient, "keepAge holds the clock");
  assert.deepEqual((await store.read("Fetch"))?.value, { n: 2 }, "and still writes the value");

  await build(false).run();
  assert.ok((await store.read("Fetch"))!.savedAt > ancient, "without it the entry is restamped");
});

test("a stepFor step can use the cache without knowing the host's slots", async () => {
  const store = memoryStore();
  let cleared = false;

  // A step written in its own file cannot know what the host declared, so its
  // slots default to unchecked rather than to `never` — which would silently
  // make `context.cache` uncallable.
  const look = stepFor<{ channel: string }, { rows: string[] }>()({
    name: "look",
    handler: async ({ cache }) => {
      await cache.clear("Fetch");
      cleared = true;
      return {};
    },
  });

  const pull = routineFor<{ channel: string }>()("pull", (s) =>
    s
      .addPhase("Fetch", { cache: { store } })
      .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.channel] }) }),
  );

  await new Script<{ channel: string }>({ name: "t", ...quiet })
    .use(pull)
    .addPhase("Check")
    .addStep(look)
    .run({ channel: "amazon" });

  assert.equal(cleared, true);
  assert.equal(await store.read("Fetch"), undefined);
});

test("a stepFor step may declare the slots it expects, and they are checked", () => {
  const look = stepFor<{ channel: string }, {}, { Fetch: { rows: string[] } }>()({
    name: "look",
    handler: async ({ cache }) => {
      const entry = await cache.read("Fetch");
      entry?.rows[0]?.toUpperCase();
      // @ts-expect-error - not a slot this step declared
      await cache.clear("Nope");
      return {};
    },
  });

  assert.equal(look.name, "look");
});

test("a routine annotated without its slot map still exposes the cache", async () => {
  const store = memoryStore();
  let cleared = false;

  // What an exported routine looks like when the author writes the type out —
  // `Routine<In, Ctx, Out, Reserved>` omits the slot map, which used to
  // collapse the host's slots to `never` and silently disable context.cache.
  const pull: Routine<{ channel: string }, {}, { rows: string[] }, never> = routineFor<{
    channel: string;
  }>()("pull", (s) =>
    s
      .addPhase("Fetch", { cache: { store } })
      .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.channel] }) }),
  );

  await new Script<{ channel: string }>({ name: "t", ...quiet })
    .use(pull)
    .addPhase("Check")
    .addStep({
      name: "look",
      handler: async ({ cache }) => {
        await cache.clear("Fetch");
        cleared = true;
        return {};
      },
    })
    .run({ channel: "amazon" });

  assert.equal(cleared, true);
  assert.equal(await store.read("Fetch"), undefined);
});

test("an unannotated routine keeps its slot names checked", () => {
  const store = memoryStore();

  const pull = routineFor<{ channel: string }>()("pull", (s) =>
    s
      .addPhase("Fetch", { cache: { store } })
      .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.channel] }) }),
  );

  new Script<{ channel: string }>({ name: "t", ...quiet })
    .use(pull)
    .addPhase("Check")
    .addStep({
      name: "look",
      handler: async ({ cache }) => {
        const entry = await cache.read("Fetch");
        entry?.rows[0]?.toUpperCase();
        // @ts-expect-error - inference is intact, so a bad name is still caught
        await cache.clear("Nope");
        return {};
      },
    });

  assert.ok(true);
});

/* -- Step-level slots ------------------------------------------------------ */

test("a cached step contributes its own slot, readable by later steps", async () => {
  const store = memoryStore();
  const seen: unknown[] = [];

  await new Script({ name: "t", ...quiet })
    .addPhase("Fetch")
    .addStep({
      name: "pull orders",
      cache: { store },
      handler: () => ({ orders: [{ sku: "a" }] }),
    })
    .addPhase("Check")
    .addStep({
      name: "look",
      handler: async ({ cache }) => {
        const entry = await cache.read("Fetch::pull orders");
        seen.push(entry?.orders[0]?.sku);
        await cache.clear("Fetch::pull orders");
        return {};
      },
    })
    .run();

  assert.deepEqual(seen, ["a"]);
  assert.equal(await store.read("Fetch::pull orders"), undefined);
});

test("a step slot inside a routine follows the mount's prefix", async () => {
  const store = memoryStore();
  const seen: unknown[] = [];

  const pull = routineFor<{ channel: string }>()("pull", (s) =>
    s
      .addPhase("Fetch")
      .addStep({
        name: "pull",
        cache: { store },
        handler: ({ input }) => ({ rows: [input.channel] }),
      }),
  );

  await new Script<{ channel: string }>({ name: "t", ...quiet })
    .use(pull, { as: "Amazon" })
    .addPhase("Check")
    .addStep({
      name: "look",
      handler: async ({ cache }) => {
        seen.push((await cache.read("Amazon / Fetch::pull"))?.rows);
        return {};
      },
    })
    .run({ channel: "amazon" });

  assert.deepEqual(seen, [["amazon"]]);
});

test("step slots are typed, and only exist when the step caches", () => {
  const store = memoryStore();

  new Script({ name: "t", ...quiet })
    .addPhase("Fetch")
    .addStep({ name: "pull", cache: { store }, handler: () => ({ orders: [{ sku: "a" }] }) })
    .addStep({ name: "plain", handler: () => ({ n: 1 }) })
    .addPhase("Check")
    .addStep({
      name: "look",
      handler: async ({ cache }) => {
        (await cache.read("Fetch::pull"))?.orders[0]?.sku.toUpperCase();
        // @ts-expect-error - "plain" declared no cache
        await cache.clear("Fetch::plain");
        // @ts-expect-error - single colon; the separator is "::"
        await cache.clear("Fetch:pull");
        return {};
      },
    });

  assert.ok(true);
});
