---
name: 'prompting-the-user'
description: >
  Covers `context.prompt` — `text`, `confirm`, `select` and `multiselect` asked mid-step, the
  non-interactive `default` fallback, `PromptUnavailableError`, and Ctrl-C cancellation via
  `PromptCancelledError`. Load this for "ask for confirmation before a destructive step," "let the
  user pick an environment," or "make an interactive script runnable in CI."
metadata:
  type: 'core'
  library: 'stagehand'
  library_version: '0.8.0'
sources:
  - 'miaklwalker/stagehand:docs/guides/prompts.md'
  - 'miaklwalker/stagehand:docs/reference/errors.md'
  - 'miaklwalker/stagehand:src/ui/prompt.ts'
  - 'miaklwalker/stagehand:test/prompt.test.ts'
---

# Stagehand — Prompting the User

`prompt` is on a step handler's context. Calling it suspends the live frame, draws the question, and repaints once answered. It is hand-rolled on the renderer's ANSI primitives, so there is no extra dependency.

## Setup

```ts
.addStep({
  name: "confirm production",
  handler: async ({ flags, prompt }) => {
    if (flags.environment === "production" && !flags.force) {
      const ok = await prompt.confirm({ message: "Deploy to production?", default: false });
      if (!ok) throw new Error("cancelled by user");
    }
    return {};
  },
})
```

## Core Patterns

| method | resolves to |
| --- | --- |
| `prompt.text({ message, default?, placeholder?, validate?, mask? })` | `string` |
| `prompt.confirm({ message, default? })` | `boolean` |
| `prompt.select({ message, choices, default? })` | the chosen `value` |
| `prompt.multiselect({ message, choices, default?, min?, max? })` | `value[]` |

`choices` are `{ label, value, hint? }`. `validate` returns `true` or an error string, may be async. `mask: true` echoes `•`.

### Always give a `default` if the script may run unattended

With no TTY (CI, a pipe) nothing is drawn: a `default` is returned immediately, and a missing one throws `PromptUnavailableError`.

### Prefer a flag, prompt only as the fallback

```ts
const environment = flags.environment ?? (await prompt.select({ message: "environment?", choices, default: "staging" }));
```

## Common Mistakes

### HIGH Prompting without a `default` in a script CI runs

Wrong:
```ts
const tag = await prompt.text({ message: "release tag?" }); // PromptUnavailableError under CI
```

Correct:
```ts
const tag = await prompt.text({ message: "release tag?", default: "latest" });
```

### MEDIUM Treating Ctrl-C at a prompt as a handler failure

Wrong:
```ts
if (!result.ok) report(result.error); // reports a cancellation as a bug
```

Correct:
```ts
if (!result.ok && isAbort(result.error)) { /* result.status === "aborted"; rollback policy applied */ }
```

`PromptCancelledError` is recognised by `isAbort`, so the run unwinds exactly like a SIGINT.

### MEDIUM Prompting from a rollback

`prompt` exists only on `StepContext`. A rollback runs during an unwind and cannot stop to ask; decide inside the step and keep what the rollback needs in `rollbackKeys`.

Source: docs/guides/prompts.md; src/ui/prompt.ts
