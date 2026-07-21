import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Called for each complete line on stdout or stderr, as it arrives. */
  onLine?: (line: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  readonly command: string;
  readonly code: number | null;
  readonly stderr: string;

  constructor(command: string, code: number | null, stderr: string) {
    // Keep the lines that say what went wrong, drop the ones that say where
    // the log file is — otherwise the useful part falls off the end.
    const noise = /^npm (notice|warn)\b|A complete log of this run|^\s*$/;
    const meaningful = stderr
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !noise.test(line));
    const tail = meaningful.slice(-3).join(" · ");
    super(`${command} exited with ${code ?? "signal"}${tail ? `: ${tail}` : ""}`);
    this.name = "ExecError";
    this.command = command;
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Run a command, streaming lines to `onLine` so a step can surface progress
 * while it works. Rejects with ExecError on a non-zero exit; an aborted signal
 * kills the child and rejects with an AbortError the runner treats as a cancel.
 */
export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      ...(options.signal ? { signal: options.signal } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let pending = "";

    const consume = (chunk: string): void => {
      if (!options.onLine) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) options.onLine(trimmed);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      consume(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      consume(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ExecError(`${command} ${args.join(" ")}`, code, stderr || stdout));
    });
  });
}

/** Run a command purely for its stdout, ignoring a non-zero exit. */
export async function tryExec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<string | null> {
  try {
    const { stdout } = await exec(command, args, options);
    return stdout.trim();
  } catch {
    return null;
  }
}
