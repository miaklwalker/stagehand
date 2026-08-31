/**
 * Command-line flag parsing for `Script.defineFlag` / `context.flags`.
 * No dependency — a whitelist-driven pass over argv, nothing more.
 */
import { MissingFlagValueError, UnknownFlagError } from "./errors.js";

/** Recorded by `defineFlag`; type-erased, the same way step/phase defs are. */
export interface FlagDef {
  name: string;
  long: string;
  short?: string;
  description?: string;
  boolean: boolean;
  hasDefault: boolean;
  default: unknown;
}

/** `"dryRun"` -> `"dry-run"`. Already-kebab input passes through unchanged. */
export function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Parses `argv` (already stripped of the node binary and script path — i.e.
 * `process.argv.slice(2)`) against the flags a script declared.
 *
 * `--flag value`, `--flag=value`, and `-f value` are all understood. A
 * boolean flag never consumes the next token: its bare presence is `true`
 * (`--flag=false` is honoured too, for the rare case of overriding a
 * `default: true`).
 *
 * Every other token — anything not starting with `-`, or a bare `-` — is a
 * positional argument and is silently ignored; this parser only cares about
 * the flags it was told to look for.
 *
 * @throws {UnknownFlagError} for a `--foo`/`-f` this script never declared.
 * @throws {MissingFlagValueError} for a non-boolean flag with nothing after it.
 */
export function parseFlags(argv: readonly string[], defs: readonly FlagDef[]): Record<string, unknown> {
  const byLong = new Map(defs.map((def) => [def.long, def] as const));
  const byShort = new Map(
    defs.filter((def): def is FlagDef & { short: string } => def.short !== undefined).map((def) => [def.short, def] as const),
  );

  const result: Record<string, unknown> = {};
  for (const def of defs) {
    if (def.hasDefault) result[def.name] = def.default;
    else if (def.boolean) result[def.name] = false;
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i] as string;
    i += 1;

    let def: FlagDef | undefined;
    let inlineValue: string | undefined;
    let label: string;

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
      label = `--${key}`;
      def = byLong.get(key);
      if (!def) throw new UnknownFlagError(label, [...byLong.keys()].map((long) => `--${long}`));
    } else if (token.startsWith("-") && token.length > 1) {
      const key = token.slice(1);
      label = `-${key}`;
      def = byShort.get(key);
      if (!def) throw new UnknownFlagError(label, [...byShort.keys()].map((short) => `-${short}`));
    } else {
      continue;
    }

    if (def.boolean) {
      result[def.name] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }

    if (inlineValue !== undefined) {
      result[def.name] = inlineValue;
      continue;
    }

    const next = argv[i];
    if (next === undefined) throw new MissingFlagValueError(label);
    result[def.name] = next;
    i += 1;
  }

  return result;
}
