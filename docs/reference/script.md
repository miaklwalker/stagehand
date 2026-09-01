---
title: "Script"
description: "The Script class API: constructor, defineInput, addPhase, addStep, use, outline, run, plus script(), stepFor, and routineFor."
---

`Script<In, Ctx, Reserved, Slots, Open, Flags>` is the builder every script
starts from. Only the first type parameter is ever written by hand (`In` as
`new Script<Input>(...)`, or inferred via `defineInput`); the rest are inferred
automatically as `addStep`, `addPhase`, `use`, and `defineFlag` are chained.
Full narrative coverage of each method lives in the guides linked below — this
page is the flat signature reference.

## `new Script(options?)`

```ts
constructor(options?: ScriptOptions | string)
```

Accepts a `ScriptOptions` object, or a bare string as shorthand for
`{ name: options }`. See
[Script Options and Results](../guides/script-options-and-result) for every
field.

## `script(options?)`

```ts
function script<In = void>(options?: ScriptOptions | string): Script<In, {}>
```

A factory export equivalent to `new Script<In>(options)`, for callers who prefer
not to write `new`.

## `.defineInput(schema)`

```ts
defineInput<TSchema>(
  schema: StandardSchemaV1<unknown, TSchema>,
): Script<TSchema, Ctx, Reserved>
```

