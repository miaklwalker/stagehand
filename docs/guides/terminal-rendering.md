---
title: "Terminal Rendering"
description: "How Stagehand chooses between the live in-place frame and plain line output, and how the live frame keeps itself inside the viewport."
---

Stagehand renders the same run differently depending on where its output is
going, without any change to the script itself.

## Choosing a renderer

```ts
function supportsAnimation(): boolean {
  return Boolean(process.stdout.isTTY) && isColorEnabled();
}
```

The live, in-place frame is used only when stdout is an interactive TTY *and*
color is enabled. Color is auto-detected from the environment: it is off when
`NO_COLOR` is set to a non-empty value, off when `TERM=dumb`, on when
`FORCE_COLOR` is set to anything but `"0"`, and otherwise on exactly when stdout
is a TTY. In every other case (piped to a file, running in CI, redirected),
the plain renderer is used instead, which prints one line per event as it
happens, in order, with no cursor movement at all. That keeps CI logs greppable
and diffable without any special handling on the caller's side.

`ScriptOptions.plain` overrides the detection outright: `plain: true` forces the
plain renderer even on a real TTY, `plain: false` forces the live one even when
piped (mostly useful for testing the live renderer's output directly). Leaving
it `undefined` (the default) is what triggers auto-detection.

```ts
new Script({ name: "deploy", plain: process.env.CI === "true" })
```

`ScriptOptions.silent: true` suppresses all output entirely, live or plain;
useful in tests that only care about the returned `RunResult`.

## What each renderer looks like

The live frame repaints an in-place region for the phase tree, while writing
permanent log lines and the header above it:

```text
  ▌ deploy
  ▌ Build, upload and release a service

  ✔ Validation                                                             739ms
     ✔ resolve commit                                                      222ms
  ⠸ Build                                                                   17.7s
     ⠸ compile bundle  › transform                                           3.3s
       ▕██████████████░░░░░░░░░░▏  58%  412/710  src/router.ts
```

The plain renderer emits one line per phase start and one per step end, with no
redraw:

```text
▌ deploy
▌ Build, upload and release a service

› Validation
  ✔ resolve commit  222ms
  ✔ check permissions  517ms
› Build
  ✔ install dependencies (428 packages)  14.4s
  ✔ compile bundle (4084kB)  1.1s
```

Both end with the same closing summary block — on failure, the error and the
rollback count; on success, nothing extra beyond the final step lines.

## Symbols and color

Icons come from `symbols`, exported from the package, and degrade automatically
on platforms without solid Unicode support (checked via locale environment
variables on non-Windows, and `WT_SESSION`/`TERM_PROGRAM` on Windows): `✔`
becomes `√`, `⠸` becomes a plain ASCII spinner frame, and so on, so a script
never renders mojibake in an unfamiliar terminal.

`setColorEnabled(value)` and `isColorEnabled()` are exported too, for scripts
that want to override or inspect the auto-detected color state directly rather
than going through `NO_COLOR`/`FORCE_COLOR`. `palette` exposes the same 256-color
stylers (`accent`, `success`, `warning`, `error`, `info`, `muted`, `faint`,
plus `bold`/`dim`) the built-in renderer uses, for anything printing alongside
a script's own output that wants to match its look.

## Fitting the viewport

The live frame is always made to fit the terminal, and this is load-bearing
rather than cosmetic. Repainting works by moving the cursor up N lines and
redrawing, so a frame taller than the terminal scrolls its own anchor off
screen, and every subsequent repaint appends a fresh copy below it instead of
overwriting the old one. To prevent that, `renderBody` applies four
progressively stronger reductions until the frame fits the available rows:

1. everything, in full;
2. finished phases collapse to a one-line summary;
3. only the running phase keeps its steps, and drops their detail lines;
4. the running phase's steps are windowed around the one currently executing.

The step that is actually executing is never windowed out of view, and long
lines are truncated with an ellipsis rather than wrapped, so the frame's line
count stays predictable. A terminal resize invalidates the renderer's recorded
line count, so it abandons the old region and redraws fresh below it rather
than risk overwriting the wrong lines — a stale frame left behind in scrollback
is preferable to a corrupted cursor position. The closing frame, printed once
the run ends, is exempt from all of this: nothing repaints after it, so it is
free to print every step in full regardless of terminal height.

## `formatDuration`

`formatDuration(ms)`, exported from the package, is the same helper the
renderer uses for every duration shown (`"739ms"`, `"17.7s"`, `"1m 4s"`), handy
if a script wants to print its own timing in the same style as the frame around
it.
