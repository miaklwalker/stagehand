import { padEnd, stringWidth, truncate } from "./ansi.js";
import { frameWidth, palette, spinnerFrame, symbols } from "./theme.js";
import {
  elapsed,
  errorMessage,
  formatDuration,
  phaseElapsed,
  phaseStatus,
  type PhaseState,
  type ProgressState,
  type RunState,
  type StepState,
  type TaskState,
} from "../state.js";

const GUTTER = "  ";
const PHASE_INDENT = GUTTER;
const STEP_INDENT = GUTTER + "   ";
const DETAIL_INDENT = GUTTER + "     ";

export type LogLevel = "log" | "info" | "warn" | "error" | "success";

export interface LogEntry {
  level: LogLevel;
  message: string;
}

/** left text, right text, padded to the frame width and clipped safely. */
function row(left: string, right = ""): string {
  const width = frameWidth();
  if (right === "") return truncate(left, width);
  const gap = width - stringWidth(left) - stringWidth(right);
  if (gap < 1) return truncate(left, Math.max(1, width - stringWidth(right) - 1)) + " " + right;
  return left + " ".repeat(gap) + right;
}

function stepIcon(step: StepState, tick: number): string {
  switch (step.status) {
    case "pending":
      return palette.faint(symbols.pending);
    case "running":
      return palette.accent(spinnerFrame(tick));
    case "success":
      return palette.success(symbols.success);
    case "failed":
      return palette.error(symbols.failure);
    case "skipped":
      return palette.faint(symbols.skipped);
    case "rolling-back":
      return palette.warning(spinnerFrame(tick));
    case "rolled-back":
      return palette.warning(symbols.rolledBack);
    case "rollback-failed":
      return palette.error(symbols.rolledBack);
  }
}

function phaseIcon(phase: PhaseState, tick: number): string {
  switch (phaseStatus(phase)) {
    case "pending":
      return palette.faint(symbols.pending);
    case "running":
      return palette.accent(spinnerFrame(tick));
    case "success":
      return palette.success(symbols.success);
    case "failed":
      return palette.error(symbols.failure);
    case "skipped":
      return palette.faint(symbols.skipped);
  }
}

function taskIcon(task: TaskState, tick: number): string {
  switch (task.status) {
    case "pending":
      return palette.faint(symbols.pending);
    case "running":
      return palette.accent(spinnerFrame(tick));
    case "done":
      return palette.success(symbols.success);
    case "failed":
      return palette.error(symbols.failure);
    case "skipped":
      return palette.faint(symbols.skipped);
  }
}

export function renderBar(progress: ProgressState, width = 24): string {
  const total = Math.max(progress.total, 1);
  const ratio = Math.max(0, Math.min(1, progress.value / total));
  const filled = Math.round(ratio * width);
  const bar =
    palette.accent(symbols.barFull.repeat(filled)) +
    palette.faint(symbols.barEmpty.repeat(width - filled));
  const percent = padEnd(`${Math.round(ratio * 100)}%`, 4);
  const count = palette.faint(`${progress.value}/${progress.total}`);
  const label = progress.label ? "  " + palette.faint(progress.label) : "";
  return (
    palette.faint(symbols.barLeft) +
    bar +
    palette.faint(symbols.barRight) +
    "  " +
    palette.muted(percent) +
    " " +
    count +
    label
  );
}

function stepLines(step: StepState, tick: number, now: number): string[] {
  const lines: string[] = [];
  const active =
    step.status === "running" || step.status === "rolling-back" || step.status === "failed";

  let label = step.status === "pending" ? palette.faint(step.name) : step.name;
  if (step.status === "skipped") label = palette.faint(step.name);
  if (step.attempts > 1 && active) {
    label += palette.warning(` (retry ${step.attempts - 1})`);
  }
  if (step.statusText && active) {
    label += "  " + palette.faint(`${symbols.arrow} ${step.statusText}`);
  }

  const duration = elapsed(step, now);
  const right =
    step.status === "pending"
      ? ""
      : step.status === "skipped"
        ? palette.faint("skipped")
        : duration !== undefined
          ? palette.faint(formatDuration(duration))
          : "";

  lines.push(row(`${STEP_INDENT}${stepIcon(step, tick)} ${label}`, right));

  // Kept on failure — how far the bar got is diagnostic. Dropped on success
  // even when the handler forgot to call done(), so green rows stay clean.
  if (step.progress && active) {
    lines.push(DETAIL_INDENT + renderBar(step.progress));
  }

  if (step.tasks.length > 0 && active) {
    for (const task of step.tasks) {
      const text = task.status === "pending" ? palette.faint(task.label) : palette.muted(task.label);
      lines.push(row(`${DETAIL_INDENT}${taskIcon(task, tick)} ${text}`));
    }
  }

  if (step.error !== undefined && step.status === "failed") {
    lines.push(row(DETAIL_INDENT + palette.error(errorMessage(step.error))));
  }

  return lines;
}

