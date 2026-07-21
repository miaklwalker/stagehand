/**
 * Minimal ANSI toolkit. No dependencies, no global mutation of the stream.
 */

const ESC = "[";
const ANSI_PATTERN = /\[[0-9;]*m/g;

function detectColor(): boolean {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

let colorEnabled = detectColor();

export function isColorEnabled(): boolean {
  return colorEnabled;
}

export function setColorEnabled(value: boolean): void {
  colorEnabled = value;
}

export type Styler = (input: string) => string;

function style(open: string, close: string): Styler {
  return (input) => (colorEnabled ? open + input + close : input);
}

export const bold = style(`${ESC}1m`, `${ESC}22m`);
export const dim = style(`${ESC}2m`, `${ESC}22m`);
export const italic = style(`${ESC}3m`, `${ESC}23m`);
export const underline = style(`${ESC}4m`, `${ESC}24m`);
export const inverse = style(`${ESC}7m`, `${ESC}27m`);

/** 256-colour foreground. Degrades to plain text when colour is off. */
export function fg(code: number): Styler {
  return style(`${ESC}38;5;${code}m`, `${ESC}39m`);
}

/** 256-colour background. */
export function bg(code: number): Styler {
  return style(`${ESC}48;5;${code}m`, `${ESC}49m`);
}

export const cursor = {
  hide: `${ESC}?25l`,
  show: `${ESC}?25h`,
  up: (n: number): string => (n > 0 ? `${ESC}${n}A` : ""),
  toStart: `${ESC}G`,
  eraseDown: `${ESC}0J`,
};

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Terminal cell width. Handles the wide-character ranges that actually turn up
 * in CLI output (CJK, emoji) and treats combining marks as zero-width.
 */
export function stringWidth(input: string): number {
  let total = 0;
  for (const char of stripAnsi(input)) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x200d) continue; // zero-width joiner
    if (cp >= 0x0300 && cp <= 0x036f) continue; // combining diacriticals
    if (cp >= 0xfe00 && cp <= 0xfe0f) continue; // variation selectors
    total += isWide(cp) ? 2 : 1;
  }
  return total;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Truncate to a visible width while keeping escape sequences intact, so a
 * clipped line never leaks colour into the rest of the frame.
 */
export function truncate(input: string, max: number): string {
  if (max <= 0) return "";
  if (stringWidth(input) <= max) return input;

  let out = "";
  let visible = 0;
  let sawEscape = false;
  let index = 0;

  while (index < input.length) {
    if (input.startsWith("[", index)) {
      const end = input.indexOf("m", index);
      if (end !== -1) {
        out += input.slice(index, end + 1);
        sawEscape = true;
        index = end + 1;
        continue;
      }
    }
    const char = String.fromCodePoint(input.codePointAt(index) as number);
    const w = stringWidth(char);
    if (visible + w > max - 1) break;
    out += char;
    visible += w;
    index += char.length;
  }

  return out + "…" + (sawEscape && colorEnabled ? `${ESC}0m` : "");
}

export function padEnd(input: string, target: number): string {
  const gap = target - stringWidth(input);
  return gap > 0 ? input + " ".repeat(gap) : input;
}
