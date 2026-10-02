/**
 * `addBranch`: one step, two ways to do it, one shape out.
 *
 *   node --experimental-strip-types examples/branch.ts
 *   node --experimental-strip-types examples/branch.ts --sha abc1234
 *
 * With `--sha` the override arm runs; without it the other arm "looks it up".
 * Either way `ctx.sha` is a `string` for the step that follows, which is
 * what `when` cannot promise. See docs/guides/phases-and-steps.md.
 */
import { Script } from "../dist/index.js";

await new Script<{ service: string }>({ name: "deploy", description: "Ship a service" })
  .defineFlag({ name: "sha", description: "deploy this commit instead of HEAD" })
  .addPhase("Resolve")
  .addBranch({
    name: "resolve commit",
    condition: ({ flags }) => Boolean(flags.sha),
    onTrue: ({ flags, note }) => {
      note("override");
      return { sha: flags.sha as string };
    },
    onFalse: async ({ input, note, status }) => {
      status(`looking up HEAD of ${input.service}`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      note("HEAD");
      return { sha: "9f2c1d0" };
    },
  })
  .addPhase("Build")
  .addStep({
    name: "build image",
    handler: ({ ctx, input, log }) => {
      log(`building ${input.service}:${ctx.sha}`);
      return { image: `${input.service}:${ctx.sha}` };
    },
  })
  .run({ service: "checkout-api" });
