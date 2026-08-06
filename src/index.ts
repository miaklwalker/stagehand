export {
  Script,
  script,
  stepFor,
  routineFor,
  type CachedPhaseOptions,
  type ClosedPhase,
  type Commit,
  type MountInput,
  type MountOptions,
  type Mounted,
  type OpenPhase,
  type Routine,
  type RunOptions,
} from "./script.js";

export { fileStore, memoryStore } from "./cache.js";

export {
  CacheShapeError,
  DuplicateNameError,
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
  CacheHandle,
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
  SlotValue,
  StaleContext,
  StepContext,
  StepDef,
  StepReport,
  StepStatus,
  TaskHandle,
  TaskListHandle,
  UnknownSlots,
  WithStepFor,
} from "./types.js";

export { formatDuration } from "./state.js";
export { setColorEnabled, isColorEnabled } from "./ui/ansi.js";
export { palette, symbols } from "./ui/theme.js";
