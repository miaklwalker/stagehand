---
title: "Overview"
description: "Stagehand is a fully typesafe, saga-style script framework for TypeScript, with a live terminal UI."
---

Most scripts that touch several systems — reserve inventory, charge a card, ship an
order — have no transaction to wrap them in. If the third step fails, the first two
already happened, and somebody has to undo them. Stagehand is built around that
problem directly: a script is a sequence of steps, each with an optional
compensation that runs if a *later* step fails. That is the saga pattern, and it is
the whole design center of the library.

## The core model

- **Scripts** are a collection of **phases**.
- **Phases** are a collection of **steps**.
- **Steps** have a `handler` and an optional `rollback` that fires when a later
  step fails.
- Whatever a handler returns is merged into a **typed context** that every later
  step can read.
- A step can `clean` keys it is done with, and a `rollback` declares the keys it
  needs.

```ts
import { Script } from "@michaelrwalker/stagehand";

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

## Why phases, not just steps

A flat list of steps would be enough to run things in order, but two decisions in
Stagehand depend on knowing where a step sits relative to others: how far a
rollback unwinds, and what a cache entry covers. `rollback: "phase"` unwinds only
the phase that failed rather than the whole script. A cached phase stores exactly
the keys its steps contributed: its *delta*. A hit for one phase never
overwrites what an earlier phase already computed this run. Phases are the unit
both of those operate on, which is why they exist as a distinct layer between the
script and its steps rather than being folded into step options.

## Why the context is typed, not just passed around

Every handler returns an object (or nothing), and that object is merged into a
context type that every later step's `ctx` parameter carries. There is no `Ctx`
generic to write by hand: each `addStep` call widens it, using the return type
TypeScript already inferred for that handler. The payoff shows up when a script
grows: reaching for a key nothing produced yet, or a key a `clean` already dropped,
is a compile error pointing at the exact step, not an `undefined` surfacing three
functions away at runtime.

## Why rollbacks ask for keys instead of seeing everything

A `rollback` gets its own step's `output` in full, but **no context at all** by
default: it has to name the keys it needs, through `rollbackKeys`. That is a
deliberate asymmetry. A compensation is written once and then, ideally, never
touched again except when it actually needs to run, which is exactly when the
run has already gone wrong. Declaring the keys up front means TypeScript checks,
at the moment the step is defined, that everything the rollback reads is actually
in scope. It also reserves those keys so no `clean`, in that step or a later one,
can delete them before the rollback might need them. The alternative, handing a
rollback the live context and hoping nothing it reads was cleaned away, fails
silently and only in the one code path that is hardest to exercise in tests.

## What it does not do

Stagehand has zero runtime dependencies and does not talk to any particular
infrastructure — no queue, no database, no cloud SDK. `handler` and `rollback` are
just async functions you write; the library's job is sequencing them, tracking the
context, rendering progress, and running compensations in the right order. Caching
is opt-in and pluggable: a store is three methods, so anything from a JSON file
to Redis works the same way.

## The terminal

On a TTY, a script renders as a live, in-place frame:

```text
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

On failure, the frame closes with a summary and the unwind:

```text
  ─────────────────────────────────────────────────────────────────────────────
  ✖ Failed at Release › shift traffic after 21.4s
    health check failed: 3/5 pods unhealthy
  ↺ Rolled back 2 steps
```

Off a TTY, in CI, piped to a file, or with `NO_COLOR` set, the same run emits
plain, sequential lines instead, so logs stay greppable. See
[Terminal Rendering](guides/terminal-rendering) for how that decision is made and
what changes.

## Requirements

Stagehand requires Node >= 20 and has zero runtime dependencies beyond the
[Standard Schema](https://standardschema.dev) type contract used by `defineInput`
(a types-only import, with no package it pulls in at runtime).
