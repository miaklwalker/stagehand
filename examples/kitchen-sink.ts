/**
 *
 *   node --experimental-strip-types examples/kitchen-sink.ts
 *   node --experimental-strip-types examples/kitchen-sink.ts -- --fail        smoke test fails, watch Deploy unwind
 *   node --experimental-strip-types examples/kitchen-sink.ts -- --production  also runs the Publish phase
 *   node --experimental-strip-types examples/kitchen-sink.ts -- --fresh       ignore the cache and rewrite it
 *
 * Run it twice without --fresh: "download manifest" (the whole Fetch phase)
 * and "checksum artifact" come back marked cached (⊙) instead of running.
 * Delete ./.stagehand-cache-kitchen-sink.json to start over.
 */
import { Script, fileStore } from "../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const shouldFail = process.argv.includes("--fail");
const shouldPublish = process.argv.includes("--production");
const cacheMode = process.argv.includes("--fresh") ? "refresh" : "on";

const cache = fileStore("./.stagehand-cache-kitchen-sink.json");

interface Input {
  service: string;
  environment: "staging" | "production";
  ref: string;
}

const release = new Script<Input>({
  name: "kitchen sink",
  description: "One script that touches every corner of the renderer",
  rollback: "all",
  // logPlacement:'step',
})
  .addPhase("Preflight", { description: "Cheap checks before anything is touched" })
  .addStep({
    name: "resolve commit",
    handler: async ({ input, status }) => {
      status("querying git");
      await wait(400);
      const branch = input.ref;
      return { sha: "9f2c1ab41", branch, legacyBranch: branch !== "main" };
    },
  })
  .addStep({
    name: "authenticate",
    // Two transient 503s, then success — the frame shows "(retry n)" while
    // this is happening, and `warn` lands as an orange line in the meantime.
    retry: { attempts: 4, delayMs: (attempt) => attempt * 300 },
    handler: async ({ attempt, warn, note }) => {
      await wait(300);
      if (attempt < 3) {
        warn(`attempt ${attempt}: 503 from the auth service`);
        throw new Error("503 service unavailable");
      }
      note(`connected on attempt ${attempt}`);
      return { actor: "michael" };
    },
  })
  .addStep({
    name: "run legacy migration shim",
    // The commit is on main, so `legacyBranch` is false and this is skipped —
    // the frame shows the pending glyph greyed out with no duration.
    when: ({ ctx }) => ctx.legacyBranch,
    handler: async () => {
      await wait(200);
      return { legacyShimRan: true };
    },
  })

  .addPhase("Fetch", {
    description: "Pull the release manifest",
    // The whole phase is skipped and its delta reused whenever the stored
    // sha still matches — run this file twice to see it.
    cache: {
      store: cache,
      stale: ({ value, ctx }) => (value as { sha?: string }).sha !== ctx.sha,
    },
  })
  .addStep({
    name: "download manifest",
    handler: async ({ ctx, progress, note }) => {
      const bar = progress({ total: 1000, label: "fetching" });
      for (let i = 0; i <= 1000; i += 25) {
        bar.update(i, i < 500 ? "fetching" : "parsing");
        await wait(90);
      }
      bar.done();
      note("312 entries");
      // `sha` rides along so the phase's cached delta carries what `stale`
      // above needs to compare against on the next run.
      return {
        sha: ctx.sha,
        manifestBytes: 4_183_040,
        rawManifest: { entries: 312, sha: ctx.sha },
      };
    },
  })
  .addStep({
    name: "verify checksum",
    handler: async ({ ctx, task, status }) => {
      const check = task("compare against upstream digest");
      check.start();
      status(`${ctx.rawManifest.entries} entries`);
      await wait(500);
      check.succeed();
      return { manifestVerified: true };
    },
  })

  .addPhase("Build")
  .addStep({
    name: "install dependencies",
    handler: async ({ progress, note }) => {
      const bar = progress({ total: 428, label: "resolving" });
      for (let i = 0; i <= 428; i += 12) {
        bar.update(i, i < 220 ? "resolving" : "linking");
        await wait(70);
      }
      bar.done();
      note("428 packages");
      return { packages: 428 };
    },
  })
  .addStep({
    name: "compile bundle",
    clean: ["packages"],
    handler: async ({ tasks, status }) => {
      const list = tasks(["typecheck", "transform", "minify", "sourcemaps"]);

      list.get("typecheck").start();
      status("typecheck");
      await wait(500);
      list.get("typecheck").succeed();

      // Renamed mid-flight, so `label()` gets exercised too.
      const transform = list.get("transform");
      transform.start();
      status("transform");
      await wait(300);
      transform.label("transform (esbuild)");
      await wait(300);
      transform.succeed();

      list.get("minify").start();
      status("minify");
      await wait(500);
      list.get("minify").succeed();

      // This build has them off — a task can finish without running too.
      list.get("sourcemaps").skip("disabled for this build");

      return { artifact: "dist/bundle.tar.gz" };
    },
  })
  .addStep({
    name: "run unit tests",
    handler: async ({ progress, status, info, warn, success }) => {
      const bar = progress({ total: 180, label: "tests" });
      for (let passed = 0; passed <= 180; passed += 9) {
        bar.update(passed);
        status(`${passed}/180 passed`);
        if (passed === 45) info("suite: unit");
        if (passed === 90) warn("flaky test retried: checkout.spec.ts");
        if (passed === 135) info("suite: integration");
        await wait(110);
      }
      bar.done();
      success("180/180 passed");
      return { testsPassed: 180 };
    },
  })

  .addPhase("Package", { description: "Checksum and sign what Build produced" })
  .addStep({
    name: "checksum artifact",
    // A step can cache on its own too — no phase needed.
    cache: { store: cache, stale: ({ ageMs }) => ageMs > 30_000 },
    handler: async ({ ctx, note }) => {
      await wait(450);
      note(`sha256:${ctx.sha}…`);
      return { checksum: `sha256:${ctx.sha}` };
    },
  })
  .addStep({
    name: "sign artifact",
    // The raw manifest was only ever needed for the checksum.
    clean: ["rawManifest"],
    handler: async ({ ctx, note }) => {
      await wait(350);
      note(`signed as ${ctx.checksum.slice(0, 14)}…`);
      return { signature: "sig_7f21ab" };
    },
  })

  .addPhase("Deploy", { description: "The part a saga exists for" })
  .addStep({
    name: "provision infra",
    handler: async ({ status }) => {
      status("allocating capacity");
      await wait(500);
      return { infraId: "infra_9c02" };
    },
    rollbackKeys: ["infraId"],
    rollback: async ({ ctx, log }) => {
      await wait(220);
      log(`tore down ${ctx.infraId}`);
    },
  })
  .addStep({
    name: "upload artifact",
    handler: async ({ ctx, progress }) => {
      const bar = progress({ total: ctx.manifestBytes, label: "uploading" });
      const chunk = Math.ceil(ctx.manifestBytes / 25);
      for (let sent = 0; sent < ctx.manifestBytes; sent += chunk) {
        bar.update(Math.min(sent, ctx.manifestBytes));
        await wait(95);
      }
      bar.done();
      return { uploadId: "up_8812" };
    },
    rollbackKeys: ["uploadId"],
    rollback: async ({ ctx, log }) => {
      await wait(200);
      log(`removed artifact ${ctx.uploadId}`);
    },
  })
  .addStep({
    name: "run migrations",
    // Done with the byte count now that the upload has it sized.
    clean: ["manifestBytes"],
    handler: async ({ status }) => {
      status("applying pending migrations");
      await wait(550);
      return { migrationBatch: "mb_44" };
    },
    rollbackKeys: ["migrationBatch"],
    rollback: async ({ ctx, log }) => {
      await wait(240);
      log(`reverted migration batch ${ctx.migrationBatch}`);
    },
  })
  .addStep({
    name: "smoke test",
    handler: async ({ ctx, status, success }) => {
      status(`checking ${ctx.infraId}`);
      await wait(500);
      if (shouldFail) throw new Error("smoke test failed: p99 latency above SLO");
      success("all checks green");
      return { smokeOk: true };
    },
  })

  .addPhase("Publish", {
    description: "Only for a production release",
    when: ({ input }) => input.environment === "production",
  })
  .addStep({
    name: "tag release",
    handler: async ({ ctx, note }) => {
      await wait(250);
      note(`v${ctx.sha.slice(0, 7)}`);
      return { tag: `v-${ctx.sha}` };
    },
  })
  .addStep({
    name: "notify channels",
    handler: async ({ task, log, info, warn, error, success }) => {
      const post = task("post to #releases");
      post.start();
      await wait(300);
      post.succeed();

      // Five severities, five icons and colors — none of these fail the
      // step. `error()` is only ever a red log line; the step still finishes
      // green underneath it.
      log("release notes drafted");
      info("2 subscribers on this channel");
      warn("slack webhook retried once");
      error("email digest failed to send (non-fatal)");
      success("announcement posted");

      return { announced: true };
    },
  })

  .addPhase("Cleanup", { description: "Tidy up regardless of how we got here" })
  .addStep({
    name: "archive logs",
    handler: async ({ status }) => {
      status("compressing run log");
      await wait(400);
      return { archived: true };
    },
  })
  .addStep({
    name: "send summary",
    handler: async ({ ctx, success }) => {
      await wait(350);
      success(`release ${ctx.sha} complete`);
      return { summarySent: true };
    },
  });

const result = await release.run(
  {
    service: "orders-api",
    environment: shouldPublish ? "production" : "staging",
    ref: "main",
  },
  { cache: cacheMode },
);

if (result.ok) {
  console.log(`\n  ${result.ctx.summarySent ? "done" : "stopped early"}: ${result.ctx.sha}\n`);
} else {
  console.log(`\n  unwound: ${result.rollbacks.map((entry) => entry.step).join(" → ")}\n`);
  process.exitCode = 1;
}
