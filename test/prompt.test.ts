import assert from "node:assert/strict";
import test from "node:test";

import {
  PromptCancelledError,
  PromptUnavailableError,
  Script,
  isAbort,
} from "../dist/index.js";
import {
  promptConfirm,
  promptMultiselect,
  promptSelect,
  promptText,
} from "../dist/ui/prompt.js";

// node:test's own stdin is never a TTY, so every prompt here takes the
// non-interactive branch — the one path testable without faking keypresses.

test("a non-interactive text prompt returns its default instead of hanging", async () => {
  const value = await promptText({ message: "env?", default: "staging" });
  assert.equal(value, "staging");
});

test("a non-interactive text prompt with no default throws PromptUnavailableError", async () => {
  await assert.rejects(promptText({ message: "env?" }), PromptUnavailableError);
});

test("a non-interactive confirm prompt returns its default", async () => {
  assert.equal(await promptConfirm({ message: "deploy?", default: false }), false);
});

test("a non-interactive confirm prompt with no default throws", async () => {
  await assert.rejects(promptConfirm({ message: "deploy?" }), PromptUnavailableError);
});

test("a non-interactive select prompt returns its default value", async () => {
  const value = await promptSelect({
    message: "region?",
    choices: [
      { label: "US East", value: "us-east" },
      { label: "EU West", value: "eu-west" },
    ],
    default: "eu-west",
  });
  assert.equal(value, "eu-west");
});

test("select rejects an empty choices list even off a TTY", async () => {
  await assert.rejects(promptSelect({ message: "region?", choices: [] }), /empty choices/);
});

test("a non-interactive multiselect prompt returns its default values", async () => {
  const values = await promptMultiselect({
    message: "features?",
    choices: [
      { label: "Logging", value: "logging" },
      { label: "Metrics", value: "metrics" },
    ],
    default: ["metrics"],
  });
  assert.deepEqual(values, ["metrics"]);
});

test("multiselect with no default and no TTY throws PromptUnavailableError", async () => {
  await assert.rejects(
    promptMultiselect({
      message: "features?",
      choices: [{ label: "Logging", value: "logging" }],
    }),
    PromptUnavailableError,
  );
});

test("PromptCancelledError is recognized by isAbort, same as a SIGINT", () => {
  assert.ok(isAbort(new PromptCancelledError()));
});

test("a step can read context.prompt and a defaulted prompt flows into later steps", async () => {
  const result = await new Script<{ env?: string }>({ name: "t", silent: true, handleSignals: false })
    .addStep({
      name: "ask",
      handler: async ({ prompt }) => ({
        env: await prompt.text({ message: "deploy to?", default: "staging" }),
      }),
    })
    .addStep({
      name: "use",
      handler: ({ ctx }) => ({ target: `deployed to ${ctx.env}` }),
    })
    .run({});

  assert.ok(result.ok);
  assert.equal(result.ok && result.ctx.env, "staging");
  assert.equal(result.ok && result.ctx.target, "deployed to staging");
});

test("a prompt with no default fails the step on a non-interactive stdin", async () => {
  const result = await new Script({ name: "t", silent: true, handleSignals: false })
    .addStep({
      name: "ask",
      handler: async ({ prompt }) => {
        await prompt.confirm({ message: "proceed?" });
      },
    })
    .run();

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error instanceof PromptUnavailableError);
});
