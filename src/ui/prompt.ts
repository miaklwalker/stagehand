/**
 * Hand-rolled interactive prompts — text, confirm, select, multiselect — built
 * on `node:readline`'s keypress events and the same ANSI primitives the live
 * frame uses. No dependency: `emitKeypressEvents` is a Node builtin, not a
 * package.
 *
 * Every prompt here follows the same shape: draw, wait for a keypress, redraw
 * or resolve. On a non-interactive stdin (CI, a pipe) nothing is drawn at all
 * — see `isInteractive`.
 */
import { emitKeypressEvents } from "node:readline";
import { PromptCancelledError, PromptUnavailableError, ScriptAbortedError } from "../errors.js";
import type {
  ConfirmPromptOptions,
  MultiSelectPromptOptions,
  SelectPromptOptions,
  TextPromptOptions,
} from "../types.js";
import { bold, cursor, dim, underline } from "./ansi.js";
import { palette, symbols } from "./theme.js";

interface PromptKey {
  sequence: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function unavailableMessage(message: string): string {
  return (
    `Prompt "${message}" has no default and stdin is not an interactive terminal ` +
    `(CI, a pipe, or a non-TTY subprocess). Provide a default so the script can fall back to it.`
  );
}

/** Listens for keypresses on stdin, toggling raw mode for the duration. */
function attachKeys(onKey: (key: PromptKey) => void): () => void {
  const stdin = process.stdin;
  emitKeypressEvents(stdin);
  const wasRaw = Boolean(stdin.isRaw);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  const listener = (_sequence: string, key: PromptKey | undefined): void => {
    if (key) onKey(key);
  };
  stdin.on("keypress", listener);

  return () => {
    stdin.off("keypress", listener);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
  };
}

/** Rejects (once) if `signal` aborts while a prompt is still open. */
function attachAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    queueMicrotask(onAbort);
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Repaints an in-place region, the same erase-then-redraw trick the live frame uses. */
function makePainter(stream: NodeJS.WriteStream): (lines: string[]) => void {
  let previousLines = 0;
  return (lines: string[]): void => {
    const erase =
      previousLines > 0 ? cursor.up(previousLines - 1) + cursor.toStart + cursor.eraseDown : "";
    stream.write(erase + lines.join("\n"));
    previousLines = lines.length;
  };
}

function isPrintable(key: PromptKey): boolean {
  if (key.ctrl || key.meta) return false;
  const code = key.sequence.codePointAt(0);
  return code !== undefined && code >= 0x20 && key.name !== "escape";
}

export async function promptText(options: TextPromptOptions, signal?: AbortSignal): Promise<string> {
  if (!isInteractive()) {
    if (options.default !== undefined) return options.default;
    throw new PromptUnavailableError(unavailableMessage(options.message));
  }

  const stream = process.stdout;
  const paint = makePainter(stream);
  let value = "";
  let errorText: string | null = null;

  return new Promise<string>((resolve, reject) => {
    const finish = (): void => {
      detachKeys();
      detachAbort();
    };

    const detachAbort = attachAbort(signal, () => {
      finish();
      reject(signal?.reason ?? new ScriptAbortedError("cancelled"));
    });

    const render = (): void => {
      const echo = options.mask ? "•".repeat(value.length) : value;
      const shown = echo || (options.placeholder ? dim(options.placeholder) : "");
      const lines = [`${palette.accent(symbols.arrow)} ${bold(options.message)} ${shown}`];
      if (errorText) lines.push(`  ${palette.error(symbols.failure)} ${errorText}`);
      paint(lines);
    };

    const detachKeys = attachKeys((key) => {
      if (key.ctrl && key.name === "c") {
        finish();
        reject(new PromptCancelledError());
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const candidate = value || options.default || "";
        void (async () => {
          if (options.validate) {
            const result = await options.validate(candidate);
            if (result !== true) {
              errorText = result;
              render();
              return;
            }
          }
          finish();
          const echo = options.mask ? "•".repeat(candidate.length) : candidate;
          paint([`${palette.success(symbols.success)} ${bold(options.message)} ${echo}`]);
          stream.write("\n");
          resolve(candidate);
        })();
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        errorText = null;
        render();
        return;
      }
      if (isPrintable(key)) {
        value += key.sequence;
        errorText = null;
        render();
      }
    });

    render();
  });
}

export async function promptConfirm(
  options: ConfirmPromptOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isInteractive()) {
    if (options.default !== undefined) return options.default;
    throw new PromptUnavailableError(unavailableMessage(options.message));
  }

  const stream = process.stdout;
  const paint = makePainter(stream);
  let value = options.default ?? true;

  return new Promise<boolean>((resolve, reject) => {
    const finish = (): void => {
      detachKeys();
      detachAbort();
      stream.write(cursor.show);
    };

    const detachAbort = attachAbort(signal, () => {
      finish();
      reject(signal?.reason ?? new ScriptAbortedError("cancelled"));
    });

    const settle = (result: boolean): void => {
      finish();
      paint([
        `${palette.success(symbols.success)} ${bold(options.message)} ${result ? "Yes" : "No"}`,
      ]);
      stream.write("\n");
      resolve(result);
    };

    const render = (): void => {
      const yes = value ? bold(underline("Yes")) : "Yes";
      const no = !value ? bold(underline("No")) : "No";
      paint([`${palette.accent(symbols.arrow)} ${bold(options.message)} ${yes} / ${no}`]);
    };

    stream.write(cursor.hide);

    const detachKeys = attachKeys((key) => {
      if (key.ctrl && key.name === "c") {
        finish();
        reject(new PromptCancelledError());
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        settle(value);
        return;
      }
      if (key.name === "left" || key.name === "right" || key.name === "tab") {
        value = !value;
        render();
        return;
      }
      if (key.sequence === "y" || key.sequence === "Y") {
        settle(true);
        return;
      }
      if (key.sequence === "n" || key.sequence === "N") {
        settle(false);
      }
    });

    render();
  });
}

