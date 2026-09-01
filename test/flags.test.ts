import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateNameError,
  MissingFlagValueError,
  Script,
  UnknownFlagError,
  memoryStore,
  routineFor,
} from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;

test("a string flag is read via --long, its short alias, or =value", async () => {
  for (const argv of [["--environment", "prod"], ["-e", "prod"], ["--environment=prod"]]) {
    const result = await new Script({ name: "t", ...quiet })
      .defineFlag({ name: "environment", short: "e" })
      .addStep({ name: "read", handler: ({ flags }) => ({ env: flags.environment }) })
      .run(undefined, { argv });

    assert.ok(result.ok, JSON.stringify(argv));
    assert.equal(result.ok && result.ctx.env, "prod", JSON.stringify(argv));
  }
});

test("`long` overrides the derived flag while `name` still names the property", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .defineFlag({ name: "environment", long: "env", short: "e" })
    .addStep({ name: "read", handler: ({ flags }) => ({ env: flags.environment }) })
    .run(undefined, { argv: ["--env", "staging"] });

  assert.ok(result.ok);
  assert.equal(result.ok && result.ctx.env, "staging");
});

test("a missing string flag with no default resolves to undefined", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .defineFlag({ name: "environment" })
    .addStep({ name: "read", handler: ({ flags }) => ({ env: flags.environment }) })
    .run(undefined, { argv: [] });

  assert.ok(result.ok);
  assert.equal(result.ok && result.ctx.env, undefined);
});

test("a default is used when the flag is absent, and overridden when present", async () => {
  const build = () =>
    new Script({ name: "t", ...quiet })
      .defineFlag({ name: "environment", short: "e", default: "staging" })
      .addStep({ name: "read", handler: ({ flags }) => ({ env: flags.environment }) });

  const withDefault = await build().run(undefined, { argv: [] });
  assert.equal(withDefault.ok && withDefault.ctx.env, "staging");

  const overridden = await build().run(undefined, { argv: ["-e", "prod"] });
  assert.equal(overridden.ok && overridden.ctx.env, "prod");
});

test("a boolean flag is true when present and false by default", async () => {
  const build = () =>
    new Script({ name: "t", ...quiet })
      .defineFlag({ name: "force", short: "f", boolean: true })
      .addStep({ name: "read", handler: ({ flags }) => ({ force: flags.force }) });

  const absent = await build().run(undefined, { argv: [] });
  assert.equal(absent.ok && absent.ctx.force, false);

  const present = await build().run(undefined, { argv: ["--force"] });
  assert.equal(present.ok && present.ctx.force, true);

  const short = await build().run(undefined, { argv: ["-f"] });
  assert.equal(short.ok && short.ctx.force, true);
});

test("--flag=false overrides a boolean default of true", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .defineFlag({ name: "cache", boolean: true, default: true })
    .addStep({ name: "read", handler: ({ flags }) => ({ cache: flags.cache }) })
    .run(undefined, { argv: ["--cache=false"] });

  assert.equal(result.ok && result.ctx.cache, false);
});

test("a boolean flag never swallows the next token as its value", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .defineFlag({ name: "force", boolean: true })
    .defineFlag({ name: "environment" })
    .addStep({
      name: "read",
      handler: ({ flags }) => ({ force: flags.force, env: flags.environment }),
    })
    .run(undefined, { argv: ["--force", "--environment", "prod"] });

  assert.ok(result.ok);
  assert.equal(result.ok && result.ctx.force, true);
  assert.equal(result.ok && result.ctx.env, "prod");
});

test("a script with no declared flags ignores whatever is in argv", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .addStep({ name: "run", handler: () => ({ done: true }) })
    .run(undefined, { argv: ["--fail", "--whatever=1"] });

  assert.ok(result.ok);
});

test("an undeclared flag throws UnknownFlagError before any step runs", async () => {
  let ran = false;
  await assert.rejects(
    new Script({ name: "t", ...quiet })
      .defineFlag({ name: "environment" })
      .addStep({
        name: "read",
        handler: () => {
          ran = true;
        },
      })
      .run(undefined, { argv: ["--nope"] }),
    UnknownFlagError,
  );
  assert.equal(ran, false);
});

test("a string flag with nothing after it throws MissingFlagValueError", async () => {
  await assert.rejects(
    new Script({ name: "t", ...quiet })
      .defineFlag({ name: "environment" })
      .addStep({ name: "read", handler: () => {} })
      .run(undefined, { argv: ["--environment"] }),
    MissingFlagValueError,
  );
});

