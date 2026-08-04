import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateNameError,
  Script,
  fileStore,
  memoryStore,
  routineFor,
} from "../dist/index.js";

const quiet = { silent: true, handleSignals: false } as const;

interface Order {
  id: string;
  total: number;
}

/** Reads input.channel, needs nothing in the context. */
const fetchChannel = routineFor<{ channel: string }>()("fetch channel", (s) =>
  s
    .addPhase("Fetch")
    .addStep({ name: "authenticate", handler: ({ input }) => ({ token: `t_${input.channel}` }) })
    .addStep({
      name: "pull orders",
      handler: ({ ctx }): { orders: Order[] } => ({
        orders: [{ id: `${ctx.token}_o1`, total: 10 }],
      }),
    })
    .addPhase("Normalize")
    .addStep({ name: "dedupe", handler: ({ ctx }) => ({ orderCount: ctx.orders.length }) }),
);

/** Needs an upstream `hash` in the context. */
const verify = routineFor<{ channel: string }, { hash: string }>()("verify", (s) =>
  s
    .addPhase("Verify")
    .addStep({ name: "compare", handler: ({ ctx }) => ({ verified: ctx.hash.length > 0 }) }),
);

test("a routine's phases and context flow into the host", async () => {
  const orders: Order[] = [
    { id: "o1", total: 10 },
    { id: "o2", total: 5 },
  ];

  const report = new Script<{ channel: string }>({ name: "report", ...quiet })
    .use(
      routineFor<{ channel: string }>()("fetch", (s) =>
        s
          .addPhase("Fetch")
          .addStep({ name: "pull", handler: () => ({ orders }) }),
      ),
    )
    .addPhase("Report")
    .addStep({ name: "aggregate", handler: ({ ctx }) => ({ total: ctx.orders.length }) });

  const result = await report.run({ channel: "amazon" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.ctx, { orders, total: 2 });
  assert.deepEqual(report.outline(), [
    { phase: "Fetch", steps: ["pull"] },
    { phase: "Report", steps: ["aggregate"] },
  ]);
});

test("the same routine mounts into two unrelated scripts", async () => {
  const sync = await new Script<{ channel: string; strict: boolean }>({ name: "sync", ...quiet })
    .use(fetchChannel)
    .addPhase("Validation")
    .addStep({ name: "check", handler: ({ ctx, input }) => ({ ok: input.strict && ctx.orderCount >= 0 }) })
    .run({ channel: "shopify", strict: true });

  const report = await new Script<{ channel: string; month: string }>({ name: "report", ...quiet })
    .use(fetchChannel)
    .addPhase("Report")
    .addStep({ name: "aggregate", handler: ({ ctx, input }) => ({ line: `${input.month}: ${ctx.orderCount}` }) })
    .run({ channel: "amazon", month: "2026-07" });

  assert.equal(sync.ok, true);
  assert.equal(report.ok, true);
  assert.equal(report.ok && report.ctx.line, "2026-07: 1");
});

test("a plain Script mounts, and stays runnable on its own", async () => {
  const pipeline = new Script<{ channel: string }>({ name: "pull", ...quiet })
    .addPhase("Fetch")
    .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.channel] }) });

  const alone = await pipeline.run({ channel: "etsy" });
  assert.deepEqual(alone.ok && alone.ctx, { rows: ["etsy"] });

  const mounted = await new Script<{ channel: string }>({ name: "report", ...quiet })
    .use(pipeline)
    .addPhase("Report")
    .addStep({ name: "count", handler: ({ ctx }) => ({ n: ctx.rows.length }) })
    .run({ channel: "etsy" });

  assert.deepEqual(mounted.ok && mounted.ctx, { rows: ["etsy"], n: 1 });
});

test("a routine that needs upstream context mounts once the host has it", async () => {
  const result = await new Script<{ channel: string }>({ name: "t", ...quiet })
    .addPhase("Setup")
    .addStep({ name: "hash", handler: () => ({ hash: "abc123" }) })
    .use(verify)
    .run({ channel: "amazon" });

  assert.deepEqual(result.ok && result.ctx, { hash: "abc123", verified: true });
});