export async function promptSelect<Value>(
  options: SelectPromptOptions<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (options.choices.length === 0) {
    throw new Error(`prompt.select("${options.message}") was given an empty choices list`);
  }
  if (!isInteractive()) {
    if (options.default !== undefined) return options.default;
    throw new PromptUnavailableError(unavailableMessage(options.message));
  }

  const stream = process.stdout;
  const paint = makePainter(stream);
  const defaultIndex = options.choices.findIndex((choice) => choice.value === options.default);
  let index = Math.max(0, defaultIndex);

  return new Promise<Value>((resolve, reject) => {
    const finish = (): void => {
      detachKeys();
      detachAbort();
      stream.write(cursor.show);
    };

    const detachAbort = attachAbort(signal, () => {
      finish();
      reject(signal?.reason ?? new ScriptAbortedError("cancelled"));
    });

    const render = (): void => {
      const lines = [`${palette.accent(symbols.arrow)} ${bold(options.message)}`];
      options.choices.forEach((choice, i) => {
        const pointer = i === index ? palette.accent(symbols.arrow) : " ";
        const label = i === index ? bold(choice.label) : choice.label;
        const hint = choice.hint ? dim(`  ${choice.hint}`) : "";
        lines.push(`  ${pointer} ${label}${hint}`);
      });
      paint(lines);
    };

    stream.write(cursor.hide);

    const detachKeys = attachKeys((key) => {
      if (key.ctrl && key.name === "c") {
        finish();
        reject(new PromptCancelledError());
        return;
      }
      if (key.name === "up") {
        index = (index - 1 + options.choices.length) % options.choices.length;
        render();
        return;
      }
      if (key.name === "down") {
        index = (index + 1) % options.choices.length;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const choice = options.choices[index];
        if (!choice) return;
        finish();
        paint([`${palette.success(symbols.success)} ${bold(options.message)} ${choice.label}`]);
        stream.write("\n");
        resolve(choice.value);
      }
    });

    render();
  });
}

export async function promptMultiselect<Value>(
  options: MultiSelectPromptOptions<Value>,
  signal?: AbortSignal,
): Promise<Value[]> {
  if (options.choices.length === 0) {
    throw new Error(`prompt.multiselect("${options.message}") was given an empty choices list`);
  }
  if (!isInteractive()) {
    if (options.default !== undefined) return [...options.default];
    throw new PromptUnavailableError(unavailableMessage(options.message));
  }

  const stream = process.stdout;
  const paint = makePainter(stream);
  const defaults = options.default;
  let index = 0;
  const selected = new Set<number>(
    defaults ? options.choices.flatMap((c, i) => (defaults.includes(c.value) ? [i] : [])) : [],
  );
  let errorText: string | null = null;

  return new Promise<Value[]>((resolve, reject) => {
    const finish = (): void => {
      detachKeys();
      detachAbort();
      stream.write(cursor.show);
    };

    const detachAbort = attachAbort(signal, () => {
      finish();
      reject(signal?.reason ?? new ScriptAbortedError("cancelled"));
    });

    const render = (): void => {
      const lines = [
        `${palette.accent(symbols.arrow)} ${bold(options.message)} ${dim("(space to toggle, enter to confirm)")}`,
      ];
      options.choices.forEach((choice, i) => {
        const pointer = i === index ? palette.accent(symbols.arrow) : " ";
        const box = selected.has(i) ? palette.success(symbols.success) : dim(symbols.pending);
        const label = i === index ? bold(choice.label) : choice.label;
        const hint = choice.hint ? dim(`  ${choice.hint}`) : "";
        lines.push(`  ${pointer} ${box} ${label}${hint}`);
      });
      if (errorText) lines.push(`  ${palette.error(symbols.failure)} ${errorText}`);
      paint(lines);
    };

    stream.write(cursor.hide);

    const detachKeys = attachKeys((key) => {
      if (key.ctrl && key.name === "c") {
        finish();
        reject(new PromptCancelledError());
        return;
      }
      if (key.name === "up") {
        index = (index - 1 + options.choices.length) % options.choices.length;
        render();
        return;
      }
      if (key.name === "down") {
        index = (index + 1) % options.choices.length;
        render();
        return;
      }
      if (key.name === "space") {
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
        errorText = null;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const count = selected.size;
        if (options.min !== undefined && count < options.min) {
          errorText = `choose at least ${options.min}`;
          render();
          return;
        }
        if (options.max !== undefined && count > options.max) {
          errorText = `choose at most ${options.max}`;
          render();
          return;
        }
        const chosen = options.choices.filter((_, i) => selected.has(i));
        finish();
        const summary = chosen.length > 0 ? chosen.map((c) => c.label).join(", ") : "(none)";
        paint([`${palette.success(symbols.success)} ${bold(options.message)} ${summary}`]);
        stream.write("\n");
        resolve(chosen.map((c) => c.value));
      }
    });

    render();
  });
}
