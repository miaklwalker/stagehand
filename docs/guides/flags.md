---
title: "Flags"
description: "Declaring command-line flags with defineFlag and reading them back, typed, from context.flags."
---

`defineFlag` declares a flag this script reads off the command line; `run()`
parses `process.argv` against every declared flag once, before any phase
executes, and hands the result to every step as `context.flags`:

```ts
new Script({ name: "deploy" })
  .defineFlag({ name: "environment", long: "env", short: "e", default: "staging" })
  .defineFlag({ name: "force", short: "f", boolean: true })
  .addStep({
    name: "deploy",
    handler: async ({ flags }) => {
      // flags.environment: string
      // flags.force: boolean
    },
  });
```

```bash
myScript --env prod --force
myScript -e prod -f
```

Both invocations resolve to the same `flags`. `flags.environment` is typed
and autocompletes exactly as `ctx` and `cache` do — declaring a flag widens
the script's `Flags` type the same way `addStep` widens `Ctx`.

## `name`, `long`, and `short`

`name` does double duty: it is the property on `context.flags`, and — kebab
cased — the default long `--` form. Most flags need nothing more:

```ts
.defineFlag({ name: "environment" }) // context.flags.environment, --environment
```

`short` adds a single-letter `-` alias. `long` overrides the derived form for
the rare case where the property name and the flag itself should read
differently — a short property name paired with a longer, clearer flag, or
vice versa:

```ts
.defineFlag({ name: "environment", long: "env", short: "e" })
// context.flags.environment — accepts --env or -e, not --environment
```

## String flags

```ts
.defineFlag({ name: "environment", default: "staging" })
```

| | resolves to |
| --- | --- |
| `default` given | `string` — used when the flag is absent |
| no `default` | `string \| undefined` |

A value can follow as a separate token or after `=`: `--environment prod` and
`--environment=prod` (and the short form, `-e prod`) all set the same thing.

## Boolean flags

```ts
.defineFlag({ name: "force", short: "f", boolean: true })
```

A boolean flag is presence-based, not value-based: `myScript --force` sets it
`true`; leaving it off resolves to `default ?? false`. It never consumes the
next token as a value, so `--force --env prod` parses as both flags, not
`force` swallowing `"--env"`. `--force=false` is honoured too, mainly useful
for overriding a `default: true` from a wrapper script or an alias.

## Unknown flags and missing values

Once a script declares at least one flag, argv is checked against exactly
that list:

- an undeclared `--foo` or `-f` throws `UnknownFlagError`, before any phase
  runs;
- a non-boolean flag with nothing after it (`myScript --environment` and
  nothing more) throws `MissingFlagValueError`.

Both are thrown directly out of `run()`, the same way a bad `defineInput`
schema throws `SchemaValidationError` — never folded into `RunResult`, so
`throwOnError` has no effect on them.

A script that declares **no** flags skips this check entirely: whatever is in
argv is ignored, so scripts that read `process.argv` by hand for something
else (a smoke-test `--fail` flag, say) are unaffected until they opt in with
their first `defineFlag` call.

## Skipping a step or a phase with `when`

Both a step's `when` and a phase's `when` receive `flags` alongside `input`
and `ctx`, so a flag can gate a whole step or phase with no extra wiring:

```ts
.addPhase("Publish", { when: ({ flags }) => flags.production })
.addStep({
  name: "notify",
  when: ({ flags }) => !flags.quiet,
  handler: async () => { ... },
})
```

## Caching's `stale`

A cached phase or step's `stale` predicate sees `flags` too, so `--fresh` (or
whatever you call it) can force a cache miss without threading the flag
through `ctx` first:

```ts
.addPhase("Build", {
  cache: { store: fileStore("./cache.json"), stale: ({ flags }) => flags.fresh },
})
```

## Mapping a flag onto a routine's input

A routine (from `routineFor`) cannot declare its own flags — see
[Only at the top level](#only-at-the-top-level) — so the way to drive one with
a flag is the same mechanism that gives it any other input: the mount's
`input` mapper, which also receives `flags`.

```ts
new Script({ name: "sync" })
  .defineFlag({ name: "environment", long: "env", default: "staging" })
  .use(pullChannel, { input: ({ flags }) => ({ env: flags.environment }) })
```

No bespoke API for this — it is the same `use(routine, { input })` you would
reach for to map anything else onto a routine's input; `flags` is just one
more thing that mapper can read. See
[Reusable Scripts and Mounts](../guides/reusable-scripts#giving-a-mount-its-own-input).

## Testing, and running as one subcommand of a larger CLI

`run(input, { argv })` overrides what gets parsed instead of
`process.argv.slice(2)` — useful in tests, and for a script that is one
subcommand of a larger tool that has already sliced its own argv apart:

```ts
const result = await deploy.run(
  { service: "checkout-api" },
  { argv: ["--env", "production"] },
);
```

## Also on `RollbackContext`

Unlike `prompt`, `flags` is available during a rollback too — it is static,
parsed once up front, so there is no reason a compensation handler shouldn't
see it (`flags.dryRun`, say, to decide how thorough cleanup should be).

## Only at the top level

`defineFlag` is a `Script`-level concept, not a `Routine` one: a routine built
with `routineFor` cannot declare its own flags, and mounting a script via
`use()` does not bring its flags along. Flags model process-level CLI input
for the script actually being run, not something a reusable fragment
composes — declare them once, on the script you invoke, and hand pieces of it
down to a routine through [the mount's `input` mapper](#mapping-a-flag-onto-a-routines-input).

A step declared *inside* a `routineFor(...)` callback can still read
`context.flags` — typed loosely, as `Record<string, unknown>`, since the
routine is written away from any particular script and cannot know what flags
the eventual host will declare. That is the same reasoning as a `stepFor`
step's `flags`, and the same reasoning `Slots` already uses for `context.cache`.
The actual values reach it for free at runtime, since a mounted routine's
steps run through the host's own `run()` — only the type needed the fix.
