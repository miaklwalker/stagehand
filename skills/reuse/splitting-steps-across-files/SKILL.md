---
name: 'splitting-steps-across-files'
description: >
  stepFor<In, Ctx>() binds the input and context a step declared outside any script expects, so the step can be exported from its own module and passed to addStep; WithStepFor<Step, Rest> computes a chain's Ctx from an earlier step's output instead of restating it by hand. Load this for "move a step into its own module," "share a step across two scripts," or "build a reusable steps file for a recurring workflow."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.5.3'
sources:
  - 'miaklwalker/stagehand:docs/guides/splitting-steps.md'
  - 'miaklwalker/stagehand:src/script.ts'
  - 'miaklwalker/stagehand:test/with-step-for.test.ts'
---

# Stagehand — Splitting Steps Across Files

A step defined inline with `addStep` infers its `In` and `Ctx` from the script it's attached to. A step declared in its own module has no script to infer from, so `stepFor<In, Ctx>()` supplies that binding explicitly while keeping full inference on the handler's return type.

## Setup

```ts
// steps/tenancy.ts
import { stepFor } from "@michaelrwalker/stagehand";

interface Input {
  accountId: string;
}

export const loadAccount = stepFor<Input>()({
  name: "load account",
  handler: async ({ input }) => ({ account: await fetchAccount(input.accountId) }),
});

export const createTenant = stepFor<Input, { account: Account }>()({
  name: "create tenant",
  handler: async ({ ctx }) => ({ tenantId: await api.create(ctx.account) }),
  rollbackKeys: ["tenantId"],
  rollback: async ({ ctx }) => api.destroy(ctx.tenantId),
});
```

```ts
// scripts/signup.ts
import { Script } from "@michaelrwalker/stagehand";
import { loadAccount, createTenant } from "../steps/tenancy.js";

const signup = new Script<{ accountId: string }>({ name: "signup" })
  .addPhase("Account")
  .addStep(loadAccount)
  .addPhase("Provision")
  .addStep(createTenant);
```

## Core Patterns

### Chaining `stepFor` steps with `WithStepFor` instead of restating `Ctx`

```ts
import { stepFor, type WithStepFor } from "@michaelrwalker/stagehand";

interface Input {
  channel: string;
}

export const logIntoDb = stepFor<Input>()({
  name: "log into db",
  handler: async () => ({ conn: await connect() }),
});

export const loadRules = stepFor<
  Input,
  WithStepFor<typeof logIntoDb, { conditions: Array<{ name: string }> }>
>()({
  name: "load rules",
  // ctx.conn comes from logIntoDb's output, ctx.conditions from Rest
  handler: ({ ctx }) => ({ rules: ctx.conn.query(ctx.conditions) }),
});
```

`WithStepFor<Step, Rest>` merges `Step`'s output over `Rest` (which defaults to `{}`), so the second step's `Ctx` doesn't have to be hand-typed against the first step's return shape.

### Nesting `WithStepFor` for a chain three or more steps deep

```ts
type Ctx = WithStepFor<typeof third, WithStepFor<typeof second, WithStepFor<typeof first, { seed: boolean }>>>;
```

Read inside out: start with `{ seed: boolean }`, add what `first` returns, then `second`, then `third` — the same order the steps actually run in, and on a name collision the outermost (`third`) wins, matching how a later step's return shadows an earlier key at runtime.

### A shared step library reused across two unrelated scripts

```ts
// steps/crm.ts — written once, small and generic
import { stepFor } from "@michaelrwalker/stagehand";

export const fetchContacts = stepFor<{ emails: string[] }>()({
  name: "fetch contacts",
  handler: async ({ input }) => ({ contacts: await crm.fetch(input.emails) }),
});

export const dedupeContacts = stepFor<{ emails: string[] }, { contacts: Contact[] }>()({
  name: "dedupe contacts",
  handler: ({ ctx }) => ({ contacts: dedupe(ctx.contacts) }),
});
```

```ts
// scripts/sync-a.ts
import { Script } from "@michaelrwalker/stagehand";
import { fetchContacts, dedupeContacts } from "../steps/crm.js";

new Script<{ emails: string[] }>({ name: "sync-a" })
  .addPhase("Contacts")
  .addStep(fetchContacts)
  .addStep(dedupeContacts);
```

