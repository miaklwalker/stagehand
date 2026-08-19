---
name: 'log-placement-and-rendering'
description: >
  logPlacement modes (scrollback/step/bottom) and how the live TTY frame differs from the plain/CI renderer, including which behaviors exist only in one of the two. Load this for "nest a rollback's log under the step it's undoing," "force plain output for CI," or "match my own console output to the script's styling."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/handler-surface.md'
  - 'miaklwalker/stagehand:docs/guides/terminal-rendering.md'
  - 'miaklwalker/stagehand:test/log-placement.test.ts'
  - 'miaklwalker/stagehand:test/note.test.ts'
---

# Stagehand — Log Placement and Terminal Rendering

`log`/`info`/`warn`/`error`/`success` all write a line; `logPlacement` (a `ScriptOptions` field) controls where that line lands in the live TTY frame. Which renderer is even active — live, in-place frame vs. plain sequential output — is chosen automatically per run, and only the live one honors `logPlacement` at all.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

const script = new Script({ name: "checkout", logPlacement: "step" }).addStep({
  name: "reserve inventory",
  handler: async ({ log }) => {
    log("checked warehouse A");
    return { reservationId: "res_1" };
  },
});

await script.run();
```

## Core Patterns

### Nest a rollback's log under the step it's undoing

```ts
import { Script } from "@michaelrwalker/stagehand";

await new Script({ name: "checkout", logPlacement: "step" })
  .addStep({
    name: "reserve inventory",
    handler: () => ({ reservationId: "res_1" }),
    rollback: ({ log }) => {
      log("released reservation res_1");
    },
  })
  .addStep({
    name: "boom",
    handler: () => {
      throw new Error("boom");
    },
  })
  .run();
```

With `logPlacement: "step"`, a rollback's `log()` calls render nested under the step being undone instead of scrolling past at the top of the frame, keeping compensation output next to the failure that caused it.

### Force plain, deterministic output for CI

```ts
import { Script } from "@michaelrwalker/stagehand";

new Script({ name: "deploy", plain: process.env.CI === "true" });
```

`plain: true` forces the sequential, non-repainting renderer even on a real TTY; `plain: false` forces the live one even when piped. Leaving `plain` unset (the default) auto-detects: live only when `process.stdout.isTTY` is true and color is enabled (color is off under `NO_COLOR` or `TERM=dumb`, on under `FORCE_COLOR`, otherwise on exactly when stdout is a TTY).

### Roll a live tail of recent lines instead of nesting per step

```ts
import { Script } from "@michaelrwalker/stagehand";

new Script({ name: "sync", logPlacement: "bottom" }).addStep({
  name: "sync records",
  handler: async ({ log }) => {
    log("synced batch 1");
    log("synced batch 2");
    return { batches: 2 };
  },
});
```

`"bottom"` renders a single rolling tail of the most recent lines below the whole phase tree (not per step), which is cheaper to scan when many steps are logging concurrently. Like `"step"`, it keeps only the most recent handful of entries.

### Match custom console output to the script's own styling

```ts
import { formatDuration, isColorEnabled, palette, setColorEnabled, symbols } from "@michaelrwalker/stagehand";

console.log(`${symbols.success} deploy finished in ${formatDuration(4084)}`);
console.log(palette.warning("cache stale, rebuilding"));

setColorEnabled(false); // override auto-detection directly, rather than via NO_COLOR/FORCE_COLOR
isColorEnabled(); // false
```

`symbols` degrades automatically on terminals without solid Unicode support (`✔` becomes `√`, and so on) and `palette` exposes the same 256-color stylers (`accent`, `success`, `warning`, `error`, `info`, `muted`, `faint`, `bold`, `dim`) the built-in renderer uses.

## Common Mistakes

### MEDIUM Treating step/bottom placement as a complete run record

Wrong:
```ts
new Script({ name: "audit", logPlacement: "bottom" });
// assumed every log() call is retrievable after the run for compliance review
```

Correct:
```ts
new Script({ name: "audit", logPlacement: "scrollback" });
```

Both `"step"` and `"bottom"` keep only the most recent handful of lines per step or per run — only `"scrollback"` (the default) is guaranteed to retain every line, in order, for the whole run.

Source: docs/guides/handler-surface.md; docs/guides/terminal-rendering.md

### LOW Assuming logPlacement behaves the same in CI as it did locally

Wrong:
```ts
// developer tunes `logPlacement: "step"` by eye in a local terminal,
// then is confused that CI logs show every line in plain top-level order instead
```

Correct:
```ts
// treat logPlacement as a live-TTY-only concern; CI output is always flat and complete
```

Only the live renderer honors `logPlacement` — the plain/CI renderer (chosen automatically off a TTY, under `NO_COLOR`, or `TERM=dumb`) is already sequential and prints every line immediately in order regardless of the setting.

Source: docs/guides/terminal-rendering.md; docs/guides/handler-surface.md

### LOW Hardcoding Stagehand's glyphs into a script's own console output

Wrong:
```ts
console.log(`✔ done`); // renders as mojibake on the same terminals Stagehand degrades for
```

Correct:
```ts
import { symbols, palette } from "@michaelrwalker/stagehand";

console.log(`${symbols.success} done`);
```

Stagehand degrades its own symbols automatically on terminals without solid Unicode support, but that degradation is internal to the renderer and does not apply to anything a script prints itself unless it goes through the exported `symbols`/`palette` helpers.

Source: docs/guides/terminal-rendering.md

### HIGH Tension: Rich live observability vs. complete log record

`logPlacement: "step"`/`"bottom"` produce the most pleasant live-TTY experience by capping what they retain, while `"scrollback"` is the only placement that is both complete and the default, and one choice applies to the whole script. Agents optimizing for this skill's goal tend to pick a locally-nice-looking placement like `"step"` as a script-wide default because they don't account for the need — covered by progress reporting — for a guaranteed-complete CI/audit trail from the same run.

See also: skills/observability/reporting-progress/SKILL.md § Common Mistakes

### HIGH Tension: Routine authoring instincts vs. host-controlled ScriptOptions

A routine is built as an ordinary `Script`, which makes it natural to set `rollback`/`logPlacement`/`silent` on it as if authoring a standalone safety policy, but every one of those is discarded the moment it is mounted since only the host's own `ScriptOptions` ever apply. Agents optimizing for this skill's goal tend to bake `logPlacement` choices into a reusable sub-script and assume they travel with it because they don't account for mounting's constraint that a routine's own `ScriptOptions` are overridden entirely by the host script.

See also: skills/reuse/reusable-routines-and-mounts/SKILL.md § Common Mistakes, skills/compensation-safety/adding-rollbacks/SKILL.md § Common Mistakes
