---
title: "Prompts"
description: "Asking the person running the script something, mid-step: free text, yes/no, a single choice, or several — with no runtime dependency."
---

`context.prompt` asks the person running the script something, right in the
middle of a step. It suspends the live frame, draws in its place, and hands
the frame back once it has an answer:

```ts
.addStep({
  name: "choose environment",
  handler: async ({ prompt }) => ({
    environment: await prompt.select({
      message: "deploy to which environment?",
      choices: [
        { label: "staging", value: "staging" },
        { label: "production", value: "production", hint: "customers are here" },
      ],
    }),
  }),
})
```

Four kinds of question, one per method:

| method | asks for | resolves to |
| --- | --- | --- |
| `prompt.text(options)` | free text | `string` |
| `prompt.confirm(options)` | yes/no | `boolean` |
| `prompt.select(options)` | one choice | `Value` |
| `prompt.multiselect(options)` | several choices | `Value[]` |

Every one of them is hand-rolled on top of the same ANSI primitives the live
frame uses — there is no prompt library underneath, so the visual style stays
consistent with the rest of the run and no runtime dependency is added.

## Controls

| prompt | keys |
| --- | --- |
| `text` | type to fill in the field, Backspace to edit, Enter to accept |
| `confirm` | `y` / `n`, or `←`/`→`/`Tab` to toggle then Enter |
| `select` | `↑`/`↓` to move, Enter to choose |
| `multiselect` | `↑`/`↓` to move, Space to toggle, Enter to confirm |

Ctrl-C cancels any of them — see [Cancelling a prompt](#cancelling-a-prompt).

## `prompt.text`

```ts
const tag = await prompt.text({
  message: "release tag?",
  default: "v1.0.0",
  placeholder: "e.g. v1.2.3",
  mask: false,
  validate: (value) =>
    /^v\d+\.\d+\.\d+$/.test(value) ? true : "expected something like v1.2.3",
});
```

`validate` returns `true` to accept the value, or a string to show as an error
and keep prompting — it can be async. `mask: true` echoes `•` instead of the
typed characters, for anything sensitive enough that it shouldn't be shown.
`default` is both what a non-interactive stdin gets (see below) and what an
empty Enter accepts interactively.

## `prompt.confirm`

```ts
const go = await prompt.confirm({ message: "ship it?", default: false });
```

## `prompt.select` / `prompt.multiselect`

Both take the same `choices: { label, value, hint? }[]`. `select` returns the
one chosen `value`; `multiselect` returns an array, and can constrain how many
are picked:

```ts
const components = await prompt.multiselect({
  message: "which components ship?",
  choices: [
    { label: "api", value: "api" },
    { label: "web", value: "web" },
    { label: "worker", value: "worker" },
  ],
  default: ["api", "web"],
  min: 1,
});
```

Pressing Enter with too few or too many selected shows an inline error and
keeps the prompt open rather than resolving.

## Non-interactive stdin

CI, a pipe, or a non-TTY subprocess has no terminal to draw a prompt into. In
that case nothing is drawn at all:

- with a `default`, that value is returned immediately;
- with no `default`, the call throws `PromptUnavailableError` rather than
  hanging forever on a stream nothing will ever write to.

This is why every example above sets a `default` — it is what makes a script
that prompts interactively also runnable unattended, in CI, with no special
casing in the script itself. See [Errors](../reference/errors#promptunavailableerror).

## Cancelling a prompt

Ctrl-C while a prompt is open throws `PromptCancelledError`. `isAbort()`
recognizes it, so a run cancelled mid-prompt unwinds exactly the way a SIGINT
does — same rollback policy, same `result.status === "aborted"`. See
[Errors](../reference/errors#promptcancellederror) and
[Rollbacks](../guides/rollbacks).

## Only on `StepContext`

`prompt` is on a handler's context, not a `rollback`'s — compensation runs
during an unwind, which is the wrong moment to stop and wait on a person.
