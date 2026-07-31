import assert from "node:assert/strict";
import test from "node:test";

import { Script } from "../dist/index.js";
import { renderBody } from "../dist/ui/frame.js";
import { LiveRenderer } from "../dist/ui/renderer.js";
import type { PhaseState, RunState, StepState } from "../dist/state.js";

/** Collect everything a renderer writes while `fn` runs. */
async function capture(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

function stepState(name: string, extra: Partial<StepState> = {}): StepState {
  return {
    name,
    phaseIndex: 0,
    status: "success",
    attempts: 1,
    tasks: [],
    logs: [],
    hasRollback: false,
    startedAt: 0,
    endedAt: 10,
    ...extra,
  };
}

function runState(steps: StepState[], extra: Partial<RunState> = {}): RunState {
  const phase: PhaseState = { name: "Main", steps };
  return {
    name: "t",
    phases: [phase],
    status: "running",
    startedAt: 0,
    rollbackCount: 0,
    rollbackFailures: 0,
    logTail: [],
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/* Pure rendering: state -> frame, no renderer involved                       */
/* -------------------------------------------------------------------------- */

test("logPlacement 'step': entries render nested under their own step, in order", () => {
  const target = stepState("reserve inventory", {
    logs: [
      { level: "log", message: "checked warehouse A" },
      { level: "warn", message: "warehouse B is low" },
    ],
  });
  const other = stepState("ship it");
  const body = renderBody(runState([target, other]), 0, 20).join("\n");

  const reserveAt = body.indexOf("reserve inventory");
  const aAt = body.indexOf("checked warehouse A");
  const bAt = body.indexOf("warehouse B is low");
  const shipAt = body.indexOf("ship it");

  assert.ok(reserveAt >= 0 && aAt > reserveAt, "log A follows its step's name");
  assert.ok(bAt > aAt, "logs render in the order they were pushed");
  assert.ok(shipAt > bAt, "the next step's line comes after this step's logs");
});

test("logPlacement 'step': a step with no logs renders no extra lines", () => {
  const body = renderBody(runState([stepState("quiet step")]), 0, 20).join("\n");
  assert.doesNotMatch(body, /•/); // the "log" level's bullet icon
});

test("logPlacement 'bottom': the tail renders once, after every phase", () => {
  const body = renderBody(
    runState([stepState("first step"), stepState("second step")], {
      logTail: [
        { level: "log", message: "first tail line" },
        { level: "success", message: "second tail line" },
      ],
    }),
    0,
    20,
  ).join("\n");

  const secondStepAt = body.indexOf("second step");
  const firstAt = body.indexOf("first tail line");
  const secondAt = body.indexOf("second tail line");

  assert.ok(secondStepAt >= 0 && firstAt > secondStepAt, "tail comes after the phase content");
  assert.ok(secondAt > firstAt, "tail entries render in the order they were pushed");
});

test("an empty logTail adds nothing to the frame", () => {
  const withEmpty = renderBody(runState([stepState("a")]), 0, 20);
  const withoutTail = renderBody(runState([stepState("a")], { logTail: [] }), 0, 20);
  assert.deepEqual(withEmpty, withoutTail);
});

/* -------------------------------------------------------------------------- */
/* LiveRenderer: routing and the rolling cap                                  */
/* -------------------------------------------------------------------------- */

test("LiveRenderer with logPlacement 'step' pushes onto the originating step, not the scrollback", async () => {
  const target = stepState("reserve inventory");
  const state = runState([target]);
  const renderer = new LiveRenderer("step");

  await capture(async () => {
    renderer.start(state);
    renderer.log({ level: "log", message: "checked warehouse A" }, target);
    renderer.stop();
  });

  assert.deepEqual(target.logs, [{ level: "log", message: "checked warehouse A" }]);
  assert.deepEqual(state.logTail, []);
});

test("LiveRenderer with logPlacement 'bottom' pushes onto the run's tail, not any step", async () => {
  const target = stepState("reserve inventory");
  const state = runState([target]);
  const renderer = new LiveRenderer("bottom");

  await capture(async () => {
    renderer.start(state);
    renderer.log({ level: "log", message: "checked warehouse A" }, target);
    renderer.stop();
  });

  assert.deepEqual(state.logTail, [{ level: "log", message: "checked warehouse A" }]);
  assert.deepEqual(target.logs, []);
});

test("'step' and 'bottom' both keep only the most recent entries", async () => {
  const target = stepState("busy step");
  const state = runState([target]);
  const renderer = new LiveRenderer("step");

  await capture(async () => {
    renderer.start(state);
    for (let i = 1; i <= 10; i += 1) {
      renderer.log({ level: "log", message: `line ${i}` }, target);
    }
    renderer.stop();
  });

  assert.equal(target.logs.length, 8);
  assert.equal(target.logs[0]?.message, "line 3"); // the oldest 2 were dropped
  assert.equal(target.logs.at(-1)?.message, "line 10");
});

/* -------------------------------------------------------------------------- */
/* End to end through Script.run()                                            */
/* -------------------------------------------------------------------------- */

test("logPlacement: 'step' nests a handler's log() near its own step, live", async () => {
  const out = await capture(() =>
    new Script({ name: "t", plain: false, logPlacement: "step", handleSignals: false })
      .addStep({
        name: "check stock",
        handler: async ({ log }) => {
          log("warehouse A: 12 in stock");
        },
      })
      .run(),
  );

  assert.match(out, /check stock[\s\S]*warehouse A: 12 in stock/);
});

test("logPlacement: 'step' nests a rollback's log() under the step it undoes, live", async () => {
  const out = await capture(() =>
    new Script({ name: "t", plain: false, logPlacement: "step", handleSignals: false })
      .addStep({
        name: "reserve inventory",
        handler: () => ({ reservationId: "res_1" }),
        rollback: ({ log }) => {
          log("released reservation res_1");
        },
      })
      .addStep({
        name: "boom",
        handler: () => {
          throw new Error("boom");
        },
      })
      .run(),
  );

  assert.match(out, /reserve inventory[\s\S]*released reservation res_1/);
});

test("logPlacement: default ('scrollback') still prints a permanent line, live", async () => {
  const out = await capture(() =>
    new Script({ name: "t", plain: false, handleSignals: false })
      .addStep({
        name: "check stock",
        handler: async ({ log }) => {
          log("warehouse A: 12 in stock");
        },
      })
      .run(),
  );

  assert.match(out, /warehouse A: 12 in stock/);
});

test("logPlacement does not change what run() resolves to", async () => {
  for (const logPlacement of ["scrollback", "step", "bottom"] as const) {
    const result = await new Script({ name: "t", logPlacement, silent: true, handleSignals: false })
      .addStep({
        name: "one",
        handler: async ({ log }) => {
          log("noise");
          return { done: true };
        },
      })
      .run();

    assert.deepEqual(result.ok && result.ctx, { done: true });
  }
});
