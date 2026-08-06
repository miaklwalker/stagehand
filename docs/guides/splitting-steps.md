---
title: "Splitting Steps Across Files"
description: "stepFor binds the input and context a step expects while keeping full type inference, for steps declared away from any one script."
---

A step defined inline with `addStep` infers its `In` and `Ctx` from the script
it is attached to. A step declared in its own module has no script to infer
from — `stepFor` supplies that binding explicitly, while keeping the same
inference on the handler's return type:

```ts
// steps/verify.ts
import { stepFor } from "@michaelrwalker/stagehand";

export const verifyId = stepFor<Input, { user: User }>()({
  name: "verify id",
  handler: async ({ ctx }) => ({ verified: ctx.user.id }),
  rollbackKeys: ["verified"],
  rollback: async ({ ctx }) => unverify(ctx.verified),
});
```

The two type parameters on `stepFor<In, Ctx>()` are the *minimum* the step
needs — the input it reads (`In`) and the context it expects to already exist
(`Ctx`). Both default to the smallest useful shape (`In` has no default and must
be supplied if the handler reads `input`; `Ctx` defaults to `{}`) so a step that
only needs input, not context, can omit the second parameter entirely:

```ts
export const loadAccount = stepFor<{ accountId: string }>()({
  name: "load account",
  handler: async ({ input }) => ({ account: await fetchAccount(input.accountId) }),
});
```

`rollbackKeys` works exactly as it does inline (see
[Rollbacks](../guides/rollbacks)), and the keys it names stay reserved once the
step is handed to `addStep`, in whichever script that turns out to be.

## Declaring `Ctx` from an earlier step

Writing the second `stepFor` in a chain means restating what the first one
returns, by hand, as its `Ctx`. `WithStepFor<Step, Rest>` computes it instead:
the step's output merged over whatever else the context already holds:

```ts
import { stepFor, type WithStepFor } from "@michaelrwalker/stagehand";

export const logIntoDb = stepFor<Input>()({
  name: "log into db",
  handler: async () => ({ conn: await connect() }),
});

export const loadRules = stepFor<
  Input,
  WithStepFor<typeof logIntoDb, { conditions: Array<{ name: string }> }>
>()({
  name: "load rules",
  // ctx.conn comes from the step, ctx.conditions from the rest
  handler: ({ ctx }) => ({ rules: ctx.conn.query(ctx.conditions) }),
});
```

`Rest` defaults to `{}`, so `WithStepFor<typeof logIntoDb>` is just that step's
output. It nests, which is how a longer chain composes:

```ts
WithStepFor<typeof second, WithStepFor<typeof first, { conditions: string[] }>>
```

Read that inside out: start with `conditions`, add what `first` returns, then
what `second` returns. That is also the precedence: on a name collision the
outermost wins, the same way a later step's return value shadows an earlier key
at runtime. Nest in the order the steps actually run and the two agree.

Two things it deliberately does not do. It reads only the step's *output*, not
the step's own `Ctx` requirement, since the two are declared independently;
`addStep` remains the place where a step meeting an insufficient context is
caught. And it is a convenience for *declaring* a type, not a second source of
truth: nothing checks that the steps are added to a script in the order the
nesting implies.

A step that returns nothing leaves `Rest` untouched, and an `async` handler is
awaited first, so neither needs special handling.

## Using it

```ts
import { Script } from "@michaelrwalker/stagehand";
import { loadAccount, createTenant, seedDefaults } from "./steps/tenancy.ts";

const signup = new Script<{ accountId: string; sendEmail: boolean }>({ name: "signup" })
  .addPhase("Account")
  .addStep(loadAccount)
  .addPhase("Provision")
  .addStep(createTenant)
  .addStep(seedDefaults)
  .addPhase("Notify")
  .addStep({
    name: "send welcome email",
    // Inline steps and imported ones mix freely — ctx here already knows about
    // everything the imported steps returned.
    when: ({ input }) => input.sendEmail,
    handler: async ({ ctx, success }) => {
      success(`welcomed ${ctx.account.owner} on ${ctx.tenantId}`);
      return { emailed: true };
    },
  });
```

`addStep` is where the requirement is actually enforced: TypeScript checks that
the script has produced `Ctx` by the point the step is added. Dropping
`createTenant` (which needs `{ account: Account }`) into a script that has not
loaded an account yet is a compile error at the `addStep` call, not a runtime
`undefined` inside the handler.

```text
Argument of type '{ name: string; handler: ... }' is not assignable to
parameter of type ... Property 'account' is missing in type '{}'.
```

## Reusing one step in two scripts

The whole point of pulling a step into its own module is using it more than
once. The same `createTenant` step can compensate identically in two unrelated
scripts, as long as each satisfies its `Ctx` requirement by the time it is
added:

```ts
// Script one: a normal signup
new Script<{ accountId: string; sendEmail: boolean }>({ name: "signup" })
  .addPhase("Account")
  .addStep(loadAccount)
  .addPhase("Provision")
  .addStep(createTenant)   // its rollback compensates here
  .addStep(seedDefaults);

// Script two: a region migration, written later, reusing the same step
new Script<{ accountId: string; fromRegion: string }>({ name: "migrate" })
  .addPhase("Prepare")
  .addStep(loadAccount)
  .addStep({
    name: "snapshot old region",
    handler: async ({ input }) => ({ snapshotId: await snapshot(input.fromRegion) }),
    rollbackKeys: ["snapshotId"],
    rollback: async ({ ctx }) => thaw(ctx.snapshotId),
  })
  .addPhase("Provision")
  .addStep(createTenant)   // same import, same rollback, compensates here too
  .addStep({
    name: "restore snapshot",
    handler: async ({ ctx }) => ({ restored: await restore(ctx.tenantId) }),
  });
```

If "restore snapshot" fails in the second script, both `createTenant`'s and
`loadAccount`'s rollbacks (if `loadAccount` had one) run — the imported step's
compensation logic is identical wherever it is mounted, because it is the exact
same function reference each time.

## When to reach for a whole routine instead

`stepFor` binds one step. When several steps travel together as a unit, a
whole "fetch and normalize" pipeline that several scripts want, phases and all,
`routineFor` does the same job one level up. See
[Reusable Scripts and Mounts](../guides/reusable-scripts).
