import { padEnd, stringWidth, truncate, wrapText } from "./ansi.js";
import { frameWidth, palette, spinnerFrame, symbols } from "./theme.js";
import {
  elapsed,
  errorMessage,
  formatAge,
  formatDuration,
  phaseElapsed,
  phaseStatus,
  type LogEntry,
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
    case "cached":
      return palette.info(symbols.cached);
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
    case "cached":
      return palette.info(symbols.cached);
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

/** `cached` on its own, or `cached • 6m ago` once an age is known. */
function cachedBadge(ageMs: number | undefined): string {
  return ageMs === undefined ? "cached" : `cached ${symbols.info} ${formatAge(ageMs)}`;
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

function stepLines(step: StepState, tick: number, now: number, compact = false): string[] {
  const lines: string[] = [];
  const active =
    step.status === "running" || step.status === "rolling-back" || step.status === "failed";

  let label = step.status === "pending" ? palette.faint(step.name) : step.name;
  if (step.status === "skipped") label = palette.faint(step.name);
  // Part of the title, so it stays put once the step is done — unlike
  // statusText, which is cleared the moment the step settles.
  if (step.note) {
    label += " " + palette.muted(`(${step.note})`);
  }
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
        : step.status === "cached"
          ? palette.info(cachedBadge(step.cacheAgeMs))
          : duration !== undefined
            ? palette.faint(formatDuration(duration))
            : "";

  lines.push(row(`${STEP_INDENT}${stepIcon(step, tick)} ${label}`, right));

  // Kept on failure — how far the bar got is diagnostic. Dropped on success
  // even when the handler forgot to call done(), so green rows stay clean.
  if (step.progress && active) {
    lines.push(row(DETAIL_INDENT + renderBar(step.progress)));
  }

  // Compact mode trades detail for height when the frame must fit a viewport.
  if (compact) return lines;

  if (step.tasks.length > 0 && active) {
    for (const task of step.tasks) {
      const text = task.status === "pending" ? palette.faint(task.label) : palette.muted(task.label);
      lines.push(row(`${DETAIL_INDENT}${taskIcon(task, tick)} ${text}`));
    }
  }

  // logPlacement: "step" routes entries here instead of the scrollback; shown
  // regardless of `active` so they stay readable once the step has settled.
  for (const entry of step.logs) {
    lines.push(renderLogEntry(entry));
  }

  if (step.error !== undefined && step.status === "failed") {
    const width = frameWidth() - stringWidth(DETAIL_INDENT);
    // Capped here only because the live frame has a height budget; the closing
    // frame and the summary both print the message in full.
    for (const line of wrapText(errorMessage(step.error), width).slice(0, 4)) {
      lines.push(row(DETAIL_INDENT + palette.error(line)));
    }
  }

  return lines;
}

function collapsedPhaseLine(phase: PhaseState, tick: number, now: number): string {
  const done = phase.steps.filter(
    (s) => s.status === "success" || s.status === "cached",
  ).length;
  const summary = palette.faint(`${done}/${phase.steps.length} steps`);
  const duration = phaseElapsed(phase, now);
  const right =
    phaseStatus(phase) === "cached"
      ? palette.info(cachedBadge(phase.cacheAgeMs))
      : duration !== undefined
        ? palette.faint(formatDuration(duration))
        : "";
  return row(
    `${PHASE_INDENT}${phaseIcon(phase, tick)} ${palette.muted(phase.name)}  ${summary}`,
    right,
  );
}

function elision(count: number): string {
  return row(`${STEP_INDENT}${palette.faint(`… ${count} more`)}`);
}

const isActiveStep = (step: StepState): boolean =>
  step.status === "running" || step.status === "rolling-back" || step.status === "failed";

/**
 * Pick a window of steps around the active one. Used only when a phase cannot
 * fit whole — the running step must always stay visible.
 */
function stepWindow(steps: StepState[], budget: number): { start: number; end: number } {
  if (steps.length <= budget) return { start: 0, end: steps.length };
  const active = steps.findIndex(isActiveStep);
  const anchor = active === -1 ? steps.length - 1 : active;
  let start = Math.max(0, anchor - Math.floor(budget / 2));
  start = Math.min(start, steps.length - budget);
  return { start, end: start + budget };
}

type PhaseMode = "full" | "collapsed" | "compact";

function phaseLines(
  phase: PhaseState,
  tick: number,
  now: number,
  mode: PhaseMode,
  stepBudget = Number.POSITIVE_INFINITY,
): string[] {
  if (mode === "collapsed") return [collapsedPhaseLine(phase, tick, now)];

  const status = phaseStatus(phase);
  const name = status === "pending" ? palette.faint(phase.name) : palette.bold(phase.name);
  const duration = phaseElapsed(phase, now);
  const right =
    status === "cached"
      ? palette.info(cachedBadge(phase.cacheAgeMs))
      : status === "pending" || duration === undefined
        ? ""
        : palette.faint(formatDuration(duration));

  const lines = [row(`${PHASE_INDENT}${phaseIcon(phase, tick)} ${name}`, right)];
  if (mode === "full" && phase.description && status !== "pending") {
    lines.push(row(`${STEP_INDENT}${palette.faint(phase.description)}`));
  }

  const compact = mode === "compact";
  const { start, end } = stepWindow(phase.steps, Math.max(1, stepBudget));
  if (start > 0) lines.push(elision(start));
  for (const step of phase.steps.slice(start, end)) {
    lines.push(...stepLines(step, tick, now, compact));
  }
  if (end < phase.steps.length) lines.push(elision(phase.steps.length - end));

  return lines;
}

/** logPlacement: "bottom" — the most recent lines, below the whole phase tree. */
function renderLogTail(entries: LogEntry[]): string[] {
  if (entries.length === 0) return [];
  return ["", ...entries.map((entry) => renderLogEntry(entry))];
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
 * Lines the live region may occupy without the terminal scrolling under it.
 *
 * The hard limit is the viewport height; the margin covers the one extra line
 * a permanent log write costs when the region is already at full height.
 */
export function bodyBudget(): number {
  return Math.max(6, (process.stdout.rows ?? 40) - 3);
}

/**
 * The live body, guaranteed to fit `bodyBudget()`.
 *
 * This guarantee is load-bearing, not cosmetic: the renderer repaints by moving
 * the cursor up N lines, so a frame taller than the viewport scrolls its own
 * top off screen and every repaint appends a copy instead of overwriting. Four
 * progressively stronger reductions are tried, and the result is clamped.
 */
export function renderBody(state: RunState, tick: number, now: number, fit = true): string[] {
  const budget = bodyBudget();
  const tail = renderLogTail(state.logTail);

  const build = (mode: (phase: PhaseState) => PhaseMode, stepBudget?: number): string[] => {
    const out: string[] = [];
    state.phases.forEach((phase, index) => {
      out.push(...phaseLines(phase, tick, now, mode(phase), stepBudget));
      if (index < state.phases.length - 1) out.push("");
    });
    return out;
  };

  // The closing frame is written permanently and never repainted, so it may
  // scroll freely — keep every step visible there.
  if (!fit) return [...build(() => "full"), ...tail];

  const done = (phase: PhaseState): boolean => {
    const status = phaseStatus(phase);
    return status === "success" || status === "skipped";
  };
  const active = (phase: PhaseState): boolean => phaseStatus(phase) === "running";

  // 1. Everything, in full.
  let out = build(() => "full");
  if (out.length + tail.length <= budget) return [...out, ...tail];

  // 2. Finished phases become one line each.
  out = build((phase) => (done(phase) ? "collapsed" : "full"));
  if (out.length + tail.length <= budget) return [...out, ...tail];

  // 3. Only the running phase keeps its steps, and drops its detail lines.
  out = build((phase) => (active(phase) ? "compact" : "collapsed"));
  if (out.length + tail.length <= budget) return [...out, ...tail];

  // 4. Window the running phase's steps around the one actually executing.
  const overhead = state.phases.filter((phase) => !active(phase)).length * 2;
  out = build(
    (phase) => (active(phase) ? "compact" : "collapsed"),
    Math.max(1, budget - overhead - 2 - tail.length),
  );
  const combined = [...out, ...tail];

  // Last resort: a phase with a huge task list, or a viewport of a few rows.
  return combined.length <= budget ? combined : combined.slice(0, budget);
}

export function renderSummary(state: RunState, now: number): string[] {
  const width = frameWidth();
  const lines = ["", row(GUTTER + palette.faint(symbols.rule.repeat(width - GUTTER.length)))];

  const allSteps = state.phases.flatMap((p) => p.steps);
  const succeeded = allSteps.filter((s) => s.status === "success").length;
  const skipped = allSteps.filter((s) => s.status === "skipped").length;
  const cached = allSteps.filter((s) => s.status === "cached").length;
  const total = (state.endedAt ?? now) - state.startedAt;

  if (state.status === "success") {
    lines.push(
      row(
        `${GUTTER}${palette.success(symbols.success)} ${palette.bold(state.name)} ${palette.muted("completed in")} ${palette.bold(formatDuration(total))}`,
      ),
    );
    const parts = [`${succeeded} steps`, `${state.phases.length} phases`];
    if (cached > 0) parts.push(`${cached} cached`);
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
      const width = frameWidth() - GUTTER.length - 2;
      for (const line of wrapText(errorMessage(state.failure.error), width)) {
        lines.push(row(`${GUTTER}  ${palette.error(line)}`));
      }
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
