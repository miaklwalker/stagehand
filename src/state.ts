import type { PhaseStatus, RunStatus, StepStatus } from "./types.js";

export interface ProgressState {
  total: number;
  value: number;
  label?: string;
  complete: boolean;
}

export interface TaskState {
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
}

export interface StepState {
  name: string;
  description?: string;
  phaseIndex: number;
  status: StepStatus;
  statusText?: string;
  startedAt?: number;
  endedAt?: number;
  attempts: number;
  error?: unknown;
  progress?: ProgressState;
  tasks: TaskState[];
  hasRollback: boolean;
}

export interface PhaseState {
  name: string;
  description?: string;
  steps: StepState[];
}

export interface RunState {
  name: string;
  description?: string;
  phases: PhaseState[];
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  failure?: { phase: string; step: string; error: unknown };
  rollbackCount: number;
  rollbackFailures: number;
}

export function phaseStatus(phase: PhaseState): PhaseStatus {
  const steps = phase.steps;
  if (steps.length === 0) return "success";
  if (steps.some((s) => s.status === "failed" || s.status === "rollback-failed")) return "failed";
  if (
    steps.some(
      (s) => s.status === "running" || s.status === "rolling-back" || s.status === "rolled-back",
    )
  ) {
    return "running";
  }
  if (steps.every((s) => s.status === "skipped")) return "skipped";
  if (steps.every((s) => s.status === "success" || s.status === "skipped")) return "success";
  if (steps.every((s) => s.status === "pending")) return "pending";
  return "running";
}

export function elapsed(step: StepState, now: number): number | undefined {
  if (step.startedAt === undefined) return undefined;
  return (step.endedAt ?? now) - step.startedAt;
}

export function phaseElapsed(phase: PhaseState, now: number): number | undefined {
  const started = phase.steps
    .map((s) => s.startedAt)
    .filter((v): v is number => v !== undefined);
  if (started.length === 0) return undefined;
  const min = Math.min(...started);
  const allDone = phase.steps.every((s) => s.startedAt === undefined || s.endedAt !== undefined);
  const ends = phase.steps
    .map((s) => s.endedAt)
    .filter((v): v is number => v !== undefined);
  const max = allDone && ends.length > 0 ? Math.max(...ends) : now;
  return max - min;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
