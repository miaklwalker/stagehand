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
     ✔ install dependencies                                                 14.4s
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
| `log` / `info` / `warn` / `error` / `success` | permanent lines above the live frame |
| `status(text)` | transient one-liner beside the step |
| `progress({ total, label })` | a progress bar → `update` / `increment` / `setTotal` / `done` |
| `task(label)` | one nested checklist item → `succeed` / `fail` / `skip` |
| `tasks([...] as const)` | a whole checklist, keyed for typed lookup |

`rollback` receives `input`, `signal`, `phase`, `step`, `log`, `status` and
`progress`, plus `output` (that step's own return value) and `error` (what
triggered the unwind). Its `ctx` holds only the keys named in `rollbackKeys`.

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

## Scripts

```
npm run build       # emit dist/
npm test            # node:test suite
npm run typecheck   # library + examples + tests + scripts
npm run example     # the happy path, live
npm run example:fail
npm run release     # dry run of the publish pipeline
```

## TypeScript layout

One config per directory, because editors resolve a file's config by finding
the nearest `tsconfig.json` — a non-standard filename like `tsconfig.foo.json`
is invisible to them, so the IDE and the CLI disagree.

| Config | Covers | Why it differs |
| --- | --- | --- |
| `tsconfig.json` | `src` | The library. `noEmit`, strict. |
| `tsconfig.build.json` | `src` | The only config that emits `dist/`. |
| `examples/tsconfig.json` | `examples` | Imports the built `dist/`. |
| `test/tsconfig.json` | `test` | Same. |
| `scripts/tsconfig.json` | `scripts` | Adds `allowImportingTsExtensions`. |

Only `scripts/` needs that last flag. Node's type stripping does not rewrite
import extensions, so a script importing a sibling script must write
`./exec.ts` rather than `./exec.js`. The flag cannot go in the root config:
`tsconfig.build.json` extends it and sets `noEmit: false`, and TypeScript
rejects `allowImportingTsExtensions` unless `noEmit` or `emitDeclarationOnly`
is set (TS5096).

## The release pipeline

`scripts/release.ts` builds and publishes this package, and is itself written
with this framework — the pipeline is the integration test.

```
npm run release                              # dry run; mutates nothing
npm run release -- --simulate-failure        # rehearse the rollback path
npm run release -- --publish                 # for real
npm run release -- --publish --bump minor
npm run release -- --publish --version 1.0.0 --tag next
```

| Phase | Steps |
| --- | --- |
| Preflight | read manifest · authenticate npm · inspect git · resolve version · check registry |
| Verify | typecheck · run tests |
| Package | write version · clean dist · build · verify artifacts · audit tarball |
| Publish | tag release · push tag · publish to npm |

Three steps compensate, and the ordering is deliberate — `publish to npm` is
last, so a failure anywhere *before* it unwinds everything and nothing reaches
the registry:

| Step | Rollback |
| --- | --- |
| `write version` | restore the previous version in package.json |
| `clean dist` | rebuild from source |
| `tag release` | delete the local tag |
| `push tag` | delete the remote tag |
| `publish to npm` | `npm deprecate` — a published version cannot be recalled |

`--simulate-failure` performs the local mutations and then fails at the publish
step. Nothing leaves the machine, and you get to watch the unwind:

```
  ✖ publish to npm  0ms  simulated publish failure (--simulate-failure)
    ▲ deleted local tag v0.2.0
    ▲ dist rebuilt from source
    ▲ package.json version restored to 0.1.0

  ✖ Failed at Publish › publish to npm after 8.1s
  ↺ Rolled back 3 steps
```

Other things it checks: a scoped package without `publishConfig.access`
(`"public"`) would be published as restricted, so preflight refuses; the tarball
is audited path-by-path against an allowlist so `src/` can never leak; and the
version is checked against the registry before any work is done.

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
