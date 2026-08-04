# stagehand

A fully typesafe, saga-style script framework for TypeScript, with a live terminal UI.

- **Scripts** are a collection of **phases**.
- **Phases** are a collection of **steps**.
- **Steps** have a `handler` and an optional `rollback` that fires when a *later* step fails.
- Whatever a handler returns is merged into a **typed context** that every later step can read.
- A step can `clean` keys it is done with, and a `rollback` declares the keys it needs.
- Zero runtime dependencies. Live rendering on a TTY, plain line output in CI.

```ts
const result = await new Script<{ service: string }>({ name: "deploy" })
  .addPhase("Validation")
  .addStep({
    name: "resolve commit",
    handler: async ({ input, status }) => {
      status("querying git");
      return { sha: await git.head(input.service) };
    },
  })
  .addPhase("Release")
  .addStep({
    name: "upload artifact",
    handler: async ({ ctx, progress }) => {
        //          ^ ctx.sha is typed here
      const bar = progress({ total: 100, label: "uploading" });

      return { uploadId: await upload(ctx.sha, bar) };
    },
    rollbackKeys: ["sha"],
    rollback: async ({ ctx, output }) => cdn.delete(output.uploadId, ctx.sha),
    //                  ^ { sha: string }   ^ typed as { uploadId: string }
  })
  .run({ service: "api" });

if (result.ok) result.ctx.uploadId; // string
```

## The terminal

```
  ▌ deploy
  ▌ Build, upload and release a service

  ✔ Validation                                                             739ms
     ✔ resolve commit                                                      222ms
     ✔ check permissions                                                   517ms

  ⠸ Build                                                                   17.7s
     ✔ install dependencies (428 packages)                                  14.4s
     ⠸ compile bundle  › transform                                           3.3s
       ▕██████████████░░░░░░░░░░▏  58%  412/710  src/router.ts
       ✔ typecheck
       ⠸ transform
       ○ minify
       ○ write manifest

  ○ Release
     ○ upload artifact
     ○ shift traffic
```

On failure:

```
  ─────────────────────────────────────────────────────────────────────────────
  ✖ Failed at Release › shift traffic after 21.4s
    health check failed: 3/5 pods unhealthy
  ↺ Rolled back 2 steps
```

Run `npm run example` and `npm run example:fail` to see both live.

## Type flow

The context type parameter is inferred and never written by hand. Each `addStep`
whose handler returns an object widens it:

```ts
new Script<{ id: string }>()      // Ctx = {}
  .addStep({ handler: () => ({ token: "x" }) })      // Ctx = { token: string }
  .addStep({ handler: ({ ctx }) => ({ n: ctx.token.length }) })
                                  // Ctx = { token: string; n: number }
```

Reaching for a key a previous step did not produce is a compile error, as is
reading the wrong shape in a `rollback`. A handler that returns nothing leaves
the context unchanged.

## Cleaning the context

If a step produces — or receives — data that later steps do not need, listing
those keys in `clean` deletes them from the context at runtime **and** removes
them from the type that flows on:

```ts
new Script<{ password: string; email: string }>({ name: "signup" })
  .addStep({
    name: "read input",
    handler: ({ input }) => ({ ...input }),
  })
  .addStep({
    name: "hash",
    handler: async ({ ctx }) => ({ hash: await hashIt(ctx.password) }),
    clean: ["password"],   // not needed past this point
  })
  .addStep({
    name: "persist",
    handler: ({ ctx }) => {
      ctx.hash;      // string
      ctx.email;     // string
      ctx.password;  // compile error — cleaned away
    },
  });
```

Rules:

- Keys are checked against the context as it stands *entering* that step — an
  unknown key is a compile error, and the editor autocompletes the valid ones.
  A step cannot clean a key it produces itself; that key does not exist yet
  when `clean` is read.
- A key reserved by any step's `rollbackKeys` can never be cleaned, by that
  step or any later one. Trying to throws `StepDefinitionError` from `addStep`,
  while the script is being built, before anything runs.
- `clean` is part of the declared shape, not of the work, so it applies even
  when the step is skipped by `when` — runtime and types never disagree.
- A step's own `output` is kept separately and is never cleaned, so its
  `rollback` still sees everything the handler returned.

## Input from a schema

