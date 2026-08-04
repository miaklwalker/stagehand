/**
 * Run me twice:
 *   npm run example:cache
 *   npm run example:cache            (the Build phase is served from cache)
 *   npm run example:cache -- --fresh (ignore the cache and rewrite it)
 *
 * The cache lands in ./.stagehand-cache.json — delete it to start over.
 */
import { Script, fileStore } from "../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fresh = process.argv.includes("--fresh");

interface Input {
  service: string;
  ref: string;
}

const cache = fileStore("./.stagehand-cache.json");

const deploy = new Script<Input>({
  name: "deploy",
  description: "Build once, release as often as you like",
})
  .addPhase("Validation")
  .addStep({
    name: "resolve commit",
    handler: async ({ input }) => {
      await wait(200);
      return { sha: "9f2c1ab", branch: input.ref };
    },
  })

  // The expensive part. Its delta — { artifact, bytes } — is what gets stored;
  // `packages` is cleaned inside the phase, so it never makes it into the
  // entry. `stale` decides when the entry stops counting; here, a different
  // commit means a different build.
  .addPhase("Build", {
    cache: {
      store: cache,
      stale: ({ value, ctx }) => (value as { sha?: string }).sha !== ctx.sha,
    },
  })
  .addStep({
    name: "install dependencies",
    handler: async ({ progress, note }) => {
      const bar = progress({ total: 428, label: "resolving" });
      for (let i = 0; i <= 428; i += 17) {
        bar.update(i);
        await wait(10);
      }
      bar.done();
      note("428 packages");
      return { packages: 428 };
    },
  })
  .addStep({
    name: "compile bundle",
    clean: ["packages"],
    handler: async ({ ctx, tasks, status }) => {
      const list = tasks(["typecheck", "transform", "minify"]);
      for (const key of ["typecheck", "transform", "minify"] as const) {
        const task = list.get(key);
        task.start();
        status(key);
        await wait(320);
        task.succeed();
      }
      return { artifact: "dist/bundle.tar.gz", bytes: 4_182_233, sha: ctx.sha };
    },
  })

  .addPhase("Release")
  .addStep({
    name: "upload artifact",
    handler: async ({ ctx, progress }) => {
      const bar = progress({ total: ctx.bytes, label: "uploading" });
      for (let sent = 0; sent < ctx.bytes; sent += 400_000) {
        bar.update(sent);
        await wait(16);
      }
      bar.done();
      return { uploadId: "up_8812" };
    },
  })
  // A single step can cache too — the stored value is exactly what it returns.
  .addStep({
    name: "warm CDN",
    cache: { store: cache, stale: ({ ageMs }) => ageMs > 30_000 },
    handler: async ({ success }) => {
      await wait(500);
      success("edge nodes primed");
      return { edges: 42 };
    },
  });

const result = await deploy.run(
  { service: "api", ref: "main" },
  { cache: fresh ? "refresh" : "on" },
);

if (result.ok) {
  console.log(`\n  released ${result.ctx.artifact} across ${result.ctx.edges} edges\n`);
} else {
  process.exitCode = 1;
}