Infers `In` from a [Standard Schema](https://standardschema.dev)-compliant
validator's output type, and validates whatever is passed to `run()` against it
before any phase executes, throwing `SchemaValidationError` on failure. Call it
first, immediately after construction: any `addStep`/`addPhase` called before it
still sees the previous `In`. See
[The Typed Context](../guides/typed-context#validating-input-with-defineinput).

## `.defineFlag(options)`

```ts
defineFlag<const Name extends string>(
  options: BooleanFlagOptions<Name>,
): Script<In, Ctx, Reserved, Slots, Open, Flags & Record<Name, boolean>>

defineFlag<const Name extends string, const Default extends string | undefined = undefined>(
  options: StringFlagOptions<Name, Default>,
): Script<In, Ctx, Reserved, Slots, Open, Flags & Record<Name, Default extends string ? string : string | undefined>>

interface BaseFlagOptions<Name extends string> {
  name: Name;
  long?: string;   // overrides the default, kebab-cased from `name`
  short?: string;  // single-letter `-` alias
  description?: string;
}
interface BooleanFlagOptions<Name> extends BaseFlagOptions<Name> {
  boolean: true;
  default?: boolean;
}
interface StringFlagOptions<Name, Default> extends BaseFlagOptions<Name> {
  boolean?: false;
  default?: Default;
}
```

Declares a flag `run()` parses off the command line into `context.flags`,
keyed by `name`. Throws `DuplicateNameError` if `name`, the resolved long
flag, or `short` is already used by another flag on this script. Full
treatment in [Flags](../guides/flags).

## `.addPhase(name, options?)`

```ts
addPhase(name: string, options?: PhaseOptions<In, Ctx>): Script<...>
addPhase(name: string, build: (script: Script<...>) => Script<...>): Script<...>
addPhase(name: string, options: PhaseOptions<In, Ctx>, build: (...) => Script<...>): Script<...>
```

Opens a new phase; subsequent `addStep` calls land in it until the next
`addPhase`. The two-argument callback form groups a phase's steps in a nested
scope while preserving the same type flow as the flat form. Throws
`DuplicateNameError` if the name is already used anywhere in the script.

`PhaseOptions`:

```ts
interface PhaseOptions<In, Ctx, Flags> {
  description?: string;
  when?: (context: { input: In; ctx: Ctx; flags: Flags }) => Awaitable<boolean>;
  cache?: CacheSource<In, Ctx, unknown, Flags>;
}
```

See [Phases and Steps](../guides/phases-and-steps) and
[Caching](../guides/caching).

## `.addStep(def)`

```ts
addStep<Out, RollbackKeys, CleanKeys>(
  def: StepDef<In, Ctx, Out, RollbackKeys, Slots> & CleanField<Ctx, Reserved, CleanKeys>,
): Script<...>
```

Appends a step to the currently open phase. `StepDef`:

```ts
interface StepDef<In, Ctx, Out, RollbackKeys, Slots, Flags> {
  name: string;
  description?: string;
  handler: (context: StepContext<In, Ctx, Slots, Flags>) => Awaitable<Out>;
  rollbackKeys?: RollbackKeys & readonly (keyof Merge<Ctx, Out>)[];
  rollback?: (context: RollbackContext<In, RollbackData<...>, Out, Slots, Flags>) => Awaitable<void>;
  when?: (context: { input: In; ctx: Ctx; flags: Flags }) => Awaitable<boolean>;
  cache?: CacheSource<In, Ctx, unknown, Flags>;
  retry?: RetryPolicy;
  timeoutMs?: number;
}
```

Plus `clean?: readonly (keyof Ctx)[]` via `CleanField`, checked element-wise
against the step's incoming context and the keys reserved by earlier
`rollbackKeys`. Throws `StepDefinitionError` if `clean` names a reserved key, or
`DuplicateNameError` if the step's name is already used in its phase. See
[The Typed Context](../guides/typed-context),
[Rollbacks](../guides/rollbacks), and
[Cleaning Context Keys](../guides/cleaning-context).

### `StepContext<In, Ctx, Slots, Flags>` (the handler's parameter)

```ts
interface StepContext<In, Ctx, Slots, Flags> {
  readonly input: In;
  readonly ctx: Ctx;
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly phase: string;
  readonly step: string;
  log(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
  status(message: string): void;
  note(message: string): void;
  progress(options: { total: number; label?: string; value?: number }): ProgressHandle;
  task(label: string): TaskHandle;
  tasks<const K extends readonly string[]>(labels: K): TaskListHandle<K[number]>;
  readonly cache: CacheHandle<Slots>;
  readonly prompt: PromptHandle;
  readonly flags: Flags;
}
```

Full description of every member in
[The Handler Surface](../guides/handler-surface). `prompt` is documented on its
own in [Prompts](../guides/prompts), and `flags` in [Flags](../guides/flags).

### `RollbackContext<In, Ctx, Out, Slots, Flags>` (the rollback's parameter)

```ts
interface RollbackContext<In, Ctx, Out, Slots, Flags> {
  readonly input: In;
  readonly ctx: Ctx;      // only the keys named in rollbackKeys
  readonly output: Out;   // exactly what the handler returned
  readonly error: unknown;
  readonly signal: AbortSignal;
  readonly phase: string;
  readonly step: string;
  log(message: string): void;
  status(message: string): void;
  note(message: string): void;
  progress(options: { total: number; label?: string; value?: number }): ProgressHandle;
  readonly cache: CacheHandle<Slots>;
  readonly flags: Flags;
}
```

Full description in [Rollbacks](../guides/rollbacks#the-rollback-context).

### `ProgressHandle`

```ts
interface ProgressHandle {
  update(value: number, label?: string): void;
  increment(by?: number): void;
  setTotal(total: number): void;
  setLabel(label: string): void;
  done(): void;
  readonly value: number;
  readonly total: number;
}
```

### `TaskHandle` / `TaskListHandle<K>`

```ts
interface TaskHandle {
  start(text?: string): void;
  label(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  skip(text?: string): void;
}

interface TaskListHandle<K extends string> {
  readonly tasks: Record<K, TaskHandle>;
  get(key: K): TaskHandle;
}
```

### `PromptHandle`

```ts
interface PromptHandle {
  text(options: TextPromptOptions): Promise<string>;
  confirm(options: ConfirmPromptOptions): Promise<boolean>;
  select<Value>(options: SelectPromptOptions<Value>): Promise<Value>;
  multiselect<Value>(options: MultiSelectPromptOptions<Value>): Promise<Value[]>;
}
```

Full description, including the non-interactive fallback and the option types,
in [Prompts](../guides/prompts).

### `RetryPolicy`

```ts
interface RetryPolicy {
  attempts: number;
  delayMs?: number | ((attempt: number) => number);
  retryIf?: (error: unknown, attempt: number) => boolean;
}
```

## `.use(source, options?)`

```ts
use(routine: Routine<SubIn, Ctx, Out, R, RS>, options: { as?: string; input: MountInput<In, Ctx, SubIn, Flags> }): Script<...>
use(script: Script<SubIn, Out, R, SS, SO>, options: { as?: string; input: MountInput<In, Ctx, SubIn, Flags> }): Script<...>
use(script: Script<In, Out, R, SS, SO>, options?: { as?: string }): Script<...>
use(routine: Routine<In, Ctx, Out, R, RS>, options?: { as?: string }): Script<...>

type MountInput<In, Ctx, SubIn, Flags> =
  | SubIn
  | ((context: { input: In; ctx: Ctx; flags: Flags }) => Awaitable<SubIn>);
```

Splices a `Routine` (from `routineFor`) or another `Script` into this one. With
no `input` option the source must already accept this script's `In`/`Ctx`
directly; with `input`, a fixed value or a `{ input, ctx, flags } => SubIn`
mapper feeds the mount something else, resolved once when the mount is
reached — the native way to project a flag onto a routine's input, with no
manual step needed: `use(routine, { input: ({ flags }) => ({ env: flags.environment }) })`.
`as` prefixes the mounted phases' (and their cache slots') names, required
when mounting the same source twice. Throws `DuplicateNameError` on a name
collision, or `StepDefinitionError` if `source` is neither a `Routine` nor a
`Script`. Full treatment in
[Reusable Scripts and Mounts](../guides/reusable-scripts) and
[Flags](../guides/flags#mapping-a-flag-onto-a-routines-input).

## `.outline()`

```ts
outline(): Array<{ phase: string; steps: string[] }>
```

Reports the declared structure — every phase and its step names, in order —
without running anything.

## `.run(input, options?)`

```ts
run(input: In, options?: RunOptions): Promise<RunResult<Ctx>>

interface RunOptions {
  signal?: AbortSignal;
  cache?: CacheMode;        // "on" | "off" | "refresh" | "read-only"
  argv?: readonly string[]; // default process.argv.slice(2); see defineFlag
}
```

Executes every phase and step in order, applying `defineInput` validation and
then `defineFlag` parsing first, in that order, if either was set. Resolves to
a `RunResult<Ctx>` (see
[Script Options and Results](../guides/script-options-and-result#the-result)),
unless `throwOnError` is set, in which case a failing run rejects with the
original error instead. A bad flag (`UnknownFlagError`, `MissingFlagValueError`)
always throws directly, the same as a `SchemaValidationError` from a bad input.

## `stepFor<In, Ctx, Slots, Flags>()`

```ts
function stepFor<In, Ctx extends object = {}, Slots = {}, Flags = {}>(): <Out, RollbackKeys>(
  def: StepDef<In, Ctx, Out, RollbackKeys, Slots, Flags>,
) => StepDef<In, Ctx, Out, RollbackKeys, Slots, Flags>
```

Binds the input and context a step declared outside any script expects, keeping
full inference on its handler's return type. The requirement is enforced when
the resulting definition is passed to `addStep` on a real script. See
[Splitting Steps Across Files](../guides/splitting-steps).

## `WithStepFor<Step, Rest>`

```ts
type WithStepFor<
  Step extends { handler: (context: never) => unknown },
  Rest extends object = {},
>
```

The context a later step sees: `Step`'s output merged over `Rest`, so the next
`stepFor` can declare its `Ctx` without restating an earlier step's return
shape. Nests (`WithStepFor<typeof b, WithStepFor<typeof a, { rest }>>`), with
the outermost step winning a name collision, matching runtime shadowing. Reads
only the output; the step's own `Ctx` requirement is still checked at `addStep`.
See [Splitting Steps Across Files](../guides/splitting-steps).

## `routineFor<In, Ctx>()`

```ts
function routineFor<In, Ctx extends object = {}>(): <Out, R, S, O>(
  name: string,
  build: (script: Script<In, Ctx, never, {}, ClosedPhase, UnknownFlags>) => Script<In, Out, R, S, O>,
) => Routine<In, Ctx, Out, R, Commit<S, O>>
```

Declares a reusable fragment of phases, built with an ordinary `Script` inside
the callback and recorded under `name`. Mount it with `.use()`. The builder
script's `Flags` is `UnknownFlags`, not `{}` — a routine is written away from
any particular script and cannot know what flags the eventual host will
declare, so a step added inside the callback can still read `context.flags`
(typed loosely, as `Record<string, unknown>`) rather than being stuck with an
unusable empty type. `use()` does not merge a routine's own flags into the
host's `Flags` either way — see [Flags](../guides/flags#only-at-the-top-level).