test("mounting the same routine twice needs `as`", () => {
  const host = () => new Script<{ channel: string }>({ name: "t", ...quiet }).use(fetchChannel);

  assert.throws(() => host().use(fetchChannel), (error: unknown) => {
    assert.ok(error instanceof DuplicateNameError);
    assert.equal(error.kind, "phase");
    assert.equal(error.duplicate, "Fetch");
    assert.match(error.message, /as:/);
    return true;
  });

  const both = host().use(fetchChannel, { as: "Shopify" });
  assert.deepEqual(
    both.outline().map((phase) => phase.phase),
    ["Fetch", "Normalize", "Shopify / Fetch", "Shopify / Normalize"],
  );
});

test("two mounts get their own cache slots", async () => {
  const store = memoryStore();

  const pull = routineFor<{ channel: string }>()("pull", (s) =>
    s
      .addPhase("Fetch", { cache: { store } })
      .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.channel] }) }),
  );

  await new Script<{ channel: string }>({ name: "t", ...quiet })
    .use(pull, { as: "Amazon" })
    .use(pull, { as: "Shopify" })
    .run({ channel: "amazon" });

  assert.deepEqual((await store.read("Amazon / Fetch"))?.value, { rows: ["amazon"] });
  assert.deepEqual((await store.read("Shopify / Fetch"))?.value, { rows: ["amazon"] });
});

test("a routine's cached phase is reused by a different script", async () => {
  const store = memoryStore();
  let pulls = 0;

  const pull = routineFor<{ channel: string }>()("pull", (s) =>
    s.addPhase("Fetch", { cache: { store } }).addStep({
      name: "pull",
      handler: () => {
        pulls += 1;
        return { rows: ["a", "b"] };
      },
    }),
  );

  await new Script<{ channel: string }>({ name: "sync", ...quiet })
    .use(pull)
    .addPhase("Validate")
    .addStep({ name: "check", handler: () => ({ checked: true }) })
    .run({ channel: "amazon" });

  // Weeks later, a different script — the fetch is already done.
  const report = await new Script<{ channel: string }>({ name: "report", ...quiet })
    .use(pull)
    .addPhase("Report")
    .addStep({ name: "aggregate", handler: ({ ctx }) => ({ n: ctx.rows.length }) })
    .run({ channel: "amazon" });

  assert.equal(pulls, 1);
  assert.equal(report.steps[0]?.status, "cached");
  assert.deepEqual(report.ok && report.ctx, { rows: ["a", "b"], n: 2 });
});

test("a spliced rollback compensates during the host's unwind", async () => {
  const undone: string[] = [];

  const provision = routineFor<void>()("provision", (s) =>
    s.addPhase("Provision").addStep({
      name: "create tenant",
      handler: () => ({ tenantId: "t_1" }),
      rollbackKeys: ["tenantId"],
      rollback: ({ ctx }) => {
        undone.push(ctx.tenantId);
      },
    }),
  );

  const result = await new Script({ name: "t", ...quiet })
    .use(provision)
    .addPhase("Release")
    .addStep({
      name: "boom",
      handler: () => {
        throw new Error("nope");
      },
    })
    .run();

  assert.equal(result.ok, false);
  assert.deepEqual(undone, ["t_1"]);
});

test("keys a routine reserved cannot be cleaned by the host", () => {
  const provision = routineFor<void>()("provision", (s) =>
    s.addPhase("Provision").addStep({
      name: "create tenant",
      handler: () => ({ tenantId: "t_1" }),
      rollbackKeys: ["tenantId"],
      rollback: () => {},
    }),
  );

  const host = new Script({ name: "t", ...quiet }).use(provision).addPhase("Later");

  assert.throws(
    () =>
      host.addStep({
        name: "tidy",
        handler: () => {},
        // @ts-expect-error - reserved by the routine's rollbackKeys
        clean: ["tenantId"],
      }),
    /reserved by rollbackKeys/,
  );
});

test("addStep straight after use() is refused", () => {
  const host = new Script<{ channel: string }>({ name: "t", ...quiet }).use(fetchChannel);

  assert.throws(
    () => host.addStep({ name: "sneaky", handler: () => ({}) }),
    /Cannot add a step after use\(\)/,
  );
});

test("duplicate phase names are refused without any routine involved", () => {
  assert.throws(
    () => new Script({ name: "t", ...quiet }).addPhase("Build").addPhase("Build"),
    (error: unknown) => error instanceof DuplicateNameError && error.kind === "phase",
  );
});

test("duplicate step names within a phase are refused", () => {
  assert.throws(
    () =>
      new Script({ name: "t", ...quiet })
        .addPhase("Build")
        .addStep({ name: "compile", handler: () => ({ a: 1 }) })
        .addStep({ name: "compile", handler: () => ({ b: 2 }) }),
    (error: unknown) => {
      assert.ok(error instanceof DuplicateNameError);
      assert.equal(error.kind, "step");
      assert.equal(error.duplicate, "compile");
      return true;
    },
  );
});

