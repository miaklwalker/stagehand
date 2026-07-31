import type { StandardSchemaV1 } from "@standard-schema/spec";

/** The value passed to `run()` failed validation against `defineInput`'s schema. */
export class SchemaValidationError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(
      issues
        .map((issue) => {
          const path = issue.path
            ?.map((segment) =>
              String(typeof segment === "object" && segment !== null ? segment.key : segment),
            )
            .join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join("; "),
    );
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

/**
 * A step was declared in a way the script cannot honour — today, a `clean`
 * naming a key some step reserved through `rollbackKeys`. Thrown by `addStep`,
 * while the script is being built, long before anything runs.
 */
export class StepDefinitionError extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(message);
    this.name = "StepDefinitionError";
    this.step = step;
  }
}

/** A step's handler threw. `cause` holds whatever it actually threw. */
export class StepFailedError extends Error {
  readonly phase: string;
  readonly step: string;
  readonly attempts: number;

  constructor(phase: string, step: string, attempts: number, cause: unknown) {
    super(`Step "${step}" in phase "${phase}" failed`, { cause });
    this.name = "StepFailedError";
    this.phase = phase;
    this.step = step;
    this.attempts = attempts;
  }
}

export class StepTimeoutError extends Error {
  readonly step: string;
  readonly timeoutMs: number;

  constructor(step: string, timeoutMs: number) {
    super(`Step "${step}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
    this.step = step;
    this.timeoutMs = timeoutMs;
  }
}

/** The run was cancelled — Ctrl-C, SIGTERM, or a caller-supplied signal. */
export class ScriptAbortedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Script aborted (${reason})`);
    this.name = "ScriptAbortedError";
    this.reason = reason;
  }
}

/** A compensation handler itself threw; the original failure is in `cause`. */
export class RollbackFailedError extends Error {
  readonly phase: string;
  readonly step: string;
  readonly rollbackError: unknown;

  constructor(phase: string, step: string, rollbackError: unknown, cause: unknown) {
    super(`Rollback for "${step}" in phase "${phase}" failed`, { cause });
    this.name = "RollbackFailedError";
    this.phase = phase;
    this.step = step;
    this.rollbackError = rollbackError;
  }
}

export function isAbort(error: unknown): boolean {
  return (
    error instanceof ScriptAbortedError ||
    (error instanceof Error && error.name === "AbortError")
  );
}