test("two flags cannot share a name, a long form, or a short alias", () => {
  assert.throws(
    () =>
      new Script({ name: "t", ...quiet })
        .defineFlag({ name: "environment" })
        .defineFlag({ name: "environment" }),
    DuplicateNameError,
  );
  assert.throws(
    () =>
      new Script({ name: "t", ...quiet })
        .defineFlag({ name: "environment", long: "env" })
        .defineFlag({ name: "envelope", long: "env" }),
    DuplicateNameError,
  );
  assert.throws(
    () =>
      new Script({ name: "t", ...quiet })
        .defineFlag({ name: "environment", short: "e" })
        .defineFlag({ name: "extra", short: "e" }),
    DuplicateNameError,
  );
});

test("flags are also available on a rollback's context", async () => {
  const seen: unknown[] = [];
  const result = await new Script({ name: "t", ...quiet })
    .defineFlag({ name: "dryRun", boolean: true })
    .addStep({
      name: "provision",
      handler: () => ({ id: "x" }),
      rollbackKeys: ["id"],
      rollback: ({ flags }) => {
        seen.push(flags.dryRun);
      },
    })
    .addStep({
      name: "boom",
      handler: () => {
        throw new Error("boom");
      },
    })
    .run(undefined, { argv: ["--dry-run"] });

  assert.equal(result.ok, false);
  assert.deepEqual(seen, [true]);
});

test("a step's `when` sees flags, without a manual copy into ctx", async () => {
  const build = () =>
    new Script({ name: "t", ...quiet })
      .defineFlag({ name: "skip", boolean: true })
      .addStep({
        name: "maybe",
        when: ({ flags }) => !flags.skip,
        handler: () => ({ ran: true }),
      });

  const ran = await build().run(undefined, { argv: [] });
  assert.equal(ran.ok && ran.ctx.ran, true);

  const skipped = await build().run(undefined, { argv: ["--skip"] });
  assert.equal(skipped.ok && "ran" in skipped.ctx, false);
});

test("a phase's `when` sees flags", async () => {
  const build = () =>
    new Script({ name: "t", ...quiet })
      .defineFlag({ name: "production", boolean: true })
      .addPhase("Publish", { when: ({ flags }) => flags.production })
      .addStep({ name: "publish", handler: () => ({ published: true }) });

  const staging = await build().run(undefined, { argv: [] });
  assert.equal(staging.ok && "published" in staging.ctx, false);

  const production = await build().run(undefined, { argv: ["--production"] });
  assert.equal(production.ok && production.ctx.published, true);
});

test("a cached phase's `stale` sees flags", async () => {
  const store = memoryStore();
  let builds = 0;

  const build = () =>
    new Script({ name: "t", ...quiet })
      .defineFlag({ name: "fresh", boolean: true })
      .addPhase("Build", { cache: { store, stale: ({ flags }) => flags.fresh } })
      .addStep({
        name: "compile",
        handler: () => {
          builds += 1;
          return { artifact: "a.tgz" };
        },
      });

  await build().run(undefined, { argv: [] });
  assert.equal(builds, 1);

  await build().run(undefined, { argv: [] });
  assert.equal(builds, 1, "still cached: --fresh was not passed");

  await build().run(undefined, { argv: ["--fresh"] });
  assert.equal(builds, 2, "--fresh forced the phase to treat the entry as stale");
});

test("a routine's mount `input` mapper receives flags — the native way to project a flag onto a routine's input", async () => {
  const pullChannel = routineFor<{ channel: string }>()("pull channel", (s) =>
    s.addPhase("Fetch").addStep({ name: "pull", handler: ({ input }) => ({ pulled: input.channel }) }),
  );

  const result = await new Script({ name: "t", ...quiet })
    .defineFlag({ name: "channel", default: "default-channel" })
    .use(pullChannel, { input: ({ flags }) => ({ channel: flags.channel }) })
    .run(undefined, { argv: ["--channel", "amazon"] });

  assert.ok(result.ok);
  assert.equal(result.ok && result.ctx.pulled, "amazon");
});

test("a step declared inside routineFor can read context.flags, typed loosely", async () => {
  const withFlags = routineFor<{ id: string }>()("with flags", (s) =>
    s.addPhase("Go").addStep({
      name: "read",
      // `flags` is UnknownFlags (Record<string, unknown>) inside a routine —
      // it cannot know the host's specific Flags shape, same as `stepFor`.
      handler: ({ flags }) => ({ dryRun: flags.dryRun === true }),
    }),
  );

  const result = await new Script({ name: "t", ...quiet })
    .defineFlag({ name: "dryRun", boolean: true })
    .use(withFlags, { input: { id: "x" } })
    .run(undefined, { argv: ["--dry-run"] });

  assert.ok(result.ok);
  assert.equal(result.ok && result.ctx.dryRun, true);
});