test("the same step name in two different phases is fine", () => {
  const script = new Script({ name: "t", ...quiet })
    .addPhase("A")
    .addStep({ name: "run", handler: () => ({ a: 1 }) })
    .addPhase("B")
    .addStep({ name: "run", handler: () => ({ b: 2 }) });

  assert.deepEqual(script.outline(), [
    { phase: "A", steps: ["run"] },
    { phase: "B", steps: ["run"] },
  ]);
});

test("a host missing the required context is a compile error", () => {
  new Script<{ channel: string }>({ name: "t", ...quiet })
    // @ts-expect-error - `verify` needs ctx.hash and nothing has produced it
    .use(verify);

  assert.ok(true);
});

test("a host missing the required input is a compile error", () => {
  new Script<{ unrelated: string }>({ name: "t", ...quiet })
    // @ts-expect-error - `fetchChannel` reads input.channel
    .use(fetchChannel);

  assert.ok(true);
});

test("a mounted plain Script must accept the host's input too", () => {
  const needsMore = new Script<{ channel: string; since: string }>({ name: "pull", ...quiet })
    .addPhase("Fetch")
    .addStep({ name: "pull", handler: ({ input }) => ({ rows: [input.since] }) });

  new Script<{ channel: string }>({ name: "t", ...quiet })
    // @ts-expect-error - the host has no `since` on its input
    .use(needsMore);

  assert.ok(true);
});

test("a routine's phase-level when() travels with it", async () => {
  const optional = routineFor<{ skip: boolean }>()("optional", (s) =>
    s
      .addPhase("Optional", { when: ({ input }) => !input.skip })
      .addStep({ name: "work", handler: () => ({ did: true }) }),
  );

  const result = await new Script<{ skip: boolean }>({ name: "t", ...quiet })
    .use(optional)
    .run({ skip: true });

  assert.equal(result.steps[0]?.status, "skipped");
  assert.deepEqual(result.ok && result.ctx, {});
});

test("use() rejects something that is neither a routine nor a script", () => {
  assert.throws(
    // @ts-expect-error - not mountable
    () => new Script({ name: "t", ...quiet }).use({ phases: [] }),
    /expects a routine/,
  );
});

test("fileStore-backed routines keep their slots apart across mounts", async () => {
  const store = fileStore("/dev/null/never-written");
  const pull = routineFor<void>()("pull", (s) =>
    s.addPhase("Fetch", { cache: { store } }).addStep({ name: "pull", handler: () => ({ a: 1 }) }),
  );

  // Writing to an impossible path warns rather than failing the run.
  const result = await new Script({ name: "t", ...quiet }).use(pull, { as: "One" }).run();
  assert.equal(result.ok, true);
});

/* -- Per-mount input ------------------------------------------------------- */

interface ChannelInput {
  channel: string;
  apiKey: string;
}

const pull = routineFor<ChannelInput>()("pull", (s) =>
  s.addPhase("Fetch").addStep({
    name: "pull",
    handler: ({ input }) => ({ pulled: `${input.channel}:${input.apiKey}` }),
  }),
);

test("each mount can be given its own input", async () => {
  const seen: string[] = [];

  const record = routineFor<ChannelInput>()("record", (s) =>
    s.addPhase("Fetch").addStep({
      name: "pull",
      handler: ({ input }) => {
        seen.push(`${input.channel}/${input.apiKey}`);
        return { last: input.channel };
      },
    }),
  );

  const result = await new Script<{ amazonKey: string; shopifyKey: string }>({
    name: "all channels",
    ...quiet,
  })
    .use(record, {
      as: "Amazon",
      input: ({ input }) => ({ channel: "amazon", apiKey: input.amazonKey }),
    })
    .use(record, {
      as: "Shopify",
      input: ({ input }) => ({ channel: "shopify", apiKey: input.shopifyKey }),
    })
    .run({ amazonKey: "ak_1", shopifyKey: "sk_2" });

  assert.deepEqual(seen, ["amazon/ak_1", "shopify/sk_2"]);
  assert.equal(result.ok && result.ctx.last, "shopify");
});

test("a fixed value works as well as a function", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .use(pull, { input: { channel: "etsy", apiKey: "ek_9" } })
    .run();

  assert.equal(result.ok && result.ctx.pulled, "etsy:ek_9");
});