```ts
// scripts/sync-b.ts — same steps, same import, no logic re-typed
import { Script } from "@michaelrwalker/stagehand";
import { fetchContacts, dedupeContacts } from "../steps/crm.js";

new Script<{ emails: string[]; region: string }>({ name: "sync-b" })
  .addPhase("Contacts")
  .addStep(fetchContacts)
  .addStep(dedupeContacts)
  .addPhase("Region")
  .addStep({
    name: "tag region",
    handler: async ({ input, ctx }) => ({ tagged: ctx.contacts.map((c) => ({ ...c, region: input.region })) }),
  });
```

Each script mixes shared and inline steps freely; `addStep` checks each shared step's `Ctx` requirement against whatever the host script has produced so far, at the mount site.

### Reusing a step with a rollback across two scripts

```ts
// Script one: normal signup
new Script<{ accountId: string }>({ name: "signup" })
  .addPhase("Account")
  .addStep(loadAccount)
  .addPhase("Provision")
  .addStep(createTenant); // rollback compensates here if a later step fails

// Script two: written later, reusing the same step and its rollback
new Script<{ accountId: string; fromRegion: string }>({ name: "migrate" })
  .addPhase("Prepare")
  .addStep(loadAccount)
  .addPhase("Provision")
  .addStep(createTenant); // same import, same compensation logic
```

`createTenant`'s rollback is identical wherever it's mounted because it's the exact same function reference each time.

## Common Mistakes

### HIGH Nesting WithStepFor in the reverse of execution order

Wrong:
```ts
// "second" actually runs after "first" in the real script, but is nested as if it ran before it
type Ctx = WithStepFor<typeof first, WithStepFor<typeof second, { conditions: string[] }>>;
```

Correct:
```ts
// nest in the order the steps actually run — innermost first
type Ctx = WithStepFor<typeof second, WithStepFor<typeof first, { conditions: string[] }>>;
```

On a name collision the outermost `WithStepFor` wins, matching how a later step's return value shadows an earlier key at runtime — but nothing checks that the nesting order matches the order the steps are actually added to a script, so a reversed nest silently produces a `Ctx` type that disagrees with what the script really does at runtime.

Source: docs/guides/splitting-steps.md ("nothing checks that the steps are added to a script in the order the nesting implies")

### LOW Assuming a reused stepFor step gets independent state per script

Wrong:
```ts
// steps/tenancy.ts
let callCount = 0;
export const createTenant = stepFor<Input, { account: Account }>()({
  name: "create tenant",
  handler: async () => { callCount++; return { tenantId: await api.create() }; },
});
// callCount keeps incrementing across every script that imports createTenant
```

Correct:
```ts
// keep per-run state inside ctx/output, not module-level closures, unless sharing is intended
export const createTenant = stepFor<Input, { account: Account }>()({
  name: "create tenant",
  handler: async ({ attempt }) => ({ tenantId: await api.create(), attempt }),
});
```

A step imported into two scripts is the exact same function/object reference in both, so any module-scoped mutable state its handler closes over is shared across every script that mounts it, not reset per mount.

Source: docs/guides/splitting-steps.md ("Reusing one step in two scripts" — same function reference each time)

### MEDIUM Writing a bespoke inline step instead of extracting a shared one

Wrong:
```ts
// scripts/sync-a.ts
.addStep({ name: "fetch contacts", handler: async ({ input }) => ({ contacts: await crm.fetch(input.emails) }) })

// scripts/sync-b.ts — same logic, retyped, now two places to fix a bug
.addStep({ name: "fetch contacts", handler: async ({ input }) => ({ contacts: await crm.fetchContacts(input.emails) }) })
```

Correct:
```ts
// steps/crm.ts — written once, with a small, generic input
export const fetchContacts = stepFor<{ emails: string[] }>()({
  name: "fetch contacts",
  handler: async ({ input }) => ({ contacts: await crm.fetch(input.emails) }),
});
// any script that needs it:
.addStep(fetchContacts)
```

For a workflow that recurs across scripts, a step written once with a small, generic input composes into every future script at zero type-safety cost (`addStep` still checks it against whatever mounts it), while a fresh inline closure per script forfeits that — the same logic, and any bug in it, has to be rewritten and re-verified in every script separately.

Source: maintainer interview ("keep a file of common steps, with simple inputs so you can easily compose scripts... this will save developers a ton of time and costs nothing as far as type safety is concerned")
