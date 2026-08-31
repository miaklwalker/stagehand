/**
 * `context.prompt`: free text, yes/no, a single choice, and several — asked
 * mid-step, right in the live frame.
 *
 *   node --experimental-strip-types examples/prompts.ts
 *
 * Controls: type to fill in text, Backspace to edit, arrow keys to move a
 * selection, Space to toggle a choice in the multiselect, Enter to accept,
 * y/n (or ←/→ then Enter) for the yes/no prompt, Ctrl-C to cancel — which
 * unwinds the run like any other abort.
 *
 * Every prompt below sets a `default`, so the script also completes if stdin
 * isn't an interactive terminal (piped input, CI): it skips straight to that
 * value instead of drawing anything. See docs/guides/prompts.md.
 */
import { Script } from "../dist/index.js";

await new Script({ name: "release wizard", description: "A few questions, then a plan" })
  .addPhase("Gather")
  .addStep({
    name: "name the release",
    handler: async ({ prompt, note }) => {
      const tag = await prompt.text({
        message: "release tag?",
        default: "v1.0.0",
        placeholder: "e.g. v1.2.3",
        validate: (value) =>
          /^v\d+\.\d+\.\d+$/.test(value) ? true : "expected something like v1.2.3",
      });
      note(tag);
      return { tag };
    },
  })
  .addStep({
    name: "choose environment",
    handler: async ({ prompt }) => ({
      environment: await prompt.select({
        message: "deploy to which environment?",
        default: "staging",
        choices: [
          { label: "staging", value: "staging", hint: "safe to break" },
          { label: "production", value: "production", hint: "customers are here" },
        ],
      }),
    }),
  })
  .addStep({
    name: "pick what ships",
    handler: async ({ prompt }) => ({
      components: await prompt.multiselect({
        message: "which components?",
        default: ["api", "web"],
        min: 1,
        choices: [
          { label: "api", value: "api" },
          { label: "web", value: "web" },
          { label: "worker", value: "worker" },
        ],
      }),
    }),
  })
  .addStep({
    name: "confirm",
    handler: async ({ prompt, ctx }) => {
      const go = await prompt.confirm({
        message: `ship ${ctx.tag} (${ctx.components.join(", ")}) to ${ctx.environment}?`,
        default: ctx.environment === "staging",
      });
      if (!go) throw new Error("cancelled by operator");
      return { go };
    },
  })
  .addPhase("Ship")
  .addStep({
    name: "release",
    handler: async ({ ctx, log }) => {
      log(`releasing ${ctx.tag} to ${ctx.environment}: ${ctx.components.join(", ")}`);
      return { released: true };
    },
  })
  .run();