test("a mapped mount frees the host from the routine's input shape", async () => {
  // The host has no `channel` and no `apiKey` at all.
  const result = await new Script<{ region: string }>({ name: "t", ...quiet })
    .use(pull, { input: ({ input }) => ({ channel: input.region, apiKey: "k" }) })
    .run({ region: "eu" });

  assert.equal(result.ok && result.ctx.pulled, "eu:k");
});

test("the mapper sees the context as it stands at the mount", async () => {
  const result = await new Script<{ region: string }>({ name: "t", ...quiet })
    .addPhase("Setup")
    .addStep({ name: "key", handler: ({ input }) => ({ key: `k_${input.region}` }) })
    .use(pull, { input: ({ ctx }) => ({ channel: "amazon", apiKey: ctx.key }) })
    .run({ region: "eu" });

  assert.equal(result.ok && result.ctx.pulled, "amazon:k_eu");
});

test("an async mapper is awaited", async () => {
  const result = await new Script({ name: "t", ...quiet })
    .use(pull, {
      input: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { channel: "slow", apiKey: "k" };
      },
    })
    .run();

  assert.equal(result.ok && result.ctx.pulled, "slow:k");
});

test("one mount resolves its input once across all its phases", async () => {
  let resolutions = 0;
  const two = routineFor<ChannelInput>()("two", (s) =>
    s
      .addPhase("One")
      .addStep({ name: "a", handler: ({ input }) => ({ a: input.channel }) })
      .addPhase("Two")
      .addStep({ name: "b", handler: ({ input }) => ({ b: input.apiKey }) }),
  );

  const result = await new Script({ name: "t", ...quiet })
    .use(two, {
      input: () => {
        resolutions += 1;
        return { channel: "amazon", apiKey: "k" };
      },
    })
    .run();

  assert.equal(resolutions, 1);
  assert.deepEqual(result.ok && result.ctx, { a: "amazon", b: "k" });
});

test("a mounted rollback compensates with its own mount's input", async () => {
  const undone: string[] = [];

  const provision = routineFor<ChannelInput>()("provision", (s) =>
    s.addPhase("Provision").addStep({
      name: "create",
      handler: ({ input }) => ({ id: `id_${input.channel}` }),
      rollback: ({ input, output }) => {
        undone.push(`${input.channel}:${output.id}`);
      },
    }),
  );

  const result = await new Script<{ key: string }>({ name: "t", ...quiet })
    .use(provision, { as: "A", input: ({ input }) => ({ channel: "amazon", apiKey: input.key }) })
    .addPhase("Boom")
    .addStep({
      name: "boom",
      handler: () => {
        throw new Error("nope");
      },
    })
    .run({ key: "k" });

  assert.equal(result.ok, false);
  assert.deepEqual(undone, ["amazon:id_amazon"]);
});

test("a mount's cache and when() see the mount's input", async () => {
  const store = memoryStore();

  const gated = routineFor<ChannelInput>()("gated", (s) =>
    s
      .addPhase("Fetch", {
        when: ({ input }) => input.channel !== "skip-me",
        cache: { store, stale: ({ input }) => (input as ChannelInput).apiKey === "bust" },
      })
      .addStep({ name: "pull", handler: ({ input }) => ({ got: input.channel }) }),
  );

  const skipped = await new Script({ name: "t", ...quiet })
    .use(gated, { input: { channel: "skip-me", apiKey: "k" } })
    .run();
  assert.equal(skipped.steps[0]?.status, "skipped");
  assert.equal(await store.read("Fetch"), undefined);

  const ran = await new Script({ name: "t2", ...quiet })
    .use(gated, { input: { channel: "amazon", apiKey: "k" } })
    .run();
  assert.equal(ran.ok, true);
  assert.deepEqual((await store.read("Fetch"))?.value, { got: "amazon" });
});

test("a mapper returning the wrong shape is a compile error", () => {
  const host = new Script<{ region: string }>({ name: "t", ...quiet });

  // @ts-expect-error - apiKey is missing from the mapped input
  host.use(pull, { input: ({ input }) => ({ channel: input.region }) });

  assert.ok(true);
});

test("without a mapper the host must still satisfy the routine's input", () => {
  const host = new Script<{ region: string }>({ name: "t", ...quiet });

  // @ts-expect-error - no mapper, and the host has no `channel`/`apiKey`
  host.use(pull);

  assert.ok(true);
});
