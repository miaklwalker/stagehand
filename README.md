# stagehand

A fully typesafe, saga-style script framework for TypeScript, with a live terminal UI.

- **Scripts** are a collection of **phases**.
- **Phases** are a collection of **steps**.
- **Steps** have a `handler` and an optional `rollback` that fires when a *later* step fails.
- Whatever a handler returns is merged into a **typed context** that every later step can read.
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
      const bar = progress({ total: 100, label: "uploading" });
      //          ^ ctx.sha is typed here
      return { uploadId: await upload(ctx.sha, bar) };
    },
    rollback: async ({ output }) => cdn.delete(output.uploadId),
    //                  ^ typed as { uploadId: string }
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

`rollback` receives the same, plus `output` (that step's own return value) and
`error` (what triggered the unwind).

## Step options

```ts
.addStep({
  name: "publish",
  description: "push the tag",
  when: ({ input, ctx }) => input.env === "production",
  retry: { attempts: 3, delayMs: (attempt) => attempt * 250, retryIf: isTransient },
  timeoutMs: 30_000,
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
});
```

## Scripts

```
npm run build       # emit dist/
npm test            # node:test suite
npm run typecheck   # library + examples + tests + scripts
npm run example     # the happy path, live
npm run example:fail
npm run release     # dry run of the publish pipeline
```

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
`NO_COLOR` is set, or when `TERM=dumb` — so CI logs stay greppable. Completed
phases collapse to a single line if the frame would outgrow the terminal.
