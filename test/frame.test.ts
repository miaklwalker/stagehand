/**
 * The live renderer repaints by moving the cursor up N lines. If a frame is
 * taller than the viewport it scrolls its own anchor off screen, and every
 * repaint appends a copy instead of overwriting. These tests pin the height
 * invariant that prevents that.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { bodyBudget, renderBody } from "../dist/ui/frame.js";
import type { PhaseState, RunState, StepState } from "../dist/state.js";

function withRows<T>(rows: number, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process.stdout, "rows", original);
  }
}

function makeStep(name: string, status: StepState["status"], extra: Partial<StepState> = {}): StepState {
  return { name, phaseIndex: 0, status, attempts: 1, tasks: [], logs: [], hasRollback: false, ...extra };
}

/** Mirrors the release pipeline: 4 phases, 13 steps, descriptions and detail. */
function releaseShapedRun(): RunState {
  const phases: PhaseState[] = [
    {
      name: "Preflight",
      description: "Everything that can fail cheaply, first",
      steps: [
        makeStep("read manifest", "success", { startedAt: 0, endedAt: 10 }),
        makeStep("authenticate npm", "success", { startedAt: 10, endedAt: 420 }),
        makeStep("inspect git", "success", { startedAt: 420, endedAt: 470 }),
        makeStep("resolve version", "success", { startedAt: 470, endedAt: 471 }),
        makeStep("check registry", "success", { startedAt: 471, endedAt: 1000 }),
      ],
    },
    {
      name: "Verify",
      description: "Nothing is mutated until this passes",
      steps: [
        makeStep("typecheck", "success", { startedAt: 1000, endedAt: 1460 }),
        makeStep("run tests", "running", {
          startedAt: 1460,
          statusText: "12 passed",
          progress: { total: 18, value: 12, label: "tests", complete: false },
        }),
      ],
    },
    {
      name: "Package",
      steps: [
        makeStep("write version", "pending"),
        makeStep("clean dist", "pending"),
        makeStep("build", "pending"),
        makeStep("verify artifacts", "pending", {
          tasks: [
            { label: "entry js", status: "pending" },
            { label: "type declarations", status: "pending" },
            { label: "no source maps orphaned", status: "pending" },
            { label: "exports Script", status: "pending" },
          ],
        }),
        makeStep("audit tarball", "pending"),
      ],
    },
    {
      name: "Publish",
      steps: [
        makeStep("tag release", "pending"),
        makeStep("push tag", "pending"),
        makeStep("publish to npm", "pending"),
      ],
    },
  ];

  return {
    name: "release",
    description: "Verify, package and publish to npm",
    phases,
    status: "running",
    startedAt: 0,
    rollbackCount: 0,
    rollbackFailures: 0,
    logTail: [],
  };
}

test("a release-shaped frame fits an 80x24 terminal", () => {
  withRows(24, () => {
    const body = renderBody(releaseShapedRun(), 0, 2_000);
    assert.ok(
      body.length <= bodyBudget(),
      `frame was ${body.length} lines, budget is ${bodyBudget()}`,
    );
  });
});

test("the frame fits at every plausible terminal height", () => {
  for (const rows of [10, 14, 20, 24, 30, 40, 60, 120]) {
    withRows(rows, () => {
      const body = renderBody(releaseShapedRun(), 0, 2_000);
      assert.ok(
        body.length <= bodyBudget(),
        `at rows=${rows} frame was ${body.length} lines, budget is ${bodyBudget()}`,
      );
    });
  }
});

test("a pathological run with 200 steps in one phase still fits", () => {
  const state = releaseShapedRun();
  state.phases = [
    {
      name: "Migrate",
      steps: Array.from({ length: 200 }, (_, index) =>
        makeStep(`record ${index}`, index === 120 ? "running" : index < 120 ? "success" : "pending"),
      ),
    },
  ];

  withRows(24, () => {
    const body = renderBody(state, 0, 5_000);
    assert.ok(body.length <= bodyBudget(), `frame was ${body.length} lines`);
    // The executing step must survive every reduction.
    assert.ok(
      body.some((line) => line.includes("record 120")),
      "the running step was windowed out of the frame",
    );
  });
});

test("no rendered line exceeds the terminal width", () => {
  const stripAnsi = (input: string): string => input.replace(/\[[0-9;]*m/g, "");
  withRows(24, () => {
    const body = renderBody(releaseShapedRun(), 0, 2_000);
    const columns = process.stdout.columns ?? 80;
    for (const line of body) {
      assert.ok(
        stripAnsi(line).length <= columns,
        `line of ${stripAnsi(line).length} chars would wrap at ${columns} columns: ${stripAnsi(line)}`,
      );
    }
  });
});

test("the closing frame keeps full detail and ignores the budget", () => {
  const state = releaseShapedRun();
  for (const phase of state.phases) {
    for (const step of phase.steps) step.status = "success";
  }

  withRows(10, () => {
    const closing = renderBody(state, 0, 5_000, false);
    assert.ok(closing.length > bodyBudget(), "closing frame should not be squeezed");
    for (const phase of state.phases) {
      for (const step of phase.steps) {
        assert.ok(
          closing.some((line) => line.includes(step.name)),
          `${step.name} missing from the closing frame`,
        );
      }
    }
  });
});
