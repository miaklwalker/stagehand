import assert from "node:assert/strict";
import test from "node:test";

import { Script, memoryStore } from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;

const build = () =>
  new Script<{ service: string }>({ name: "t", ...quiet })
    .defineFlag({ name: "sha" })
    .addPhase("Resolve")
    .addBranch({
      name: "resolve commit",
      condition: ({ flags }) => Boolean(flags.sha),
      onTrue: ({ flags }) => ({ sha: flags.sha as string }),
      onFalse: async ({ input }) => ({ sha: `head-of-${input.service}` }),
    })
    .addStep({ name: "use", handler: ({ ctx }) => ({ short: ctx.sha.slice(0, 4) }) });

test("onTrue runs when the condition is true", async () => {
  const result = await build().run({ service: "api" }, { argv: ["--sha", "abcdef"] });
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.ctx, { sha: "abcdef", short: "abcd" });
});

test("onFalse runs when the condition is false", async () => {
  const result = await build().run({ service: "api" }, { argv: [] });
  assert.ok(result.ok);
  assert.equal(result.ok && result.ctx.sha, "head-of-api");
});

test("only the chosen arm executes, and an async condition is awaited", async () => {
  const calls: string[] = [];
  const result = await new Script({ name: "t", ...quiet })
    .addBranch({
      name: "pick",
      condition: async () => false,
      onTrue: () => (calls.push("true"), { v: 1 }),
      onFalse: () => (calls.push("false"), { v: 2 }),
    })
    .run();
  assert.ok(result.ok);
  assert.deepEqual(calls, ["false"]);
  assert.equal(result.ok && result.ctx.v, 2);
});

test("the arms must return the same shape", () => {
  new Script({ name: "t", ...quiet }).addBranch({
    name: "bad",
    condition: () => true,
    onTrue: () => ({ sha: "x" }),
    // @ts-expect-error - onFalse returns a different shape than onTrue
    onFalse: () => ({ other: 1 }),
  });
});

test("a branch with retry reruns the whole step", async () => {
  let attempts = 0;
  const result = await new Script({ name: "t", ...quiet })
    .addBranch({
      name: "flaky",
      retry: { attempts: 2 },
      condition: () => true,
      onTrue: () => {
        if (++attempts < 2) throw new Error("boom");
        return { ok: true };
      },
      onFalse: () => ({ ok: false }),
    })
    .run();
  assert.ok(result.ok);
  assert.equal(attempts, 2);
});

test("a duplicate name still throws, and a cached phase holds the branch's output", async () => {
  const store = memoryStore();
  let runs = 0;
  const make = () =>
    new Script({ name: "t", ...quiet })
      .addPhase("P", { cache: store })
      .addBranch({
        name: "b",
        condition: () => true,
        onTrue: () => (runs++, { v: 1 }),
        onFalse: () => ({ v: 2 }),
      });
  await make().run();
  await make().run();
  assert.equal(runs, 1);
  assert.throws(() =>
    new Script({ name: "t", ...quiet })
      .addBranch({ name: "b", condition: () => true, onTrue: () => ({}), onFalse: () => ({}) })
      .addBranch({ name: "b", condition: () => true, onTrue: () => ({}), onFalse: () => ({}) }),
  );
});
