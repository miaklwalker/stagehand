/**
 * Run me:
 *   npm run example
 *   npm run example:fail   (exercise the rollback path)
 */
import { Script } from "../dist/index.js";

const shouldFail = process.argv.includes("--fail");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Input {
  service: string;
  environment: "staging" | "production";
  ref: string;
}

const deploy = new Script<Input>({
  name: "deploy",
  description: "Build, upload and release a service",
  rollback: "all",
})
  .addPhase("Validation", { description: "Cheap checks before we touch anything" })
  .addStep({
    name: "resolve commit",
    handler: async ({ input, status }) => {
      status("querying git");
      await wait(220);
      return { sha: "9f2c1ab", branch: input.ref };
    },
  })
  .addStep({
    name: "check permissions",
    retry: { attempts: 3, delayMs: (attempt) => attempt * 150 },
    handler: async ({ input, ctx, attempt, warn }) => {
      await wait(180);
      if (attempt < 2) {
        warn(`auth service cold, retrying (${ctx.sha})`);
        throw new Error("503 from auth service");
      }
      return { actor: "michael", canDeploy: input.environment !== "production" };
    },
  })

  .addPhase("Build")
  .addStep({
    name: "install dependencies",
    handler: async ({ progress, log }) => {
      const bar = progress({ total: 428, label: "resolving" });
      for (let i = 0; i <= 428; i += 17) {
        bar.update(i, i < 200 ? "resolving" : "linking");
        await wait(12);
      }
      bar.done();
      log("428 packages installed");
      return { packages: 428 };
    },
  })
  .addStep({
    name: "compile bundle",
    timeoutMs: 15_000,
    // the package count was only interesting while installing
    clean: ["packages"],
    handler: async ({ tasks, status }) => {
      const list = tasks(["typecheck", "transform", "minify", "write manifest"]);

      for (const key of ["typecheck", "transform", "minify", "write manifest"] as const) {
        const task = list.get(key);
        task.start();
        status(key);
        await wait(280);
        task.succeed();
      }

      return { artifact: "dist/bundle.tar.gz", bytes: 4_182_233 };
    },
  })

  .addPhase("Release")
  .addStep({
    name: "upload artifact",
    handler: async ({ ctx, progress }) => {
      const bar = progress({ total: ctx.bytes, label: "uploading" });
      for (let sent = 0; sent < ctx.bytes; sent += 220_000) {
        bar.update(sent);
        await wait(18);
      }
      bar.done();
      return { uploadId: "up_8812" };
    },
    // ask for the one context key the compensation needs; nothing may clean it
    rollbackKeys: ["sha"],
    rollback: async ({ ctx, output, log }) => {
      await wait(200);
      log(`deleted artifact ${output.uploadId} built from ${ctx.sha}`);
    },
  })
  .addStep({
    name: "shift traffic",
    handler: async ({ ctx, input, status, success }) => {
      status(`routing ${input.environment} to ${ctx.uploadId}`);
      await wait(400);
      if (shouldFail) throw new Error("health check failed: 3/5 pods unhealthy");
      success(`live on ${ctx.sha}`);
      return { releaseId: "rel_204" };
    },
    rollback: async ({ log }) => {
      await wait(250);
      log("traffic returned to previous release");
    },
  })
  .addStep({
    name: "notify slack",
    when: ({ input }) => input.environment === "production",
    handler: async () => {
      await wait(150);
    },
  });

const result = await deploy.run({
  service: "api",
  environment: "staging",
  ref: "main",
});

if (result.ok) {
  // `result.ctx` is fully typed: sha, branch, actor, canDeploy, artifact,
  // bytes, uploadId, releaseId — `packages` was cleaned away mid-run.
  console.log(`\n  released ${result.ctx.releaseId} from ${result.ctx.sha}\n`);
} else {
  process.exitCode = 1;
}
