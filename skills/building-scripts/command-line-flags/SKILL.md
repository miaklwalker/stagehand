---
name: 'command-line-flags'
description: >
  Covers `defineFlag` and `context.flags` — typed string and boolean flags parsed from argv once before
  any phase runs, `long`/`short` aliases, defaults, `UnknownFlagError` / `MissingFlagValueError`,
  `run(input, { argv })` for tests, and mapping a flag onto a mounted routine's input. Load this for
  "add a --force or --env flag," "gate a step on a CLI flag," or "test a script with flags."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.8.0'
sources:
  - 'miaklwalker/stagehand:docs/guides/flags.md'
  - 'miaklwalker/stagehand:docs/reference/script.md'
  - 'miaklwalker/stagehand:src/flags.ts'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:test/flags.test.ts'
---

# Stagehand — Command-Line Flags

`defineFlag` declares a flag. `run()` parses `process.argv` once, before any phase, and every step, `when`, `stale` and rollback receives the result as `flags`, typed from the declarations.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

await new Script({ name: "deploy" })
  .defineFlag({ name: "environment", long: "env", short: "e", default: "staging" })
  .defineFlag({ name: "force", short: "f", boolean: true })
  .addStep({
    name: "ship",
    handler: ({ flags }) => {
      // flags.environment: string   flags.force: boolean
      return { env: flags.environment };
    },
  })
  .run();
// myScript --env production -f
```

## Core Patterns

### String vs boolean

A string flag with a `default` is `string`; without one it is `string | undefined`. A boolean flag (`boolean: true`) is presence-based, never consumes the next token, and resolves to `default ?? false`. `--flag=value` and `--flag value` both work; `--force=false` is honoured.

### Gate work on a flag

```ts
.addPhase("Publish", { when: ({ flags }) => flags.production })
.addStep({ name: "notify", when: ({ flags }) => !flags.quiet, handler: async () => {} })
.addPhase("Build", { cache: { store, stale: ({ flags }) => flags.fresh } })
```

When the flag changes *how* a value is produced rather than *whether* a step runs, use `addBranch` (see skills/building-scripts/branching-steps/SKILL.md).

### Test with `argv`

```ts
const result = await script.run({ service: "api" }, { argv: ["--env", "production"] });
```

`argv` replaces `process.argv.slice(2)`; use it in tests and when the script is one subcommand of a bigger CLI.

### Hand a flag to a routine

```ts
new Script({ name: "sync" })
  .defineFlag({ name: "environment", long: "env", default: "staging" })
  .use(pullChannel, { input: ({ flags }) => ({ env: flags.environment }) })
```

## Common Mistakes

### HIGH Declaring flags on a routine

Wrong:
```ts
routineFor<{ env: string }>()("pull", (script) => script.defineFlag({ name: "env" })) // flags are top-level only
```

Correct:
```ts
// declare on the script you run; pass it down through use()'s input mapper
```

`defineFlag` belongs to the entry script. A mounted script's flags are not merged into the host, and a routine's `flags` are typed loosely (`Record<string, unknown>`).

### MEDIUM Expecting `run()` to return `{ ok: false }` for a bad flag

Wrong:
```ts
const result = await script.run(undefined, { argv: ["--nope"] });
if (!result.ok) { /* never reached */ }
```

Correct:
```ts
try { await script.run(undefined, { argv }); }
catch (error) { if (error instanceof UnknownFlagError) console.error(error.flag); }
```

`UnknownFlagError` and `MissingFlagValueError` are thrown directly, before any phase, and ignore `throwOnError`.

### MEDIUM Assuming undeclared flags are always rejected

A script with **no** `defineFlag` call ignores argv entirely; the unknown-flag check starts at the first declaration. Adding a first flag can therefore break a script that read `process.argv` by hand.

### LOW Duplicate names

`defineFlag` throws `DuplicateNameError` (`kind: "flag"`) if `name`, the resolved long form, or `short` is already used.

Source: docs/guides/flags.md; src/flags.ts
