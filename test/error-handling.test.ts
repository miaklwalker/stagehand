import assert from "node:assert/strict";
import test from "node:test";

import { Script, StepTimeoutError, isAbort } from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;

test("retries never trigger a rollback; it runs once, after the last attempt, for earlier steps only", async () => {
  const log: string[] = [];
  let tries = 0;
  const result = await new Script({ name: "t", ...quiet })
    .addStep({ name: "a", handler: () => (log.push("a"), {}), rollback: () => void log.push("rb a") })
    .addStep({
      name: "b",
      retry: { attempts: 3 },
      handler: () => {
        log.push(`b${++tries}`);
        throw new Error("x");
      },
      rollback: () => void log.push("rb b"),
    })
    .addStep({ name: "c", handler: () => void log.push("c") })
    .run();

  assert.deepEqual(log, ["a", "b1", "b2", "b3", "rb a"]);
  assert.deepEqual(
    result.steps.map((s) => `${s.name}:${s.status}:${s.attempts}`),
    ["a:rolled-back:1", "b:failed:3", "c:pending:0"],
  );
});

test("a step that succeeds on a retry is completed, and rolled back once", async () => {
  const log: string[] = [];
  let tries = 0;
  await new Script({ name: "t", ...quiet })
    .addStep({
      name: "a",
      retry: { attempts: 3 },
      handler: () => {
        if (++tries < 2) throw new Error("flaky");
        return { id: tries };
      },
      rollback: ({ output }) => void log.push(`rb a ${output.id}`),
    })
    .addStep({ name: "b", handler: () => { throw new Error("x"); } })
    .run();

  assert.deepEqual(log, ["rb a 2"]);
});

test("a timeout is retried and is not a cancellation", async () => {
  let tries = 0;
  const result = await new Script({ name: "t", ...quiet })
    .addStep({
      name: "slow",
      timeoutMs: 20,
      retry: { attempts: 3 },
      handler: () => {
        tries += 1;
        return new Promise<never>(() => {});
      },
    })
    .run();

  assert.equal(tries, 3);
  assert.ok(!result.ok);
  assert.ok(!result.ok && result.error instanceof StepTimeoutError);
  assert.equal(!result.ok && result.status, "failed");
  assert.equal(!result.ok && isAbort(result.error), false);
});

test('rollback: "phase" only unwinds the failing phase; "none" unwinds nothing', async () => {
  const run = async (rollback: "all" | "phase" | "none") => {
    const log: string[] = [];
    await new Script({ name: "t", rollback, ...quiet })
      .addPhase("P1")
      .addStep({ name: "a", handler: () => ({}), rollback: () => void log.push("a") })
      .addPhase("P2")
      .addStep({ name: "b", handler: () => ({}), rollback: () => void log.push("b") })
      .addStep({ name: "c", handler: () => { throw new Error("x"); }, rollback: () => void log.push("c") })
      .run();
    return log;
  };

  assert.deepEqual(await run("all"), ["b", "a"]);
  assert.deepEqual(await run("phase"), ["b"]);
  assert.deepEqual(await run("none"), []);
});

test("a failing rollback is recorded, the rest still run, and the original error stands", async () => {
  const log: string[] = [];
  const result = await new Script({ name: "t", ...quiet })
    .addStep({ name: "a", handler: () => ({}), rollback: () => void log.push("a") })
    .addStep({ name: "b", handler: () => ({}), rollback: () => { throw new Error("rb fail"); } })
    .addStep({ name: "c", handler: () => { throw new Error("orig"); } })
    .run();

  assert.deepEqual(log, ["a"]);
  assert.ok(!result.ok);
  assert.equal(!result.ok && (result.error as Error).message, "orig");
  assert.deepEqual(
    !result.ok && result.rollbacks.map((r) => `${r.step}:${r.ok}`),
    ["b:false", "a:true"],
  );
});

test("cancelling between steps stops the run as aborted, and still compensates", async () => {
  const log: string[] = [];
  const controller = new AbortController();
  const result = await new Script({ name: "t", ...quiet })
    .addStep({
      name: "a",
      handler: () => {
        controller.abort();
        return {};
      },
      rollback: () => void log.push("rb a"),
    })
    .addStep({ name: "b", handler: () => void log.push("b") })
    .run(undefined, { signal: controller.signal });

  assert.ok(!result.ok);
  assert.equal(!result.ok && result.status, "aborted");
  assert.deepEqual(log, ["rb a"]);
});

test("an error thrown inside a branch condition is an ordinary step failure that rolls back", async () => {
  const log: string[] = [];
  const result = await new Script({ name: "t", ...quiet })
    .addStep({ name: "a", handler: () => ({}), rollback: () => void log.push("rb a") })
    .addBranch({
      name: "b",
      condition: () => { throw new Error("cond"); },
      onTrue: () => ({}),
      onFalse: () => ({}),
    })
    .run();

  assert.equal(!result.ok && result.status, "failed");
  assert.deepEqual(log, ["rb a"]);
});
