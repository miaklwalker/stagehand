export { Script, script, stepFor, type RunOptions } from "./script.js";

export {
  RollbackFailedError,
  ScriptAbortedError,
  StepFailedError,
  StepTimeoutError,
  isAbort,
} from "./errors.js";

export type {
  Awaitable,
  Merge,
  PhaseOptions,
  PhaseStatus,
  Prettify,
  ProgressHandle,
  RetryPolicy,
  RollbackContext,
  RollbackReport,
  RunResult,
  RunStatus,
  ScriptOptions,
  StepContext,
  StepDef,
  StepReport,
  StepStatus,
  TaskHandle,
  TaskListHandle,
} from "./types.js";

export { formatDuration } from "./state.js";
export { setColorEnabled, isColorEnabled } from "./ui/ansi.js";
export { palette, symbols } from "./ui/theme.js";
