import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Script, fileStore, memoryStore, type CacheStore } from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;

test("a cached phase is skipped on the second run and its delta restored", async () => {
  const store = memoryStore();
  let builds = 0;

  const build = () =>
    new Script<{ ref: string }>({ name: "t", ...quiet })
      .addPhase("Build", { cache: { store } })
      .addStep({
        name: "compile",
        handler: () => {
          builds += 1;
          return { artifact: "dist/app.tgz" };
        },
      })
      .addPhase("Release")
      .addStep({ name: "ship", handler: ({ ctx }) => ({ shipped: ctx.artifact }) });

  const first = await build().run({ ref: "main" });
  assert.equal(builds, 1);
  assert.equal(first.steps[0]?.status, "success");

  const second = await build().run({ ref: "main" });
  assert.equal(builds, 1, "the handler must not run again");
  assert.equal(second.steps[0]?.status, "cached");
  assert.equal(second.steps[0]?.attempts, 0);
  assert.deepEqual(second.ok && second.ctx, { artifact: "dist/app.tgz", shipped: "dist/app.tgz" });
});

test("only the phase's own delta is stored, not the whole context", async () => {
  const store = memoryStore();

  await new Script<{ ref: string }>({ name: "t", ...quiet })
    .addPhase("Setup")
    .addStep({ name: "seed", handler: ({ input }) => ({ ref: input.ref }) })
    .addPhase("Build", { cache: { store } })
    .addStep({ name: "compile", handler: () => ({ artifact: "a.tgz" }) })
    .run({ ref: "main" });

  const entry = await store.read("Build");
  assert.deepEqual(entry?.value, { artifact: "a.tgz" });
});

test("a hit never clobbers keys an earlier phase produced this run", async () => {
  const store = memoryStore();

  const build = (ref: string) =>
    new Script<{ ref: string }>({ name: "t", ...quiet })
      .addPhase("Setup")
      .addStep({ name: "seed", handler: ({ input }) => ({ ref: input.ref }) })
      .addPhase("Build", { cache: { store } })
      .addStep({ name: "compile", handler: () => ({ artifact: "a.tgz" }) })
      .run({ ref });

  await build("main");
  const second = await build("feature");

  // `ref` is this run's value even though the entry was written under "main".
  assert.deepEqual(second.ok && second.ctx, { ref: "feature", artifact: "a.tgz" });
});

test("a cached step restores its own return value", async () => {
  const store = memoryStore();
  let calls = 0;

  const build = () =>
    new Script({ name: "t", ...quiet }).addStep({
      name: "fetch",
      cache: store,
      handler: () => {
        calls += 1;
        return { catalog: ["a", "b"] };
      },
    });

  await build().run();
  const second = await build().run();

  assert.equal(calls, 1);
  assert.equal(second.steps[0]?.status, "cached");
  assert.deepEqual(second.ok && second.ctx, { catalog: ["a", "b"] });
});

test("stale forces a miss and the entry is overwritten", async () => {
  const store = memoryStore();
  let calls = 0;
  let invalid = false;

  const build = () =>
    new Script({ name: "t", ...quiet })
      .addPhase("Work", { cache: { store, stale: () => invalid } })
      .addStep({
        name: "do",
        handler: () => {
          calls += 1;
          return { n: calls };
        },
      });

  await build().run();
  await build().run();
  assert.equal(calls, 1);

  invalid = true;
  const third = await build().run();
  assert.equal(calls, 2);
  assert.deepEqual(third.ok && third.ctx, { n: 2 });

  invalid = false;
  await build().run();
  assert.equal(calls, 2, "the refreshed entry is reused");
});

test("stale sees the live context and the entry's age", async () => {
  const store = memoryStore();
  let seen: { ref: string } | undefined;
  let age = -1;

  const build = (ref: string) =>
    new Script<{ ref: string }>({ name: "t", ...quiet })
      .addPhase("Setup")
      .addStep({ name: "seed", handler: ({ input }) => ({ ref: input.ref }) })
      .addPhase("Work", {
        cache: {
          store,
          stale: ({ ctx, ageMs }) => {
            // ctx is the live object, as it is for `when` — snapshot it.
            seen = { ...ctx };
            age = ageMs;
            return false;
          },
        },
      })
      .addStep({ name: "do", handler: () => ({ done: true }) })
      .run({ ref });

  await build("main");
  await build("feature");

  assert.deepEqual(seen, { ref: "feature" });
  assert.ok(age >= 0);
});

