import assert from "node:assert/strict";
import test from "node:test";

import { Script, StepTimeoutError } from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("context accumulates across steps and phases", async () => {
  const result = await new Script<{ id: string }>({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({ name: "one", handler: ({ input }) => ({ upper: input.id.toUpperCase() }) })
    .addPhase("B")
    .addStep({ name: "two", handler: ({ ctx }) => ({ length: ctx.upper.length }) })
    .run({ id: "abc" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.ctx, { upper: "ABC", length: 3 });
});

test("a step returning nothing leaves the context untouched", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({ name: "one", handler: () => ({ a: 1 }) })
    .addStep({ name: "two", handler: () => {} })
    .run();

  assert.deepEqual(result.ok && result.ctx, { a: 1 });
});

test("later steps overwrite earlier keys", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({ name: "one", handler: () => ({ v: "first" }) })
    .addStep({ name: "two", handler: () => ({ v: 2 }) })
    .run();

  assert.deepEqual(result.ok && result.ctx, { v: 2 });
});

test("rollback runs in reverse order, only for completed steps", async () => {
  const order: string[] = [];

  const result = await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({
      name: "one",
      handler: () => ({ one: true }),
      rollback: () => void order.push("one"),
    })
    .addStep({
      name: "two",
      handler: () => ({ two: true }),
      rollback: () => void order.push("two"),
    })
    .addStep({
      name: "three",
      handler: () => {
        throw new Error("boom");
      },
      rollback: () => void order.push("three"),
    })
    .run();

  assert.equal(result.ok, false);
  assert.deepEqual(order, ["two", "one"]);
  assert.equal(result.ok === false && result.failedAt?.step, "three");
  assert.equal(result.ok === false && result.rollbacks.every((r) => r.ok), true);
});

test("rollback receives that step's own output", async () => {
  let seen: unknown;

  await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({
      name: "one",
      handler: () => ({ token: "tok_1" }),
      rollback: ({ output }) => {
        seen = output;
      },
    })
    .addStep({
      name: "two",
      handler: () => {
        throw new Error("boom");
      },
    })
    .run();

  assert.deepEqual(seen, { token: "tok_1" });
});

test("rollback mode 'phase' unwinds only the failing phase", async () => {
  const order: string[] = [];

  await new Script({ name: "t", rollback: "phase", ...quiet })
    .addPhase("A")
    .addStep({ name: "a1", handler: () => ({}), rollback: () => void order.push("a1") })
    .addPhase("B")
    .addStep({ name: "b1", handler: () => ({}), rollback: () => void order.push("b1") })
    .addStep({
      name: "b2",
      handler: () => {
        throw new Error("boom");
      },
    })
    .run();

  assert.deepEqual(order, ["b1"]);
});

test("rollback mode 'none' skips compensation entirely", async () => {
  let called = false;

  await new Script({ name: "t", rollback: "none", ...quiet })
    .addPhase("A")
    .addStep({
      name: "a1",
      handler: () => ({}),
      rollback: () => {
        called = true;
      },
    })
    .addStep({
      name: "a2",
      handler: () => {
        throw new Error("boom");
      },
    })
    .run();

  assert.equal(called, false);
});

test("a failing rollback is reported without masking the original error", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({
      name: "one",
      handler: () => ({}),
      rollback: () => {
        throw new Error("cleanup failed");
      },
    })
    .addStep({
      name: "two",
      handler: () => {
        throw new Error("original");
      },
    })
    .run();

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && (result.error as Error).message, "original");
  assert.equal(result.ok === false && result.rollbacks[0]?.ok, false);
});

test("retry re-runs the handler until it succeeds", async () => {
  let attempts = 0;

  const result = await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({
      name: "flaky",
      retry: { attempts: 3, delayMs: 1 },
      handler: () => {
        attempts += 1;
        if (attempts < 3) throw new Error("flaky");
        return { attempts };
      },
    })
    .run();

  assert.equal(attempts, 3);
  assert.equal(result.steps[0]?.attempts, 3);
  assert.equal(result.ok && result.ctx.attempts, 3);
});

test("retryIf can veto a retry", async () => {
  let attempts = 0;

  await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({
      name: "fatal",
      retry: { attempts: 5, delayMs: 1, retryIf: (error) => !(error as Error).message.includes("fatal") },
      handler: () => {
        attempts += 1;
        throw new Error("fatal error");
      },
    })
    .run();

  assert.equal(attempts, 1);
});

test("when() skips a step without running its rollback", async () => {
  let rolledBack = false;

  const result = await new Script<{ prod: boolean }>({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({
      name: "prod only",
      when: ({ input }) => input.prod,
      handler: () => ({ notified: true }),
      rollback: () => {
        rolledBack = true;
      },
    })
    .addStep({
      name: "boom",
      handler: () => {
        throw new Error("boom");
      },
    })
    .run({ prod: false });

  assert.equal(result.steps[0]?.status, "skipped");
  assert.equal(rolledBack, false);
});

test("phase-level when() skips every step in the phase", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .addPhase("Optional", { when: () => false })
    .addStep({ name: "a", handler: () => ({}) })
    .addStep({ name: "b", handler: () => ({}) })
    .run();

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["skipped", "skipped"],
  );
});

test("timeoutMs aborts a hung step", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({ name: "hang", timeoutMs: 30, handler: () => wait(5_000) })
    .run();

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error instanceof StepTimeoutError, true);
});

test("an external signal cancels the run and still compensates", async () => {
  const controller = new AbortController();
  let rolledBack = false;

  const script = new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({
      name: "one",
      handler: () => ({}),
      rollback: () => {
        rolledBack = true;
      },
    })
    .addStep({ name: "two", handler: () => wait(5_000) });

  const running = script.run(undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const result = await running;

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, "aborted");
  assert.equal(rolledBack, true);
});

test("throwOnError surfaces the original error", async () => {
  await assert.rejects(
    () =>
      new Script({ name: "t", throwOnError: true, ...quiet })
        .addPhase("A")
        .addStep({
          name: "one",
          handler: () => {
            throw new Error("nope");
          },
        })
        .run(),
    /nope/,
  );
});

test("the callback form of addPhase preserves the type flow", async () => {
  const result = await new Script<{ n: number }>({ name: "t", ...quiet })
    .addPhase("A", (s) =>
      s
        .addStep({ name: "double", handler: ({ input }) => ({ doubled: input.n * 2 }) })
        .addStep({ name: "label", handler: ({ ctx }) => ({ label: `n=${ctx.doubled}` }) }),
    )
    .addPhase("B")
    .addStep({ name: "use", handler: ({ ctx }) => ({ echo: ctx.label }) })
    .run({ n: 21 });

  assert.deepEqual(result.ok && result.ctx, { doubled: 42, label: "n=42", echo: "n=42" });
});

test("outline() reports the declared structure", () => {
  const script = new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({ name: "a1", handler: () => ({}) })
    .addPhase("B")
    .addStep({ name: "b1", handler: () => ({}) });

  assert.deepEqual(script.outline(), [
    { phase: "A", steps: ["a1"] },
    { phase: "B", steps: ["b1"] },
  ]);
});

test("partial context is returned after a failure", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({ name: "one", handler: () => ({ kept: "yes" }) })
    .addStep({
      name: "two",
      handler: () => {
        throw new Error("boom");
      },
    })
    .run();

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false && result.ctx, { kept: "yes" });
});