function collapsedPhaseLine(phase: PhaseState, tick: number, now: number): string {
  const done = phase.steps.filter((s) => s.status === "success").length;
  const summary = palette.faint(`${done}/${phase.steps.length} steps`);
  const duration = phaseElapsed(phase, now);
  const right = duration !== undefined ? palette.faint(formatDuration(duration)) : "";
  return row(
    `${PHASE_INDENT}${phaseIcon(phase, tick)} ${palette.muted(phase.name)}  ${summary}`,
    right,
  );
}

function phaseLines(phase: PhaseState, tick: number, now: number, collapsed: boolean): string[] {
  if (collapsed) return [collapsedPhaseLine(phase, tick, now)];

  const status = phaseStatus(phase);
  const name =
    status === "pending" ? palette.faint(phase.name) : palette.bold(phase.name);
  const duration = phaseElapsed(phase, now);
  const right =
    status === "pending" || duration === undefined ? "" : palette.faint(formatDuration(duration));

  const lines = [row(`${PHASE_INDENT}${phaseIcon(phase, tick)} ${name}`, right)];
  if (phase.description && status !== "pending") {
    lines.push(row(`${STEP_INDENT}${palette.faint(phase.description)}`));
  }
  for (const step of phase.steps) {
    lines.push(...stepLines(step, tick, now));
  }
  return lines;
}

export function renderHeader(state: RunState): string[] {
  const lines = ["", row(`${GUTTER}${palette.accent(symbols.brand)} ${palette.bold(state.name)}`)];
  if (state.description) {
    lines.push(row(`${GUTTER}${palette.accent(symbols.brand)} ${palette.faint(state.description)}`));
  }
  lines.push("");
  return lines;
}

/**
 * The live body. Fully-finished phases collapse to one line when the frame
 * would otherwise outgrow the terminal and break in-place repainting.
 */
export function renderBody(state: RunState, tick: number, now: number): string[] {
  const build = (collapseDone: boolean): string[] => {
    const out: string[] = [];
    state.phases.forEach((phase, index) => {
      const status = phaseStatus(phase);
      const collapsed = collapseDone && (status === "success" || status === "skipped");
      out.push(...phaseLines(phase, tick, now, collapsed));
      if (index < state.phases.length - 1) out.push("");
    });
    return out;
  };

  const full = build(false);
  const budget = (process.stdout.rows ?? 40) - 8;
  return full.length <= budget ? full : build(true);
}

export function renderSummary(state: RunState, now: number): string[] {
  const width = frameWidth();
  const lines = ["", row(GUTTER + palette.faint(symbols.rule.repeat(width - GUTTER.length)))];

  const allSteps = state.phases.flatMap((p) => p.steps);
  const succeeded = allSteps.filter((s) => s.status === "success").length;
  const skipped = allSteps.filter((s) => s.status === "skipped").length;
  const total = (state.endedAt ?? now) - state.startedAt;

  if (state.status === "success") {
    lines.push(
      row(
        `${GUTTER}${palette.success(symbols.success)} ${palette.bold(state.name)} ${palette.muted("completed in")} ${palette.bold(formatDuration(total))}`,
      ),
    );
    const parts = [`${succeeded} steps`, `${state.phases.length} phases`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    lines.push(row(`${GUTTER}  ${palette.faint(parts.join(` ${symbols.info} `))}`));
  } else {
    const where = state.failure
      ? `${state.failure.phase} ${symbols.arrow} ${state.failure.step}`
      : "unknown step";
    lines.push(
      row(
        `${GUTTER}${palette.error(symbols.failure)} ${palette.bold("Failed")} ${palette.muted("at")} ${palette.error(where)} ${palette.faint(`after ${formatDuration(total)}`)}`,
      ),
    );
    if (state.failure) {
      lines.push(row(`${GUTTER}  ${palette.error(errorMessage(state.failure.error))}`));
    }
    if (state.rollbackCount > 0) {
      const text = `Rolled back ${state.rollbackCount} step${state.rollbackCount === 1 ? "" : "s"}`;
      lines.push(row(`${GUTTER}${palette.warning(symbols.rolledBack)} ${palette.muted(text)}`));
    }
    if (state.rollbackFailures > 0) {
      lines.push(
        row(
          `${GUTTER}${palette.error(symbols.warning)} ${palette.error(`${state.rollbackFailures} rollback(s) failed — manual cleanup required`)}`,
        ),
      );
    }
  }

  lines.push("");
  return lines;
}

export function renderLogEntry(entry: LogEntry): string {
  const icon = {
    log: palette.faint(symbols.info),
    info: palette.info(symbols.info),
    warn: palette.warning(symbols.warning),
    error: palette.error(symbols.failure),
    success: palette.success(symbols.success),
  }[entry.level];

  const paint = {
    log: palette.muted,
    info: palette.info,
    warn: palette.warning,
    error: palette.error,
    success: palette.muted,
  }[entry.level];

  return row(`${DETAIL_INDENT}${icon} ${paint(entry.message)}`);
}