test("a value that fails the schema is a miss, not a crash", async () => {
  const store = memoryStore();
  await store.write("Work", { value: { n: "not a number" }, savedAt: Date.now() });

  const numeric = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: (value: unknown) =>
        typeof (value as { n: unknown }).n === "number"
          ? { value: value as { n: number } }
          : { issues: [{ message: "n must be a number" }] },
    },
  };

  const result = await new Script({ name: "t", ...quiet })
    .addPhase("Work", { cache: { store, schema: numeric } })
    .addStep({ name: "do", handler: () => ({ n: 42 }) })
    .run();

  assert.equal(result.steps[0]?.status, "success");
  assert.deepEqual(result.ok && result.ctx, { n: 42 });
  assert.deepEqual((await store.read("Work"))?.value, { n: 42 });
});

test("nothing is written when a step in the phase fails", async () => {
  const store = memoryStore();

  await new Script({ name: "t", ...quiet, rollback: "none" })
    .addPhase("Work", { cache: { store } })
    .addStep({ name: "ok", handler: () => ({ a: 1 }) })
    .addStep({
      name: "boom",
      handler: () => {
        throw new Error("nope");
      },
    })
    .run();

  assert.equal(await store.read("Work"), undefined);
});

test("a failure later in the run keeps an already-hit entry", async () => {
  const store = memoryStore();

  const build = (fail: boolean) =>
    new Script({ name: "t", ...quiet })
      .addPhase("Build", { cache: { store } })
      .addStep({ name: "compile", handler: () => ({ artifact: "a.tgz" }) })
      .addPhase("Release")
      .addStep({
        name: "ship",
        handler: () => {
          if (fail) throw new Error("health check failed");
          return { shipped: true };
        },
      })
      .run();

  await build(false);
  const second = await build(true);

  assert.equal(second.ok, false);
  assert.deepEqual((await store.read("Build"))?.value, { artifact: "a.tgz" });
});

test("a cached step's rollback does not run during an unwind", async () => {
  const store = memoryStore();
  let rollbacks = 0;

  const build = () =>
    new Script({ name: "t", ...quiet })
      .addStep({
        name: "provision",
        cache: store,
        handler: () => ({ tenantId: "t_1" }),
        rollback: () => {
          rollbacks += 1;
        },
      })
      .addStep({
        name: "boom",
        handler: () => {
          throw new Error("nope");
        },
      });

  const first = await build().run();
  assert.equal(first.ok, false);
  assert.equal(rollbacks, 1, "it ran, so it compensates");

  const second = await build().run();
  assert.equal(second.ok, false);
  assert.equal(rollbacks, 1, "it was cached, so there is nothing to compensate");
});

test("clean still applies on a cache hit", async () => {
  const store = memoryStore();

  const build = () =>
    new Script<{ secret: string }>({ name: "t", ...quiet })
      .addPhase("Setup")
      .addStep({ name: "seed", handler: ({ input }) => ({ secret: input.secret, keep: 1 }) })
      .addPhase("Work", { cache: { store } })
      .addStep({ name: "use", handler: () => ({ derived: true }), clean: ["secret"] })
      .run({ secret: "hush" });

  const first = await build();
  assert.deepEqual(first.ok && first.ctx, { keep: 1, derived: true });

  const second = await build();
  assert.equal(second.steps[1]?.status, "cached");
  assert.deepEqual(second.ok && second.ctx, { keep: 1, derived: true });
});

test("a phase skipped by when never touches the store", async () => {
  const store = memoryStore();

  await new Script({ name: "t", ...quiet })
    .addPhase("Work", { when: () => false, cache: { store } })
    .addStep({ name: "do", handler: () => ({ a: 1 }) })
    .run();

  assert.equal(await store.read("Work"), undefined);
});

