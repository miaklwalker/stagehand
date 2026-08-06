---
title: "Installation"
description: "Install Stagehand and confirm the runtime requirements for the live terminal UI."
---

## Install

```bash
npm install @michaelrwalker/stagehand
```

## Requirements

- **Node >= 20.** The package is published as ESM (`"type": "module"`), and the
  runtime uses modern `AbortController`/`AbortSignal` behavior throughout for
  timeouts, cancellation, and signal handling.
- **Zero runtime dependencies.** The one entry in `package.json`'s
  `dependencies` is `@standard-schema/spec`, which is a types-only package: it
  has no runtime code of its own. It exists so `defineInput` can accept any
  [Standard Schema](https://standardschema.dev)-compliant validator (Zod,
  Valibot, ArkType, Effect Schema, or a hand-rolled one) without depending on any
  of them directly.

## Import

Everything public comes from the package root:

```ts
import {
  Script,
  script,
  stepFor,
  routineFor,
  fileStore,
  memoryStore,
  SchemaValidationError,
  StepFailedError,
  isAbort,
} from "@michaelrwalker/stagehand";
```

## TypeScript configuration

Stagehand's type inference (the context type widening on every `addStep`, the
narrowed `rollback` context, `clean`'s compile-time key checking) relies on
ordinary structural inference. `strict: true` is recommended, as it is what the
library itself is built under, and it is what makes the compile errors
described throughout these docs (a cleaned key, a missing rollback key, a
routine's unmet input) actually surface.

## Verifying the terminal UI

The live frame only activates on an interactive TTY with color support. To see
it, run a script directly in a terminal:

```bash
node --experimental-strip-types your-script.ts
```

Piping the same command to a file, running it in CI, or setting `NO_COLOR=1`
switches automatically to the plain, line-per-event renderer. Nothing about the
script itself needs to change. See
[Terminal Rendering](guides/terminal-rendering) for the detection rules and how
to force one renderer or the other with the `plain` option.
