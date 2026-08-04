export { Script, script, stepFor, type RunOptions } from "./script.js";

export { fileStore, memoryStore } from "./cache.js";

export {
  RollbackFailedError,
  SchemaValidationError,
  ScriptAbortedError,
  StepDefinitionError,
  StepFailedError,
  StepTimeoutError,
  isAbort,
} from "./errors.js";

export type {
  Awaitable,
  CacheMode,
  CacheOptions,
  CacheSource,
  CacheStore,
  CachedEntry,
  CleanField,
  Cleaned,
  LogPlacement,
  Merge,
  PhaseOptions,
  PhaseStatus,
  Prettify,
  ProgressHandle,
  RetryPolicy,
  RollbackContext,
  RollbackData,
  RollbackReport,
  RunResult,
  RunStatus,
  ScriptOptions,
  StaleContext,
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