test("run({ cache }) overrides the script's caching", async () => {
  const store = memoryStore();
  let calls = 0;

  const build = () =>
    new Script({ name: "t", ...quiet })
      .addPhase("Work", { cache: { store } })
      .addStep({
        name: "do",
        handler: () => {
          calls += 1;
          return { n: calls };
        },
      });

  await build().run(undefined, { cache: "off" });
  assert.equal(await store.read("Work"), undefined, "off writes nothing");

  await build().run(undefined, { cache: "read-only" });
  assert.equal(await store.read("Work"), undefined, "read-only writes nothing");

  await build().run();
  assert.equal(calls, 3);

  const refreshed = await build().run(undefined, { cache: "refresh" });
  assert.equal(calls, 4, "refresh ignores the hit");
  assert.deepEqual(refreshed.ok && refreshed.ctx, { n: 4 });
  assert.deepEqual((await store.read("Work"))?.value, { n: 4 });
});

test("phases sharing one store do not collide", async () => {
  const store = memoryStore();

  await new Script({ name: "t", ...quiet })
    .addPhase("A", { cache: { store } })
    .addStep({ name: "a", handler: () => ({ a: 1 }) })
    .addPhase("B", { cache: { store } })
    .addStep({ name: "b", handler: () => ({ b: 2 }) })
    .run();

  assert.deepEqual((await store.read("A"))?.value, { a: 1 });
  assert.deepEqual((await store.read("B"))?.value, { b: 2 });
});

test("a store that throws warns and runs the work", async () => {
  const broken: CacheStore = {
    read: () => {
      throw new Error("disk on fire");
    },
    write: () => {
      throw new Error("disk on fire");
    },
    clear: () => {},
  };

  let calls = 0;
  const result = await new Script({ name: "t", ...quiet })
    .addPhase("Work", { cache: { store: broken } })
    .addStep({
      name: "do",
      handler: () => {
        calls += 1;
        return { n: 1 };
      },
    })
    .run();

  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test("fileStore round-trips and survives a corrupt file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stagehand-cache-"));
  const path = join(dir, "nested", "cache.json");

  try {
    let calls = 0;
    const build = () =>
      new Script({ name: "t", ...quiet })
        .addPhase("Work", { cache: fileStore(path) })
        .addStep({
          name: "do",
          handler: () => {
            calls += 1;
            return { n: calls };
          },
        });

    await build().run();
    const onDisk: unknown = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual((onDisk as Record<string, { value: unknown }>)["Work"]?.value, { n: 1 });

    const second = await build().run();
    assert.equal(calls, 1);
    assert.deepEqual(second.ok && second.ctx, { n: 1 });

    await writeFile(path, "{ not json", "utf8");
    const third = await build().run();
    assert.equal(calls, 2, "a corrupt file reads as no cache at all");
    assert.equal(third.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a void step caches as 'already done'", async () => {
  const store = memoryStore();
  let calls = 0;

  const build = () =>
    new Script({ name: "t", ...quiet }).addStep({
      name: "seed database",
      cache: store,
      handler: () => {
        calls += 1;
      },
    });

  await build().run();
  const second = await build().run();

  assert.equal(calls, 1);
  assert.equal(second.steps[0]?.status, "cached");
});

test("the live frame badges a cached phase with its age", async () => {
  const { renderBody } = await import("../dist/ui/frame.js");
  const { setColorEnabled } = await import("../dist/index.js");

  setColorEnabled(false);
  try {
    const lines = renderBody(
      {
        name: "t",
        status: "success",
        startedAt: 0,
        rollbackCount: 0,
        rollbackFailures: 0,
        logTail: [],
        phases: [
          {
            name: "Build",
            cacheAgeMs: 6 * 60_000,
            steps: [
              {
                name: "compile",
                phaseIndex: 0,
                status: "cached",
                attempts: 0,
                tasks: [],
                logs: [],
                hasRollback: false,
              },
            ],
          },
        ],
      },
      0,
      1000,
      false,
    );

    const text = lines.join("\n");
    assert.match(text, /Build\s+cached . 6m ago/);
    assert.match(text, /compile\s+cached/);
  } finally {
    setColorEnabled(true);
  }
});
