---
title: "The Handler Surface"
description: "Every method a handler gets: logging, status, note, progress bars, checklists, and where log output lands."
---

Every handler receives one object. `rollback` receives a related but smaller
one; see [Rollbacks](../guides/rollbacks#the-rollback-context) for exactly what
it gets.

| | |
| --- | --- |
| `input` | the value passed to `run()` |
| `ctx` | everything earlier steps produced, fully typed |
| `signal` | an `AbortSignal` that aborts on timeout, Ctrl-C, or an external cancel |
| `attempt` | 1-based; useful alongside `retry` |
| `phase` / `step` | the names of this step's phase and itself |
| `log` / `info` / `warn` / `error` / `success` | a line, placed per `logPlacement` |
| `status(text)` | a transient one-liner beside the step, cleared when it settles |
| `note(text)` | annotates the step's title and stays |
| `progress({ total, label })` | a progress bar |
| `task(label)` | one nested checklist item |
| `tasks([...] as const)` | a whole checklist, keyed for typed lookup |
| `cache` | read/write/clear cached phases declared earlier; see [Caching](../guides/caching) |

## `status` vs `note`

Both write next to the step name, and the difference is lifetime. `status` is
scratch space for a step in flight — it is wiped the moment the step settles.
`note` is part of the title: written once (or replaced by a later call), it
stays on the finished line, which is where a count, a size, or an id belongs.

```ts
.addStep({
  name: "query database",
  handler: async ({ status, note }) => {
    status("scanning");            // ⠸ query database  › scanning
    const rows = await db.all(sql);
    note(`${rows.length} rows found`);
    return { rows };
  },
})
// ✔ query database (400 rows found)                                    1.2s
```

Calling `note` again replaces the text; `note("")` removes it entirely. Both
renderers show it — the live frame in the title itself, the plain/CI renderer on
the step's own line.

## `log` / `info` / `warn` / `error` / `success`

These five all write a line; they differ only in the icon/style attached to it.
Where the line actually lands is controlled by the script's `logPlacement`
option; see the section below. A `rollback` only gets `log`, not the other four;
compensation output does not need the same severity levels a handler's does.

## Progress bars

```ts
handler: async ({ progress }) => {
  const bar = progress({ total: 428, label: "resolving" });
  for (let i = 0; i <= 428; i += 17) {
    bar.update(i, i < 200 ? "resolving" : "linking");
    await doWork();
  }
  bar.done();
  return { packages: 428 };
}
```

`progress` returns a `ProgressHandle`:

| method | effect |
| --- | --- |
| `update(value, label?)` | set the absolute value, optionally relabeling |
| `increment(by?)` | advance by `by` (default `1`) |
| `setTotal(total)` | change the total mid-flight |
| `setLabel(label)` | relabel without changing the value |
| `done()` | fill the bar and mark it no longer in-flight |
| `.value` / `.total` | current readouts |

Values are clamped to `[0, total]` automatically: passing a value outside that
range does not throw, it just clamps.

## Checklists

A single nested item:

```ts
const step = task("compile");
step.start();     // spinner
step.succeed();   // or fail(text) / skip(text)
```

Or a whole checklist at once, with typed, keyed lookup:

```ts
handler: async ({ tasks }) => {
  const list = tasks(["typecheck", "transform", "minify", "write manifest"]);

  for (const key of ["typecheck", "transform", "minify", "write manifest"] as const) {
    const item = list.get(key);
    item.start();
    await run(key);
    item.succeed();
  }
}
```

`tasks(labels)` takes the label list as a `const` tuple so `list.get(key)` is
typed to exactly those labels: passing a key that was not in the original list
is a compile error, not a runtime `undefined`. Both `TaskHandle.start` and
`.label` accept an optional replacement text; `succeed`, `fail`, and `skip` do
too, for a final label different from the one shown while it ran.

## Log placement

By default, `log`/`info`/`warn`/`error`/`success` write a permanent line above
the whole frame — the complete record for the run, in the order it happened.
`logPlacement`, a `ScriptOptions` field, moves them somewhere more local instead:

```ts
new Script({ name: "checkout", logPlacement: "step" })
```

| `logPlacement` | where it lands |
| --- | --- |
| `"scrollback"` (default) | a permanent line above the frame: the full run, in order |
| `"step"` | nested under the step that logged it, beside its tasks and progress bar |
| `"bottom"` | a rolling tail of the most recent lines, below the whole phase tree |

```text
  ✖ Main                                                                  320ms
     ✔ reserve inventory                                                  320ms
       • checked warehouse A          ← "step": nested where it happened
       • checked warehouse B
     ✖ boom                                                                 0ms
       boom
```

`"step"` and `"bottom"` both keep only the most recent handful of lines: they
trade completeness for locality, which is exactly what makes a rollback's
`log()` land next to the step it is undoing instead of scrolling past at the
top, out of context by the time the run ends. Reach for `"scrollback"` when the
log is the thing you need to still have once the run is over.

Only the live renderer honors `logPlacement`. The plain/CI renderer is already
sequential: every placement just prints each line immediately, in order, which
is already both complete and in place. See
[Terminal Rendering](../guides/terminal-rendering) for when each renderer is
chosen.
