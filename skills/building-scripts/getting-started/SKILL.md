---
name: 'getting-started'
description: >
  Build a complete Stagehand script end to end — Script constructor, addPhase/addStep, a handler
  that widens the typed context, a rollback, and reading the RunResult. Load this first for any
  "write my first script" or "turn this async function chain into Stagehand" request.
metadata:
  type: 'lifecycle'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:README.md'
  - 'miaklwalker/stagehand:docs/quick-start.md'
  - 'miaklwalker/stagehand:docs/guides/script-options-and-result.md'
  - 'miaklwalker/stagehand:docs/guides/cleaning-context.md'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:src/types.ts'
---

# Stagehand — Getting Started

A script is a `Script<Input>` built by chaining `addPhase`/`addStep`. Each step's handler reads
`input` and the typed `ctx` accumulated so far, and whatever it returns is merged into `ctx` for
every later step. `run()` never throws by default — it resolves to a discriminated `RunResult`.

## Setup

```ts
import { Script } from "@michaelrwalker/stagehand";

interface Input {
  service: string;
}

const deploy = new Script<Input>({ name: "deploy" })
  .addPhase("Validation")
  .addStep({
    name: "resolve commit",
    handler: async ({ input, status }) => {
      status("querying git");
      return { sha: await resolveSha(input.service) };
    },
  })
  .addPhase("Release")
  .addStep({
    name: "upload artifact",
    handler: async ({ ctx }) => {
      // ctx.sha is typed here — produced by the previous step
      return { uploadId: await upload(ctx.sha) };
    },
    rollbackKeys: ["sha"],
    rollback: async ({ ctx, output }) => {
      await cdn.delete(output.uploadId, ctx.sha);
    },
  });

const result = await deploy.run({ service: "api" });

if (result.ok) {
  console.log(`released ${result.ctx.uploadId} from ${result.ctx.sha}`);
} else {
  console.error(`failed at ${result.failedAt?.phase} › ${result.failedAt?.step}`);
  console.error(result.error);
  process.exitCode = 1;
}
```

## Core Patterns

### Grouping steps into phases

```ts
new Script<{ id: string }>({ name: "provision" })
  .addPhase("Fetch")
  .addStep({
    name: "load user",
    handler: async ({ input }) => ({ user: await db.user(input.id) }),
  })
  .addPhase("Provision")
  .addStep({
    name: "create tenant",
    handler: async ({ ctx }) => ({ tenantId: await api.create(ctx.user.org) }),
  });
```

`addPhase` opens a new phase; every `addStep` that follows lands in it until the next `addPhase`.

### Context accumulates purely from what a handler returns

```ts
new Script<{ id: string }>()
  .addStep({ handler: () => ({ token: "x" }) }) // Ctx = { token: string }
  .addStep({ handler: ({ ctx }) => ({ n: ctx.token.length }) });
// Ctx = { token: string; n: number }
```

No generic is written by hand — each handler's return value widens `Ctx` for every step after it,
and a handler that returns nothing leaves it unchanged.

### Compensating a mutation with rollback and rollbackKeys

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

Only steps that already succeeded get compensated, in reverse order, when a later step throws;
`rollbackKeys` narrows what the rollback's `ctx` contains to exactly those keys.

### Naming a script with the bare-string shorthand

```ts
const validate = new Script("validate") // shorthand for { name: "validate" }
  .addStep({ name: "check input", handler: ({ input }) => ({ ok: true }) });
```

Reach for the object form (`{ name, description, rollback, throwOnError, ... }`) once you need
anything beyond the name.

## Common Mistakes

### CRITICAL Wrapping run() in try/catch expecting it to throw

Wrong:
```ts
try {
  const result = await deploy.run(input);
  console.log("deployed", result.ctx.releaseId);
} catch (e) {
  console.error(e);
}
```

Correct:
```ts
const result = await deploy.run(input);
if (!result.ok) {
  console.error(result.error);
  process.exitCode = 1;
  return;
}
console.log("deployed", result.ctx.releaseId);
```

`run()` resolves to `{ ok: false, ... }` by default; nothing throws unless `throwOnError` is set, so the try/catch never fires and a failed run is silently treated as if it succeeded.

Source: docs/guides/script-options-and-result.md; src/script.ts run()

### MEDIUM Mutating ctx directly instead of returning new keys

Wrong:
```ts
handler: ({ ctx }) => {
  ctx.total = ctx.total + 1; // "works" locally, breaks caching/rollback
};
```

Correct:
```ts
handler: ({ ctx }) => ({ total: ctx.total + 1 });
```

`ctx` is the same live object every handler shares, but only a handler's *return value* is folded into a cached phase's delta and into a rollback's `rollbackKeys` pick, so a directly-mutated key never gets cached and is invisible to any rollback that asks for it.

Source: src/script.ts (const ctx = {} as Ctx & Record<string, unknown>; merge() only applied to handler output); docs/guides/cleaning-context.md

### HIGH Returning a bare value from a handler instead of an object

Wrong:
```ts
handler: () => {
  const value = "me";
  return value; // compile error — Out must be object | void
};
```

Correct:
```ts
handler: () => {
  const value = "me";
  return { name: value };
};
```

A handler must resolve to `object | void` because whatever it returns is merged into `ctx` by key; TypeScript rejects a bare return at compile time (`Out extends object | void`), but reaching for `return value` out of habit still costs an extra iteration.

Source: src/types.ts StepDef.handler / src/script.ts addStep<Out extends object | void>(...)

### HIGH Tension: Simple first draft vs. rollbackKeys reservation permanence

The simplest script has no `rollbackKeys` and no `clean` conflicts, but adding a rollback later to harden a working script permanently reserves whatever keys it names via `rollbackKeys`. Agents optimizing for this skill's goal tend to bolt a rollback onto a working script without revisiting existing `clean` calls elsewhere because they don't account for cleaning-context's key-reservation rule, which then throws `StepDefinitionError` at build time and reads as an unrelated regression.

See also: skills/compensation-safety/adding-rollbacks/SKILL.md, skills/compensation-safety/cleaning-context/SKILL.md § Common Mistakes

See also: skills/errors-results/handling-results-and-errors/SKILL.md — the very first script already needs correct RunResult handling; run() resolving instead of throwing is the single most consequential thing to get right early.
