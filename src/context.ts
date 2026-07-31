import type { ProgressState, StepState, TaskState } from "./state.js";
import type { Renderer } from "./ui/renderer.js";
import type { LogLevel } from "./ui/frame.js";
import type {
  ProgressHandle,
  RollbackContext,
  StepContext,
  TaskHandle,
  TaskListHandle,
} from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createProgress(
  step: StepState,
  renderer: Renderer,
  options: { total: number; label?: string; value?: number },
): ProgressHandle {
  const bar: ProgressState = {
    total: Math.max(0, options.total),
    value: clamp(options.value ?? 0, 0, Math.max(0, options.total)),
    complete: false,
  };
  if (options.label !== undefined) bar.label = options.label;
  step.progress = bar;
  renderer.refresh();

  return {
    get value() {
      return bar.value;
    },
    get total() {
      return bar.total;
    },
    update(value, label) {
      bar.value = clamp(value, 0, bar.total);
      if (label !== undefined) bar.label = label;
      renderer.refresh();
    },
    increment(by = 1) {
      bar.value = clamp(bar.value + by, 0, bar.total);
      renderer.refresh();
    },
    setTotal(total) {
      bar.total = Math.max(0, total);
      bar.value = clamp(bar.value, 0, bar.total);
      renderer.refresh();
    },
    setLabel(label) {
      bar.label = label;
      renderer.refresh();
    },
    done() {
      bar.value = bar.total;
      bar.complete = true;
      renderer.refresh();
    },
  };
}

function handleFor(task: TaskState, renderer: Renderer): TaskHandle {
  const set = (status: TaskState["status"], text?: string): void => {
    if (text !== undefined) task.label = text;
    task.status = status;
    renderer.refresh();
  };
  return {
    start: (text) => set("running", text),
    label: (text) => set(task.status, text),
    succeed: (text) => set("done", text),
    fail: (text) => set("failed", text),
    skip: (text) => set("skipped", text),
  };
}

function createTask(step: StepState, renderer: Renderer, label: string): TaskHandle {
  const task: TaskState = { label, status: "running" };
  step.tasks.push(task);
  renderer.refresh();
  return handleFor(task, renderer);
}

function createTaskList<const K extends readonly string[]>(
  step: StepState,
  renderer: Renderer,
  labels: K,
): TaskListHandle<K[number]> {
  const map = {} as Record<K[number], TaskHandle>;
  for (const label of labels) {
    const task: TaskState = { label, status: "pending" };
    step.tasks.push(task);
    map[label as K[number]] = handleFor(task, renderer);
  }
  renderer.refresh();
  return {
    tasks: map,
    get: (key) => map[key],
  };
}

export interface ContextDeps {
  renderer: Renderer;
  step: StepState;
  phaseName: string;
}

/** Set (or, given "", clear) the step's persistent title annotation. */
function annotate(step: StepState, renderer: Renderer, message: string): void {
  if (message === "") delete step.note;
  else step.note = message;
  renderer.refresh();
}

export function createStepContext<In, Ctx>(
  deps: ContextDeps,
  input: In,
  ctx: Ctx,
  signal: AbortSignal,
  attempt: number,
): StepContext<In, Ctx> {
  const { renderer, step, phaseName } = deps;
  const emit = (level: LogLevel) => (message: string) => renderer.log({ level, message });

  return {
    input,
    ctx,
    signal,
    attempt,
    phase: phaseName,
    step: step.name,
    log: emit("log"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    success: emit("success"),
    status(message) {
      step.statusText = message;
      renderer.refresh();
    },
    note: (message) => annotate(step, renderer, message),
    progress: (options) => createProgress(step, renderer, options),
    task: (label) => createTask(step, renderer, label),
    tasks: (labels) => createTaskList(step, renderer, labels),
  };
}

export function createRollbackContext<In, Ctx, Out>(
  deps: ContextDeps,
  input: In,
  ctx: Ctx,
  output: Out,
  error: unknown,
  signal: AbortSignal,
): RollbackContext<In, Ctx, Out> {
  const { renderer, step, phaseName } = deps;
  return {
    input,
    ctx,
    output,
    error,
    signal,
    phase: phaseName,
    step: step.name,
    log: (message) => renderer.log({ level: "warn", message }),
    status(message) {
      step.statusText = message;
      renderer.refresh();
    },
    note: (message) => annotate(step, renderer, message),
    progress: (options) => createProgress(step, renderer, options),
  };
}
