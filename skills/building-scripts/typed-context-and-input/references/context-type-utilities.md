# Context type utilities

These are the type-level helpers Stagehand uses internally to compute `Ctx`,
`RollbackContext`, and `WithStepFor` chains. All of them run automatically as
part of `addStep`, `defineInput`, and `stepFor` — a script author almost never
imports or writes them directly. They're documented here for the rare case of
debugging a confusing inferred type, or hand-writing a step definition outside
`addStep` (e.g. a shared library file) where the composed context needs to be
spelled out explicitly.

## `Prettify<T>`

```ts
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
```

Flattens an intersection type (`Omit<Ctx, K> & Out`) into a single object type
so editor hovers show a real shape (`{ a: string; b: number }`) instead of a
chain of `&` operators. Applied automatically everywhere a context type is
constructed — `result.ctx`, a step's `ctx` parameter, `RollbackData` — so
there's nothing to opt into. Reach for it directly only when hand-writing a
type alias for a shared step's context and the hover in your editor is showing
an unreadable intersection.

## `Merge<Ctx, Out>`

```ts
export type Merge<Ctx, Out> = [Out] extends [void]
  ? Ctx
  : [Out] extends [undefined]
    ? Ctx
    : Prettify<Omit<Ctx, keyof Out> & Out>;
```

Computes the context after a step contributes `Out`: later keys win over
earlier ones of the same name (`Omit<Ctx, keyof Out> & Out`), and a handler
that returns `void` or `undefined` leaves `Ctx` completely untouched. This is
the type-level mirror of the runtime `Object.assign`-based merge in
`src/script.ts`. It is the core of how every `addStep` call widens `Ctx`, and
also underlies `WithStepFor` (see below). Almost never written by hand —
inference through `addStep` produces it automatically.

## `Cleaned<Ctx, Keys>`

```ts
export type Cleaned<Ctx, Keys extends PropertyKey> = Prettify<Omit<Ctx, Keys>>;
```

What a step's `clean` field leaves behind for every later step: `Keys` are
dropped from both the runtime context and the type. This is what makes a
cleaned key a genuine compile error to reach for afterward, not just a
runtime `undefined`. Computed automatically wherever `clean` is used; there's
no reason to reference `Cleaned` directly unless writing tooling that
inspects a script's declared clean keys.

## `RollbackData<Ctx, Keys>`

```ts
export type RollbackData<Ctx, Keys extends readonly PropertyKey[]> = Pick<
  Ctx,
  Extract<Keys[number], keyof Ctx>
>;
```

The slice of context a `rollback` function actually receives: exactly the
keys named in that step's `rollbackKeys`, and nothing else. With no keys
declared, this resolves to `{}` — a rollback has to explicitly ask for what
it needs via `rollbackKeys`; it cannot see the full `Ctx`. `addStep` uses this
(wrapped in `Prettify`) to type the `ctx` parameter of `RollbackContext`. You
would only reference `RollbackData` directly when writing a rollback handler
outside `addStep` and need to spell out its parameter type by hand.

## `WithStepFor<Step, Rest>`

```ts
export type WithStepFor<
  Step extends { handler: (context: never) => unknown },
  Rest extends object = {},
> = Step extends { handler: (context: never) => infer Out }
  ? Merge<Rest, Awaited<Out>>
  : never;
```

Computes the context a *later* step sees, given an earlier step (declared
with `stepFor`) and whatever else is already there (`Rest`). This is the one
utility from this file developers reach for directly on a regular basis — it
is the mechanism behind [Splitting Steps Across Files](../../../reuse/splitting-steps-across-files/SKILL.md):

```ts
export const logIntoDb = stepFor<Input>()({
  name: "log into db",
  handler: async () => ({ conn: await connect() }),
});

export const loadRules = stepFor<
  Input,
  WithStepFor<typeof logIntoDb, { conditions: Array<{ name: string }> }>
>()({
  name: "load rules",
  //     ctx.conn — from the step; ctx.conditions — from the rest
  handler: ({ ctx }) => ({ rules: ctx.conn.query(ctx.conditions) }),
});
```

It nests for chains of steps, without a separate variadic form:

```ts
WithStepFor<typeof second, WithStepFor<typeof first, { conditions: string[] }>>
```

Read inside out: start with `{ conditions: string[] }`, add what `first`
returns, then what `second` returns. That's also the precedence — on a name
collision the outermost step wins, matching the way a later step's return
value shadows an earlier key at runtime. Order the nesting to match the order
the steps actually run in, or the type and the runtime disagree.

`WithStepFor` only reads the step's *output* — its own `Ctx` requirement
against `Rest` is not checked here; that check still happens when the step
definition is passed to `addStep` on a real script. A step returning nothing
leaves `Rest` untouched, and an `async` handler's return is awaited first
(`Awaited<Out>`), so both fall out without a special case.
