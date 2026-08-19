---
name: 'reporting-progress'
description: >
  Covers the handler UI surface — `status(text)` vs `note(text)`, `progress({ total, label })` and its `ProgressHandle` (`update`/`increment`/`setTotal`/`setLabel`/`done`), `task(label)`/`tasks([...] as const)` and `TaskHandle`/`TaskListHandle`, and the `log`/`info`/`warn`/`error`/`success` severity lines. Load this for "show a progress bar," "put a row count on the finished step line," "run a typed checklist inside a step," or any handler-level UI call that isn't about where the output physically renders.
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/handler-surface.md'
  - 'miaklwalker/stagehand:src/context.ts'
  - 'miaklwalker/stagehand:src/script.ts'
---

# Stagehand — Reporting Progress From a Step

Every handler receives `status`, `note`, `progress`, `task`, `tasks`, and the five log methods as part of its single context object. `rollback` gets a smaller subset — `log` (no `info`/`warn`/`error`/`success`), `status`, `note`, and `progress`, but not `task`/`tasks`.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

const result = await new Script({ name: "sync" })
  .addStep({
    name: "fetch records",
    handler: async ({ status, note, progress, log }) => {
      status("connecting");
      log("opened connection");

      const total = 428;
      const bar = progress({ total, label: "fetching" });
      const rows: number[] = [];
      for (let i = 0; i < total; i++) {
        rows.push(i);
        bar.update(i + 1);
      }
      bar.done();

      note(`${rows.length} rows found`);
      return { rows };
    },
  })
  .run({});
```

## Core Patterns

### `status` for scratch space, `note` for what should survive on the finished line

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

`status` is wiped the instant the step settles; `note` is written into the step's title and stays. Calling either again replaces the previous text — neither is cumulative — and `note("")` removes the annotation entirely.

### A progress bar with a mid-flight relabel

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

`progress` returns a `ProgressHandle` with `update(value, label?)`, `increment(by = 1)`, `setTotal(total)`, `setLabel(label)`, `done()`, and readonly `.value`/`.total`; every value it accepts is clamped to `[0, total]`.

### A typed checklist with `tasks()`

```ts
handler: async ({ tasks }) => {
  const list = tasks(["typecheck", "transform", "minify", "write manifest"] as const);

  for (const key of ["typecheck", "transform", "minify", "write manifest"] as const) {
    const item = list.get(key);
    item.start();
    await run(key);
    item.succeed();
  }
}

async function run(step: string) {}
```

`tasks(labels)` takes the label list as a `const` tuple, so `list.get(key)` is typed to exactly those labels — a single ad hoc item can also be created with `task(label)`, returning one `TaskHandle` (`start`/`label`/`succeed`/`fail`/`skip`, each taking an optional replacement text).

### Severity-tagged lines with `log`/`info`/`warn`/`error`/`success`

```ts
handler: async ({ log, info, warn, error, success }) => {
  log("starting migration");
  info("using batch size 500");
  warn("retrying batch 3");
  error("batch 7 failed, continuing");
  success("migration complete");
  return {};
}
```

All five just differ in icon/style; where the line lands is controlled by the script's `logPlacement` option, covered in the log-placement-and-rendering skill.

## Common Mistakes

### HIGH Using status() for a value meant to persist on the finished step line

Wrong:
```ts
handler: async ({ status }) => {
  const rows = await db.all(sql);
  status(`${rows.length} rows found`);  // gone the moment this step finishes
  return { rows };
}
```

Correct:
```ts
handler: async ({ status, note }) => {
  status("scanning");
  const rows = await db.all(sql);
  note(`${rows.length} rows found`);  // stays on the finished line
  return { rows };
}
```

`status` is scratch space for a step in flight — it is deleted (`delete item.state.statusText`) the instant the step settles, whether it succeeds or fails; only `note` survives onto the finished line.

Source: docs/guides/handler-surface.md; src/script.ts (delete item.state.statusText on success/failure)

### LOW Calling note() repeatedly expecting it to append, like a log

Wrong:
```ts
note("400 rows");
note("2 skipped");  // "400 rows" is gone — the title now reads "2 skipped"
```

Correct:
```ts
note(`${rowCount} rows, ${skipped} skipped`);
```

`note` replaces whatever it previously set rather than accumulating; `note("")` clears it.

Source: docs/guides/handler-surface.md

### LOW Passing a plain string[] (not `as const`) to tasks()

Wrong:
```ts
const labels = ["typecheck", "transform", "minify"];
const list = tasks(labels);
list.get("tpyecheck");  // typo compiles — labels was string[], not a literal tuple
```

Correct:
```ts
const list = tasks(["typecheck", "transform", "minify"] as const);
list.get("tpyecheck");  // compile error
```

`tasks(labels)` needs the label list as a const tuple for `list.get(key)` to be typed to exactly those labels; a widened `string[]` makes `get()` accept any string, including a typo, with no compile error.

Source: docs/guides/handler-surface.md

### LOW Passing a value outside [0, total] to progress and expecting an error or warning

Wrong:
```ts
const bar = progress({ total: 100 });
bar.update(bytesUploaded);  // bytesUploaded is actually in KB — silently clamps to 100
```

Correct:
```ts
const bar = progress({ total: totalBytes });
bar.update(bytesUploaded);  // units matched to `total`
```

`update`/`increment`/`setTotal` all clamp silently to the valid range rather than throwing, so an off-by-one or unit mismatch in the caller's own math shows up only as a bar stuck at 0% or 100% with no diagnostic.

Source: src/context.ts createProgress() (clamp(...))

### HIGH Tension: Rich live observability vs. complete log record

`logPlacement` "step"/"bottom" produce the most pleasant live-TTY experience by capping what they retain, while "scrollback" is the only placement that is both complete and the default, and one choice applies to the whole script. Agents optimizing for this skill's goal (a beautifully-nested live view of status/note/progress/tasks next to the step they belong to) tend to leave `logPlacement` at "step" or "bottom" for a script that also needs a guaranteed-complete CI/audit trail, because they don't account for those two placements silently discarding older lines beyond a handful.

See also: skills/observability/log-placement-and-rendering/SKILL.md § Common Mistakes

See also: skills/observability/log-placement-and-rendering/SKILL.md — where status/note/log actually render depends entirely on logPlacement and which renderer is active; the two skills describe one mechanism from two ends.
