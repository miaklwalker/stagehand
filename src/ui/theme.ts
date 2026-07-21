import { bold, dim, fg, isColorEnabled } from "./ansi.js";

const unicodeCapable = (() => {
  const env = process.env;
  if (process.platform !== "win32") {
    const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
    return locale === "" || /UTF-?8$/i.test(locale) || Boolean(env.TERM_PROGRAM);
  }
  return Boolean(env.WT_SESSION) || env.TERM_PROGRAM === "vscode";
})();

export const symbols = unicodeCapable
  ? {
      success: "✔",
      failure: "✖",
      pending: "○",
      skipped: "⊘",
      rolledBack: "↺",
      warning: "▲",
      info: "•",
      arrow: "›",
      brand: "▌",
      rule: "─",
      barFull: "█",
      barEmpty: "░",
      barLeft: "▕",
      barRight: "▏",
      spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    }
  : {
      success: "√",
      failure: "x",
      pending: "-",
      skipped: "~",
      rolledBack: "<",
      warning: "!",
      info: "*",
      arrow: ">",
      brand: "|",
      rule: "-",
      barFull: "#",
      barEmpty: ".",
      barLeft: "[",
      barRight: "]",
      spinner: ["|", "/", "-", "\\"],
    };

export const palette = {
  accent: fg(141),
  success: fg(78),
  warning: fg(221),
  error: fg(203),
  info: fg(117),
  muted: fg(245),
  faint: fg(240),
  bold,
  dim,
};

export function spinnerFrame(tick: number): string {
  const frames = symbols.spinner;
  return frames[tick % frames.length] ?? frames[0] ?? "-";
}

/** Total render width, clamped so wide terminals stay readable. */
export function frameWidth(): number {
  const columns = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(columns - 1, 92));
}

export function supportsAnimation(): boolean {
  return Boolean(process.stdout.isTTY) && isColorEnabled();
}
