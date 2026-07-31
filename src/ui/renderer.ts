import { cursor } from "./ansi.js";
import { palette, supportsAnimation, symbols } from "./theme.js";
import { renderBody, renderHeader, renderLogEntry, renderSummary } from "./frame.js";
import {
  elapsed,
  errorMessage,
  formatDuration,
  type LogEntry,
  type PhaseState,
  type RunState,
  type StepState,
} from "../state.js";
import type { LogPlacement } from "../types.js";

export interface Renderer {
  start(state: RunState): void;
  /** State mutated; repaint when the renderer is live. */
  refresh(): void;
  /** `step` is a routing hint — where the entry came from, for placements that nest it there. */
  log(entry: LogEntry, step?: StepState): void;
  onPhaseStart(phase: PhaseState): void;
  onStepStart(step: StepState): void;
  onStepEnd(step: StepState): void;
  stop(): void;
}

const FRAME_INTERVAL_MS = 80;
const MIN_REPAINT_MS = 32;
/** Both "step" and "bottom" placement are an honestly-rolling tail, not a
 * complete record — reach for "scrollback" when completeness matters. */
const LOG_TAIL_LIMIT = 8;

function pushCapped(entries: LogEntry[], entry: LogEntry, limit: number): void {
  entries.push(entry);
  if (entries.length > limit) entries.shift();
}

/** Repaints an in-place region below permanently-written output. */
export class LiveRenderer implements Renderer {
  private state: RunState | null = null;
  private stream = process.stdout;
  private liveLines = 0;
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastPaintAt = 0;
  private readonly logPlacement: LogPlacement;

  constructor(logPlacement: LogPlacement = "scrollback") {
    this.logPlacement = logPlacement;
  }

  start(state: RunState): void {
    this.state = state;
    this.stopped = false;
    this.write(renderHeader(state).join("\n") + "\n");
    this.stream.write(cursor.hide);
    this.stream.on("resize", this.onResize);
    this.timer = setInterval(() => {
      this.tick += 1;
      this.paint();
    }, FRAME_INTERVAL_MS);
    this.timer.unref?.();
    this.paint();
  }

  /**
   * A resize reflows whatever is already on screen, so the line count we
   * recorded no longer describes it. Abandon the old region and redraw below
   * it — a stale frame left in scrollback beats a corrupted cursor.
   */
  private readonly onResize = (): void => {
    this.liveLines = 0;
    this.paint();
  };

  /**
   * Handlers may call this thousands of times (a progress bar in a tight
   * loop), so coalesce; the frame timer guarantees the last state lands.
   */
  refresh(): void {
    const now = performance.now();
    if (now - this.lastPaintAt < MIN_REPAINT_MS) return;
    this.paint();
  }

  log(entry: LogEntry, step?: StepState): void {
    if (this.stopped) return;

    if (this.logPlacement === "step" && step) {
      pushCapped(step.logs, entry, LOG_TAIL_LIMIT);
      this.paint();
      return;
    }
    if (this.logPlacement === "bottom" && this.state) {
      pushCapped(this.state.logTail, entry, LOG_TAIL_LIMIT);
      this.paint();
      return;
    }

    this.clear();
    this.write(renderLogEntry(entry) + "\n");
    this.paint();
  }

  onPhaseStart(): void {
    /* covered by repaint */
  }

  onStepStart(): void {
    /* covered by repaint */
  }

  onStepEnd(): void {
    /* covered by repaint */
  }

  stop(): void {
    if (this.stopped || !this.state) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream.off("resize", this.onResize);

    const now = performance.now();
    this.clear();
    const final = [
      ...renderBody(this.state, this.tick, now, false),
      ...renderSummary(this.state, now),
    ];
    this.write(final.join("\n") + "\n");
    this.liveLines = 0;
    this.stream.write(cursor.show);
  }

  private paint(): void {
    if (this.stopped || !this.state) return;
    const now = performance.now();

    // renderBody already fits itself to the viewport; this clamp is the
    // backstop that keeps the up-N-lines invariant true no matter what, since
    // a frame taller than the terminal scrolls its own anchor off screen.
    const maxLines = Math.max(1, (process.stdout.rows ?? 40) - 1);
    const body = renderBody(this.state, this.tick, now).slice(0, maxLines);

    this.clear();
    this.write(body.join("\n") + "\n");
    this.liveLines = body.length;
    this.lastPaintAt = now;
  }

  private clear(): void {
    if (this.liveLines === 0) return;
    this.stream.write(cursor.up(this.liveLines) + cursor.toStart + cursor.eraseDown);
    this.liveLines = 0;
  }

  private write(text: string): void {
    this.stream.write(text);
  }
}

/** Line-per-event output for CI, pipes, and dumb terminals. */
export class PlainRenderer implements Renderer {
  private stream = process.stdout;

  start(state: RunState): void {
    this.stream.write(`\n${symbols.brand} ${state.name}\n`);
    if (state.description) this.stream.write(`${symbols.brand} ${state.description}\n`);
    this.stream.write("\n");
  }

  refresh(): void {
    /* no live region */
  }

  log(entry: LogEntry): void {
    this.stream.write(`    ${renderLogEntry(entry).trimStart()}\n`);
  }

  onPhaseStart(phase: PhaseState): void {
    this.stream.write(`${symbols.arrow} ${phase.name}\n`);
  }

  onStepStart(step: StepState): void {
    this.stream.write(`  ${symbols.pending} ${step.name}\n`);
  }

  onStepEnd(step: StepState): void {
    const duration = elapsed(step, performance.now());
    const time = duration === undefined ? "" : `  ${formatDuration(duration)}`;
    const icon =
      step.status === "success"
        ? symbols.success
        : step.status === "skipped"
          ? symbols.skipped
          : step.status === "rolled-back"
            ? symbols.rolledBack
            : step.status === "failed" || step.status === "rollback-failed"
              ? symbols.failure
              : symbols.info;
    const suffix = step.error === undefined ? "" : `  ${errorMessage(step.error)}`;
    const note = step.note ? ` (${step.note})` : "";
    this.stream.write(`  ${icon} ${step.name}${note}${time}${suffix}\n`);
  }

  stop(): void {
    /* summary printed by the caller via printSummary */
  }
}

/** Plain renderer that still prints the closing summary block. */
export class PlainSummaryRenderer extends PlainRenderer {
  private captured: RunState | null = null;

  override start(state: RunState): void {
    this.captured = state;
    super.start(state);
  }

  override stop(): void {
    if (!this.captured) return;
    process.stdout.write(renderSummary(this.captured, performance.now()).join("\n") + "\n");
  }
}

export class SilentRenderer implements Renderer {
  start(): void {}
  refresh(): void {}
  log(): void {}
  onPhaseStart(): void {}
  onStepStart(): void {}
  onStepEnd(): void {}
  stop(): void {}
}

export function createRenderer(options: {
  plain?: boolean;
  silent?: boolean;
  logPlacement?: LogPlacement;
}): Renderer {
  if (options.silent) return new SilentRenderer();
  if (options.plain === true) return new PlainSummaryRenderer();
  if (options.plain === false) return new LiveRenderer(options.logPlacement);
  return supportsAnimation() ? new LiveRenderer(options.logPlacement) : new PlainSummaryRenderer();
}

export const uiPalette = palette;
