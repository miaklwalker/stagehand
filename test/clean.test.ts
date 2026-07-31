import assert from "node:assert/strict";
import test from "node:test";

import { Script } from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

test("a cleaned key is gone from later steps and from the result", async () => {
  let seen: Record<string, unknown> = {};

  const result = await new Script<{ secret: string; keep: number }>({ name: "t", ...quiet })
    .addStep({ name: "load", handler: ({ input }) => ({ ...input }) })
    .addStep({
      name: "use secret",
      handler: ({ ctx }) => ({ derived: ctx.secret.length }),
      // the raw secret is not needed past this point
      clean: ["secret"],
    })
    .addStep({
      name: "later",
      handler: ({ ctx }) => {
        seen = { ...ctx };
      },
    })
    .run({ secret: "hunter2", keep: 1 });

  assert.equal("secret" in seen, false);
  assert.deepEqual(seen, { keep: 1, derived: 7 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.ctx, { keep: 1, derived: 7 });
});

test("a step can clean an incoming key while adding its own", async () => {
  const result = await new Script<{ a: number }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ a: input.a }) })
    .addStep({
      name: "derive",
      handler: ({ ctx }) => ({ temp: ctx.a * 10, b: ctx.a + 1 }),
      clean: ["a"],
    })
    .run({ a: 2 });

  assert.deepEqual(result.ok && result.ctx, { temp: 20, b: 3 });
});

test("clean still applies when the step is skipped by when()", async () => {
  const result = await new Script<{ secret: string }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ secret: input.secret }) })
    .addStep({
      name: "optional",
      when: () => false,
      handler: () => ({ used: true }),
      clean: ["secret"],
    })
    .run({ secret: "hush" });

  assert.equal(result.steps[1]?.status, "skipped");
  assert.deepEqual(result.ok && result.ctx, {});
});

test("clean applies to every step of a phase skipped by when()", async () => {
  const result = await new Script<{ secret: string }>({ name: "t", ...quiet })
    .addPhase("Setup")
    .addStep({ name: "seed", handler: ({ input }) => ({ secret: input.secret, keep: 1 }) })
    .addPhase("Optional", { when: () => false })
    .addStep({ name: "a", handler: () => ({}), clean: ["secret"] })
    .run({ secret: "hush" });

  assert.deepEqual(result.ok && result.ctx, { keep: 1 });
});

test("the cleaned key leaves the context type", () => {
  const script = new Script<{ secret: string; keep: number }>({ name: "t", ...quiet })
    .addStep({ name: "load", handler: ({ input }) => ({ ...input }) })
    .addStep({
      name: "use",
      handler: ({ ctx }) => ({ derived: ctx.secret.length }),
      clean: ["secret"],
    });

  script.addStep({
    name: "next",
    handler: ({ ctx }) => {
      // @ts-expect-error - `secret` was cleaned away
      ctx.secret;

      type _kept = Expect<Equal<typeof ctx, { keep: number; derived: number }>>;
      assert.ok(true as _kept);
    },
  });

  assert.ok(true);
});

test("clean only accepts keys of the step's incoming context", () => {
  new Script<{ a: number }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ a: input.a }) })
    .addStep({
      name: "s",
      handler: () => {},
      clean: [
        // @ts-expect-error - "nope" is not in the context here
        "nope",
      ],
    });

  assert.ok(true);
});

test("clean does not accept a key the same step adds", () => {
  new Script<{ a: number }>({ name: "t", ...quiet })
    .addStep({ name: "seed", handler: ({ input }) => ({ a: input.a }) })
    .addStep({
      name: "s",
      handler: ({ ctx }) => ({ temp: ctx.a * 10 }),
      clean: [
        // @ts-expect-error - "temp" is this step's output, not its input
        "temp",
      ],
    });

  assert.ok(true);
});
