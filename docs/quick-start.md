---
title: "Quick Start"
description: "Build a complete deploy script end to end, from input type to result, including a rollback."
---

This walks through one script from scratch: two phases, a step that produces
data later steps depend on, a progress bar, and a rollback that fires when the
last step fails. Every API used here is real — copy it and run it.

## Set up the input type

A script's input is just a type parameter on `Script`. There is no schema
required unless you want runtime validation (see `defineInput` in
[The Typed Context](guides/typed-context)):

```ts
import { Script } from "@michaelrwalker/stagehand";

interface Input {
  service: string;
  environment: "staging" | "production";
  ref: string;
}
```

## Build the script

```ts
const deploy = new Script<Input>({
  name: "deploy",
  description: "Build, upload and release a service",
})
  .addPhase("Validation")
  .addStep({
    name: "resolve commit",
    handler: async ({ input, status }) => {
      status("querying git");
      const sha = await resolveSha(input.ref);
      return { sha, branch: input.ref };
    },
  })

  .addPhase("Build")
  .addStep({
    name: "compile bundle",
    handler: async ({ progress, note }) => {
      const bar = progress({ total: 100, label: "compiling" });
      const artifact = await compile((pct) => bar.update(pct));
      bar.done();
      note(artifact.size);
      return { artifact: artifact.path, bytes: artifact.bytes };
    },
  })

  .addPhase("Release")
  .addStep({
    name: "upload artifact",
    handler: async ({ ctx, progress }) => {
      //          ^ ctx.sha and ctx.artifact are typed here
      const bar = progress({ total: ctx.bytes, label: "uploading" });
      const uploadId = await upload(ctx.artifact, (sent) => bar.update(sent));
      bar.done();
      return { uploadId };
    },
    // Compensation needs the commit sha to name what it is deleting — ask for
    // it by name. From here on, no step may `clean` it away.
    rollbackKeys: ["sha"],
    rollback: async ({ ctx, output, log }) => {
      await cdn.delete(output.uploadId, ctx.sha);
      log(`deleted artifact ${output.uploadId} built from ${ctx.sha}`);
    },
  })
  .addStep({
    name: "shift traffic",
    handler: async ({ ctx, input, status, success }) => {
      status(`routing ${input.environment} to ${ctx.uploadId}`);
      const healthy = await shiftTraffic(ctx.uploadId);
      if (!healthy) throw new Error("health check failed: 3/5 pods unhealthy");
      success(`live on ${ctx.sha}`);
      return { releaseId: crypto.randomUUID() };
    },
  });
```

Note what is happening with types here, with no annotation written by hand:

- `ctx` in "upload artifact" already knows about `sha`, `branch`, `artifact`, and
  `bytes`: everything the two earlier steps returned.
- `rollback`'s `ctx` is narrowed to exactly `{ sha: string }`, because that is all
  `rollbackKeys` asked for, not the full context.
- `output` in `rollback` is that step's own return value, `{ uploadId: string }`,
  regardless of what `rollbackKeys` declared.

## Run it

```ts
const result = await deploy.run({
  service: "api",
  environment: "staging",
  ref: "main",
});
```

`result` is a discriminated union on `ok`:

```ts
if (result.ok) {
  // result.ctx is fully typed: sha, branch, artifact, bytes, uploadId, releaseId
  console.log(`released ${result.ctx.releaseId} from ${result.ctx.sha}`);
} else {
  // result.ctx is Partial<Ctx> — whatever succeeded before the failure
  console.error(`failed at ${result.failedAt?.phase} › ${result.failedAt?.step}`);
  console.error(`rolled back: ${result.rollbacks.map((r) => r.step).join(", ")}`);
  process.exitCode = 1;
}
```

If "shift traffic" throws, "upload artifact"'s rollback runs — deleting the
artifact it just uploaded — because it is the only step in front of it that
declared one. "resolve commit" and "compile bundle" had none, so nothing runs for
them; there was nothing to compensate.

## What to reach for next

- [Phases and Steps](guides/phases-and-steps) for how phases group steps and
  affect rollback scope.
- [Rollbacks](guides/rollbacks) for the full compensation model.
- [The Handler Surface](guides/handler-surface) for everything a handler can call:
  `log`, `status`, `note`, `progress`, `task`, `tasks`.
- [Caching](guides/caching) to skip re-running an expensive phase or step across
  runs.
