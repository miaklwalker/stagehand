/**
 * `defineFlag` / `context.flags`: typed command-line flags, parsed once
 * before any phase executes.
 *
 *   node --experimental-strip-types examples/flags.ts
 *   node --experimental-strip-types examples/flags.ts --env production
 *   node --experimental-strip-types examples/flags.ts -e production -f
 *   node --experimental-strip-types examples/flags.ts --nope        throws UnknownFlagError
 *
 * `environment` has a `default`, so the first invocation above needs no flags
 * at all. `force` is a boolean flag: its bare presence is `true`; leaving it
 * off is `false`. See docs/guides/flags.md.
 */
import { Script } from "../dist/index.js";

await new Script({ name: "deploy", description: "Ship a service to an environment" })
  .defineFlag({ name: "environment", long: "env", short: "e", default: "staging" })
  .defineFlag({ name: "force", short: "f", boolean: true })
  .addPhase("Deploy")
  .addStep({
    name: "ship",
    handler: async ({ flags, log, note, prompt }) => {
      note(flags.environment);
      if (flags.environment === "production" && !flags.force) {
        const confirm = await prompt.confirm({
            message: "We want to deploy?",
            default: false,
        })
          if(!confirm) {
              throw new Error("Deployment cancelled by user");
          }
      }
      log(`deploying to ${flags.environment}${flags.force ? " (forced)" : ""}`);
      return { environment: flags.environment, forced: flags.force };
    },
  })
  .run();
