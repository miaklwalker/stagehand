import assert from "node:assert/strict";
import test from "node:test";

import { Script, setColorEnabled } from "../dist/index.js";
import { renderBody } from "../dist/ui/frame.js";
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

function stepState(extra: Partial<StepState> = {}): StepState {
  return {
    name: "query database",
    phaseIndex: 0,
    status: "success",
    attempts: 1,
    tasks: [],
    hasRollback: false,
    startedAt: 0,
    endedAt: 10,
    ...extra,
  };
}

function runState(step: StepState): RunState {
  const phase: PhaseState = { name: "Load", steps: [step] };
  return {
    name: "t",
    phases: [phase],
    status: "running",
    startedAt: 0,
    rollbackCount: 0,
    rollbackFailures: 0,
  };
}

/** The live frame emits colour by default; plain text is easier to assert on. */
function uncoloured<T>(fn: () => T): T {
  setColorEnabled(false);
  try {
    return fn();
  } finally {
    setColorEnabled(true);
  }
}

const stepLine = (state: RunState): string =>
  uncoloured(() => renderBody(state, 0, 20)).find((line) => line.includes("query database")) ?? "";

test("a note set in a handler is still on the step line after it finishes", async () => {
  const out = await capture(() =>
    new Script({ name: "t", plain: true, handleSignals: false })
      .addStep({
        name: "query database",
        handler: ({ note, status }) => {
          status("scanning");
          note("400 rows found");
        },
      })
      .run(),
  );

  assert.match(out, /query database \(400 rows found\)/);
  // the transient status never reaches the finished line
  assert.doesNotMatch(out, /scanning/);
});

test("note('') clears an annotation that was already set", async () => {
  const out = await capture(() =>
    new Script({ name: "t", plain: true, handleSignals: false })
      .addStep({
        name: "query database",
        handler: ({ note }) => {
          note("first");
          note("400 rows found");
          note("");
        },
      })
      .run(),
  );

  assert.doesNotMatch(out, /first/);
  assert.doesNotMatch(out, /400 rows found/);
  assert.doesNotMatch(out, /query database \(/);
});

test("the note renders inside the title, between the name and the status text", () => {
  const line = stepLine(
    runState(stepState({ status: "running", note: "400 rows found", statusText: "page 3" })),
  );

  assert.match(line, /query database \(400 rows found\)/);
  assert.ok(line.indexOf("400 rows found") < line.indexOf("page 3"));
});

test("a note survives every terminal status, including rolled back", () => {
  for (const status of ["success", "failed", "rolled-back"] as const) {
    const line = stepLine(runState(stepState({ status, note: "400 rows found" })));
    assert.match(line, /query database \(400 rows found\)/, `status: ${status}`);
  }
});

test("no note means no parentheses", () => {
  const line = stepLine(runState(stepState()));

  assert.match(line, /query database/);
  assert.doesNotMatch(line, /[()]/);
});

test("a rollback can annotate its own step", async () => {
  const out = await capture(() =>
    new Script({ name: "t", plain: false, handleSignals: false })
      .addStep({
        name: "query database",
        handler: () => ({ token: "tok_1" }),
        rollback: ({ note }) => {
          note("token revoked");
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

  assert.match(out, /query database.*\(token revoked\)/);
});
