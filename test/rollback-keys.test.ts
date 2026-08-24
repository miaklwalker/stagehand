import assert from "node:assert/strict";
import test from "node:test";

import { Script, StepDefinitionError, stepFor } from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;
const boom = {
  name: "boom",
  handler: () => {
    throw new Error("boom");
  },
} as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

test("rollback receives only the keys it declared", async () => {
  let seen: unknown;

  await new Script<{ a: number; secret: string }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ ...input }) })
    .addStep({
      name: "one",
      handler: ({ ctx }) => ({ made: ctx.a + 1 }),
      rollbackKeys: ["a", "made"],
      rollback: ({ ctx }) => {
        seen = { ...ctx };
      },
    })
    .addStep(boom)
    .run({ a: 2, secret: "hush" });

  assert.deepEqual(seen, { a: 2, made: 3 });
});

test("without rollbackKeys a rollback gets no context at all", async () => {
  let seen: unknown;

  await new Script<{ a: number }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ a: input.a }) })
    .addStep({
      name: "one",
      handler: () => ({ made: true }),
      rollback: ({ ctx }) => {
        seen = { ...ctx };
      },
    })
    .addStep(boom)
    .run({ a: 2 });

  assert.deepEqual(seen, {});
});

test("output reaches the rollback in full even when the context was cleaned", async () => {
  let seenOutput: unknown;
  let seenCtx: unknown;

  await new Script<{ a: number }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ a: input.a }) })
    .addStep({
      name: "one",
      handler: () => ({ token: "tok_1", scratch: "temp" }),
      rollbackKeys: ["a"],
      rollback: ({ ctx, output }) => {
        seenCtx = { ...ctx };
        seenOutput = output;
      },
    })
    .addStep({ name: "drop it", handler: () => ({}), clean: ["scratch"] })
    .addStep(boom)
    .run({ a: 2 });

  assert.deepEqual(seenOutput, { token: "tok_1", scratch: "temp" });
  assert.deepEqual(seenCtx, { a: 2 });
});

test("a later step cannot clean a reserved key", () => {
  const script = new Script<{ a: number; b: string }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ ...input }) })
    .addStep({
      name: "one",
      handler: () => {},
      rollbackKeys: ["a"],
      rollback: () => {},
    });

  assert.throws(
    () =>
      script.addStep({
        name: "two",
        handler: () => {},
        clean: [
          // @ts-expect-error - "a" is reserved by step one's rollbackKeys
          "a",
        ],
      }),
    (error: unknown) =>
      error instanceof StepDefinitionError && /reserved by rollbackKeys/.test(error.message),
  );
});

test("a step cannot clean its own rollbackKeys", () => {
  const script = new Script<{ a: number; b: string }>({ name: "t", ...quiet }).addStep({
    name: "seed",
    handler: ({ input }) => ({ ...input }),
  });

  assert.throws(
    () =>
      script.addStep({
        name: "one",
        handler: () => {},
        rollbackKeys: ["a"],
        rollback: () => {},
        clean: ["a"],
      }),
    /reserved by rollbackKeys/,
  );
});

test("a reserved key stays reserved across phases", () => {
  const script = new Script<{ a: number; b: string }>({ name: "t", ...quiet })
    .addPhase("One")
    .addStep({ name: "seed", handler: ({ input }) => ({ ...input }) })
    .addStep({ name: "reserve", handler: () => {}, rollbackKeys: ["a"], rollback: () => {} })
    .addPhase("Two");

  assert.throws(
    () =>
      script.addStep({
        name: "late",
        handler: () => {},
        clean: [
          // @ts-expect-error - still reserved, two phases later
          "a",
        ],
      }),
    StepDefinitionError,
  );
});

test("rollback's ctx is narrowed to the declared keys", () => {
  new Script<{ a: number; secret: string }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ ...input }) })
    .addStep({
      name: "one",
      handler: ({ ctx }) => ({ made: ctx.a + 1 }),
      rollbackKeys: ["a", "made"],
      rollback: ({ ctx }) => {
        type _narrowed = Expect<Equal<typeof ctx, { a: number; made: number }>>;
        assert.ok(true as _narrowed);

        // @ts-expect-error - never asked for it
        ctx.secret;
      },
    });

  assert.ok(true);
});

test("with no rollbackKeys the rollback's ctx is empty", () => {
  new Script<{ a: number }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ a: input.a }) })
    .addStep({
      name: "one",
      handler: () => ({ made: true }),
      rollback: ({ ctx }) => {
        type _empty = Expect<Equal<typeof ctx, {}>>;
        assert.ok(true as _empty);
      },
    });

  assert.ok(true);
});

test("rollbackKeys only accepts keys of the step's context or output", () => {
  new Script<{ a: number }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ a: input.a }) })
    .addStep({
      name: "one",
      handler: () => ({ made: 1 }),
      // @ts-expect-error - "nope" is neither in the context nor in the output
      rollbackKeys: ["nope"],
      rollback: () => {},
    });

  assert.ok(true);
});

test("an async step that returns nothing can roll back an earlier step's key", async () => {
  let seen: unknown;
  let read: unknown;

  const script = new Script({ name: "t", ...quiet })
    .addStep({
      name: "build results",
      handler: async () => ({ results: [{ name: "fancy!" }] }),
    })
    .addStep({
      name: "use results",
      rollbackKeys: ["results"],
      rollback: async ({ ctx }) => {
        type _narrowed = Expect<Equal<typeof ctx, { results: { name: string }[] }>>;
        assert.ok(true as _narrowed);
        seen = { ...ctx };
      },
      // Returns nothing *and* reads a key an earlier step produced. `Out` used
      // to be inferred from `rollbackKeys` here — as `{ results: any }` — and
      // collide with the handler's own `Promise<void>`.
      handler: async ({ ctx }) => {
        type _ctx = Expect<Equal<typeof ctx, { results: { name: string }[] }>>;
        assert.ok(true as _ctx);
        read = ctx.results.map((entry) => entry.name);
      },
    })
    // The step contributed nothing, so a later step sees exactly what came
    // before it — not `{ results: any }`, and not a context missing `results`.
    .addStep({
      name: "later",
      handler: ({ ctx }) => {
        type _flowed = Expect<Equal<typeof ctx, { results: { name: string }[] }>>;
        assert.ok(true as _flowed);
      },
    })
    .addStep(boom);

  const result = await script.run();

  assert.ok(!result.ok);
  assert.deepEqual(read, ["fancy!"]);
  assert.deepEqual(seen, { results: [{ name: "fancy!" }] });
});

test("stepFor carries rollbackKeys, and the reservation survives addStep", () => {
  const makeResource = stepFor<{ userId: string }, { userId: string }>()({
    name: "make resource",
    handler: () => ({ resourceId: "r1" }),
    rollbackKeys: ["resourceId"],
    rollback: ({ ctx }) => {
      type _picked = Expect<Equal<typeof ctx, { resourceId: string }>>;
      assert.ok(true as _picked);
    },
  });

  const script = new Script<{ userId: string }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ userId: input.userId }) })
    .addStep(makeResource);

  assert.throws(
    () =>
      script.addStep({
        name: "next",
        handler: () => {},
        clean: [
          // @ts-expect-error - "resourceId" is reserved by the standalone step
          "resourceId",
        ],
      }),
    /reserved by rollbackKeys/,
  );
});