`In` doesn't have to be written by hand either. `defineInput` takes any
[Standard Schema](https://standardschema.dev)-compliant validator — Zod,
Valibot, ArkType, Effect Schema, or a hand-rolled one — infers `In` from its
output type, and validates whatever is passed to `run()` before any phase
executes, throwing `SchemaValidationError` on failure:

```ts
const deploy = new Script({ name: "deploy" })
  .defineInput(z.object({ service: z.string() }))
  .addStep({
    name: "resolve commit",
    handler: async ({ input }) => ({ sha: await git.head(input.service) }),
    //                     ^ input.service: string
  });
```

Call it first, right after construction — any `addStep`/`addPhase` added
before it still sees the previous `In`.

## Rollback semantics

When a step fails, every step that already **succeeded** is compensated in
reverse order. The step that failed is not compensated — it never completed.

| `rollback` option | behaviour |
| --- | --- |
| `"all"` (default) | unwind every completed step in the script |
| `"phase"` | unwind only the phase that failed |
| `"none"` | leave state as-is |

A rollback that throws is recorded in `result.rollbacks` and surfaced in the
summary; it never masks the original error, and the remaining rollbacks still
run.

### What a rollback can see

A rollback always gets its own step's `output` in full. It gets **no context at
all** by default — it has to ask, via `rollbackKeys`. Asking does two things: it
narrows `ctx` inside the rollback to exactly those keys, and it reserves them,
so neither that step nor any later one can `clean` them away. Whatever the
rollback declared is therefore guaranteed to still be there if it ever runs.

```ts
new Script<{ accountId: string; amount: number }>({ name: "charge" })
  .addStep({ name: "read input", handler: ({ input }) => ({ ...input }) })
  .addStep({
    name: "reserve funds",
    handler: async ({ ctx }) => ({ reservationId: await reserve(ctx.accountId, ctx.amount) }),
    rollbackKeys: ["accountId", "reservationId"],
    rollback: async ({ ctx }) => {
      // ctx is { accountId: string; reservationId: string } — and nothing else
      await release(ctx.accountId, ctx.reservationId);
    },
  })
  .addStep({
    name: "charge card",
    handler: () => {
      throw new Error("payment gateway timeout");
    },
  });
```

`rollbackKeys` accepts the step's incoming context keys and its own output keys;
anything else is a compile error. Cleaning a reserved key is a compile error
too, and throws `StepDefinitionError` at build time:

```ts
script
  .addStep({ name: "one", handler: () => {}, rollbackKeys: ["a"], rollback: async () => {} })
  .addStep({ name: "two", handler: () => {}, clean: ["a"] });
  //                                          ^ StepDefinitionError: reserved by rollbackKeys
```

## The handler surface

Every handler receives one object:

| | |
| --- | --- |
| `input` | the value passed to `run()` |
| `ctx` | everything earlier steps produced, fully typed |
| `signal` | aborts on timeout, Ctrl-C, or an external signal |
| `attempt` | 1-based, useful with `retry` |
| `log` / `info` / `warn` / `error` / `success` | a line, placed per `logPlacement` (default: permanent, above the live frame) |
| `status(text)` | transient one-liner beside the step, cleared when it settles |
| `note(text)` | annotates the step title — `(400 rows found)` — and stays |
| `progress({ total, label })` | a progress bar → `update` / `increment` / `setTotal` / `done` |
| `task(label)` | one nested checklist item → `succeed` / `fail` / `skip` |
| `tasks([...] as const)` | a whole checklist, keyed for typed lookup |

`rollback` receives `input`, `signal`, `phase`, `step`, `log`, `status`, `note`
and `progress`, plus `output` (that step's own return value) and `error` (what
triggered the unwind). Its `ctx` holds only the keys named in `rollbackKeys`.

### `status` vs `note`

Both write next to the step name, and they differ in lifetime. `status` is
scratch space for a step in flight — it is wiped the moment the step settles.
`note` is part of the title: it is written once and stays on the finished line,
which is where a count, a size, or an id belongs.

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

Calling `note` again replaces the text; `note("")` removes it. Both renderers
show it — the live frame in the title, the CI renderer on the step's line.

## Log placement

By default, `log`/`info`/`warn`/`error`/`success` write a permanent line above
the whole frame — the complete record for the run, in order. `logPlacement`
moves them somewhere more local instead:

```ts
new Script({ name: "checkout", logPlacement: "step" })
```

| `logPlacement` | where it lands |
| --- | --- |
| `"scrollback"` (default) | a permanent line above the frame — the full run, in order |
| `"step"` | nested under the step that logged it, beside its tasks and progress bar |
| `"bottom"` | a rolling tail of the most recent lines, below the whole phase tree |

```
  ✖ Main                                                                  320ms
     ✔ reserve inventory                                                  320ms
       • checked warehouse A          ← "step": nested where it happened
       • checked warehouse B
     ✖ boom                                                                 0ms
       boom
```

`"step"` and `"bottom"` both keep only the most recent few lines — they trade
completeness for locality, which is exactly what makes a rollback's `log()`
land next to the step it is undoing instead of scrolling past at the top.
Reach for `"scrollback"` when the log is the thing you need to still have once
the run is over. Only the live renderer honours this: the plain/CI renderer is
already sequential, so every placement just prints each line immediately, in
order, which is already both complete and in place.

Run `npm run example:log-placement` to see the same script three times, once
per placement.

## Step options

```ts
.addStep({
  name: "publish",
  description: "push the tag",
  when: ({ input, ctx }) => input.env === "production",
  retry: { attempts: 3, delayMs: (attempt) => attempt * 250, retryIf: isTransient },
  timeoutMs: 30_000,
  clean: ["draftId"],          // drop from the context once this step settles
  rollbackKeys: ["tagName"],   // the context keys `rollback` needs, and reserves
  handler,
  rollback,
})
```

`when` returning false marks the step **skipped** — its rollback never runs.
Phases accept `when` too, which skips all their steps.

## Caching

A phase or a step can reuse what it produced on an earlier run. Point it at a
store and it stops repeating work:

```ts
import { Script, fileStore } from "@michaelrwalker/stagehand";

const cache = fileStore("./.stagehand-cache.json");

new Script<Input>({ name: "deploy" })
  .addPhase("Build", { cache })
  .addStep({ name: "install", handler: … })
  .addStep({ name: "compile", handler: … })

  .addPhase("Release")
  .addStep({ name: "warm CDN", cache, handler: … })
```

On a hit the work is skipped and the stored value is merged into the context —
downstream steps see the same keys, at the same types, either way.

**What gets stored.** A phase stores its **delta**: the keys its steps
contributed, minus anything they `clean`ed. Keys from earlier phases are never
part of it, so a hit can't overwrite a value this run just computed. A step
stores exactly what its handler returned.

**There is no key.** The store is the identity. Say when an entry stops being
good with `stale`, or delete the file:

```ts
.addPhase("Build", {
  cache: {
    store: cache,
    stale: ({ value, ctx, ageMs }) => ageMs > 3_600_000 || value.sha !== ctx.sha,
    schema: BuildSchema,   // optional; a value that no longer fits is a miss
  },
})
```

`stale` and `schema` both see the context as it stands when the phase is
reached, so `ctx` is typed with no annotation. `value` arrives as `unknown` —
annotate the parameter, or hand over a `schema` and let it narrow. A stored
value that fails its schema is treated as a **miss**, not an error, which is
what stops a cache written by an older version of the script from feeding the
wrong shape into the context.

**Rollback.** Cached work never ran, so its `rollback` can't fire during a
later unwind — the side effect belongs to the run that wrote the entry and was
never undone. For the same reason a failure downstream leaves entries alone.

**Per run**, without touching the script:

```ts
await deploy.run(input, { cache: argv.includes("--no-cache") ? "off" : "on" });
```

`"on"` (default) reads and writes · `"off"` ignores caching entirely ·
`"refresh"` runs everything and overwrites · `"read-only"` uses hits but never
writes.

**Stores** are three methods, so Redis or S3 is a dozen lines:

```ts
interface CacheStore {
  read(slot: string): Awaitable<CachedEntry | undefined>;
  write(slot: string, entry: CachedEntry): Awaitable<void>;
  clear(slot: string): Awaitable<void>;
}
```

`slot` is derived from the phase or step name so several phases can share one
store; scripts never write it. `fileStore(path)` keeps every slot in one JSON
file — a missing, unreadable or corrupt file all read as no cache at all, so
deleting it is always a valid reset. `memoryStore()` lasts for the process.

A store that throws — unreadable file, full disk, a `stale` predicate with a bug
— logs a warning and does the work. Caching never decides whether a run passes.

## Script options

```ts
new Script<Input>({
  name: "deploy",
  description: "Build, upload and release a service",
  rollback: "all",       // "all" | "phase" | "none"
  throwOnError: false,   // true to throw instead of returning ok: false
  plain: undefined,      // force the CI renderer; default auto-detects a TTY
  silent: false,
  handleSignals: true,   // Ctrl-C aborts and compensates; a second one gives up
  logPlacement: "scrollback", // "scrollback" | "step" | "bottom"
})
```

## Result

```ts
type RunResult<Ctx> =
  | { ok: true;  status: "success"; ctx: Ctx; durationMs: number; steps: StepReport[] }
  | { ok: false; status: "failed" | "aborted"; error: unknown;
      failedAt: { phase: string; step: string } | null;
      ctx: Partial<Ctx>;            // what did get produced
      durationMs: number; steps: StepReport[]; rollbacks: RollbackReport[] }
```

## Splitting steps across files

`stepFor` binds the input and context a step expects while keeping inference:

```ts
export const verifyId = stepFor<Input, { user: User }>()({
  name: "verify id",
  handler: async ({ ctx }) => ({ verified: ctx.user.id }),
  rollbackKeys: ["verified"],
  rollback: async ({ ctx }) => unverify(ctx.verified),
});
```

`rollbackKeys` narrows the rollback here exactly as it does inline, and the keys
stay reserved once the step is handed to `addStep`.

`addStep` is where the requirement is enforced: TypeScript checks that the
script has actually produced `Ctx` by that point. Dropping a step that needs
`{ user: User }` into a script that has not loaded a user yet is a compile
error, not a runtime `undefined`.

## Examples

Eight runnable scripts, each aimed at a different part of the API. Most take a
flag to switch between the happy path and the interesting one.

| | |
| --- | --- |
| [`deploy.ts`](examples/deploy.ts) | The tour: phases, progress bars, checklists, retry, `note`, `clean`, rollback. `npm run example`, `npm run example:fail` |
| [`checkout.ts`](examples/checkout.ts) | Saga semantics end to end — three mutations, three compensations, a secret dropped with `clean`, and `logPlacement: "step"` nesting each rollback's log under the step it undoes. `-- --ok` for the happy path |
| [`resilience.ts`](examples/resilience.ts) | `retry` with backoff, `retryIf` refusing to retry a 401, `timeoutMs` on a hung step, and an external `AbortSignal`. `-- --timeout`, `-- --fatal`, `-- --cancel` |
| [`intake.ts`](examples/intake.ts) | `defineInput` with a hand-rolled Standard Schema, plus the full handler UI surface. `-- --bad` to watch validation reject the run, `-- --dirty` for a failing checklist item |
| [`modular.ts`](examples/modular.ts) | `stepFor` steps living in [`steps/tenancy.ts`](examples/steps/tenancy.ts), shared by two unrelated scripts — the imported rollback compensates in both. `-- --fail` |
| [`log-placement.ts`](examples/log-placement.ts) | The same script run three times, once per `logPlacement` value, so the difference is visible directly |
| [`cache.ts`](examples/cache.ts) | A cached `Build` phase and a cached step. Run it twice to watch the second run skip both. `-- --fresh` to rebuild and overwrite |
| [`validate.ts`](examples/validate.ts) | The smallest thing that runs: two steps, `rollback: "none"` |

```
npm run example:checkout -- --ok
npm run example:resilience -- --cancel
npm run example:intake -- --bad
npm run example:modular -- --fail
npm run example:log-placement
```

## npm scripts

```
npm run build       # emit dist/
npm test            # node:test suite
npm run typecheck   # library + examples + tests
npm run example     # the happy path, live
npm run example:fail
npm run release     # release-it: version, tag, publish
```

## TypeScript layout

One config per directory, because editors resolve a file's config by finding
the nearest `tsconfig.json` — a non-standard filename like `tsconfig.foo.json`
is invisible to them, so the IDE and the CLI disagree.

| Config | Covers | Why it differs |
| --- | --- | --- |
| `tsconfig.json` | `src` | The library. `noEmit`, strict. |
| `tsconfig.build.json` | `src` | The only config that emits `dist/`. |
| `examples/tsconfig.json` | `examples` | Imports the built `dist/`; adds `allowImportingTsExtensions`. |
| `test/tsconfig.json` | `test` | Same, without the flag. |

Only `examples/` needs that flag, and only because `modular.ts` imports a
sibling: Node's type stripping does not rewrite import extensions, so the
import has to say `./steps/tenancy.ts` rather than `./steps/tenancy.js`. The
flag cannot go in the root config — `tsconfig.build.json` extends it and sets
`noEmit: false`, and TypeScript rejects `allowImportingTsExtensions` unless
`noEmit` or `emitDeclarationOnly` is set (TS5096).

## Rendering notes

The live renderer repaints an in-place region and writes logs permanently above
it. It falls back to line-per-event output when stdout is not a TTY, when
`NO_COLOR` is set, or when `TERM=dumb` — so CI logs stay greppable.

**The frame is always made to fit the viewport**, and this is load-bearing
rather than cosmetic. Repainting works by moving the cursor up N lines, so a
frame taller than the terminal scrolls its own anchor off screen and each
repaint appends a copy instead of overwriting. `renderBody` applies four
progressively stronger reductions until the frame fits:

1. everything, in full;
2. finished phases collapse to a one-line summary;
3. only the running phase keeps its steps, and drops detail lines;
4. the running phase's steps are windowed around the one executing.

The executing step is never windowed out, and long lines are truncated rather
than wrapped. A terminal resize invalidates the recorded geometry, so the
renderer abandons the old region and redraws below it. The closing frame is
exempt — nothing repaints after it, so it keeps every step.
