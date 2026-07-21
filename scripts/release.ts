/**
 * Build + publish pipeline for this package, written with this package.
 *
 * Dry run (default — nothing is mutated, nothing is published):
 *   npm run release
 *
 * Real release:
 *   npm run release -- --publish
 *   npm run release -- --publish --bump patch
 *   npm run release -- --publish --version 1.0.0 --tag next
 *
 * Note: a step below deletes and rebuilds `dist/`, which is where this very
 * script imported the framework from. That is safe — Node has already loaded
 * the module graph into memory and nothing here imports lazily.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Script } from "../dist/index.js";

import { ExecError, exec, tryExec } from "./exec.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "package.json");

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

type Bump = "none" | "patch" | "minor" | "major";

interface ReleaseInput {
  /** Nothing is written, tagged or published unless this is true. */
  publish: boolean;
  bump: Bump;
  explicitVersion: string | null;
  /** npm dist-tag. */
  distTag: string;
  skipGit: boolean;
  skipTests: boolean;
  /**
   * Perform the local mutations (version write, git tag) but fail at the
   * publishing step, so the compensation path can be exercised without touching
   * the registry. Nothing leaves this machine.
   */
  simulateFailure: boolean;
}

/** Steps that mutate the working tree but not the outside world. */
const mutatesLocally = (input: ReleaseInput): boolean =>
  input.publish || input.simulateFailure;

function parseArgs(argv: string[]): ReleaseInput {
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | null => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };

  const bump = (value("bump") ?? "none") as Bump;
  if (!["none", "patch", "minor", "major"].includes(bump)) {
    throw new Error(`--bump must be none, patch, minor or major (got "${bump}")`);
  }

  return {
    publish: flag("publish"),
    bump,
    explicitVersion: value("version"),
    distTag: value("tag") ?? "latest",
    skipGit: flag("skip-git"),
    skipTests: flag("skip-tests"),
    simulateFailure: flag("simulate-failure"),
  };
}

function bumpVersion(version: string, kind: Bump): string {
  if (kind === "none") return version;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Cannot bump non-semver version "${version}"`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  publishConfig?: { access?: string };
  [key: string]: unknown;
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
}

async function writeManifestVersion(version: string): Promise<void> {
  const manifest = await readManifest();
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Paths allowed in the published tarball. Anything else is a packaging bug. */
const ALLOWED = [/^dist\//, /^package\.json$/, /^README/i, /^LICENSE/i, /^CHANGELOG/i];

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                    */
/* -------------------------------------------------------------------------- */

const input = parseArgs(process.argv.slice(2));

const release = new Script<ReleaseInput>({
  name: "release",
  description: input.simulateFailure
    ? "Rollback rehearsal — local mutations only, publish always fails"
    : input.publish
      ? "Verify, package and publish to npm"
      : "Verify and package (dry run — nothing will be published)",
  rollback: "all",
})

  /* -- Preflight ---------------------------------------------------------- */
  .addPhase("Preflight", { description: "Everything that can fail cheaply, first" })
  .addStep({
    name: "read manifest",
    handler: async ({ log }) => {
      const manifest = await readManifest();
      if (manifest.private === true) throw new Error("package.json is marked private");
      const scoped = manifest.name.startsWith("@");
      if (scoped && manifest.publishConfig?.access !== "public") {
        throw new Error(
          `${manifest.name} is scoped, so npm defaults it to restricted. ` +
            `Add "publishConfig": { "access": "public" } to package.json.`,
        );
      }
      log(`${manifest.name}@${manifest.version}`);
      return { pkgName: manifest.name, previousVersion: manifest.version };
    },
  })
  .addStep({
    name: "authenticate npm",
    retry: { attempts: 2, delayMs: 500 },
    timeoutMs: 20_000,
    handler: async ({ input, signal, log, warn }) => {
      const user = await tryExec("npm", ["whoami"], { signal });
      if (!user) {
        // A dry run does not need credentials; a real publish does.
        if (input.publish) throw new Error("Not logged in to npm. Run `npm login` first.");
        warn("not logged in to npm — fine for a dry run, required to publish");
        return { npmUser: null as string | null };
      }
      log(`authenticated as ${user}`);
      return { npmUser: user as string | null };
    },
  })
  .addStep({
    name: "inspect git",
    when: ({ input }) => !input.skipGit,
    handler: async ({ input, signal, warn, log }) => {
      const branch = await tryExec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { signal });
      const head = await tryExec("git", ["rev-parse", "--short", "HEAD"], { signal });
      const status = await tryExec("git", ["status", "--porcelain"], { signal });
      const remote = await tryExec("git", ["remote"], { signal });
      const dirty = Boolean(status);

      if (dirty && input.publish) {
        throw new Error("Working tree is dirty — commit or stash before publishing");
      }
      if (dirty) warn("working tree is dirty (would block a real publish)");
      log(`${branch ?? "detached"} @ ${head ?? "unknown"}`);

      return {
        branch,
        head,
        dirty,
        hasRemote: Boolean(remote && remote.length > 0),
      };
    },
  })
  .addStep({
    name: "resolve version",
    handler: async ({ input, ctx, log }) => {
      const next = input.explicitVersion ?? bumpVersion(ctx.previousVersion, input.bump);
      if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(next)) {
        throw new Error(`"${next}" is not a valid semver version`);
      }
      log(
        next === ctx.previousVersion
          ? `releasing ${next} (no bump)`
          : `${ctx.previousVersion} → ${next}`,
      );
      return { nextVersion: next, tagName: `v${next}` };
    },
  })
  .addStep({
    name: "check registry",
    retry: { attempts: 3, delayMs: (attempt) => attempt * 400 },
    timeoutMs: 20_000,
    handler: async ({ ctx, signal, status, log }) => {
      status("querying registry");
      const published = await tryExec(
        "npm",
        ["view", `${ctx.pkgName}@${ctx.nextVersion}`, "version"],
        { signal },
      );
      if (published) {
        throw new Error(`${ctx.pkgName}@${ctx.nextVersion} is already published`);
      }
      const latest = await tryExec("npm", ["view", ctx.pkgName, "version"], { signal });
      log(latest ? `current latest is ${latest}` : "first publish of this package");
      return { previousPublished: latest };
    },
  })

  /* -- Verify ------------------------------------------------------------- */
  .addPhase("Verify", { description: "Nothing is mutated until this passes" })
  .addStep({
    name: "typecheck",
    timeoutMs: 180_000,
    handler: async ({ signal, status }) => {
      await exec("npx", ["tsc", "--noEmit"], { signal, cwd: root, onLine: status });
      return { typechecked: true };
    },
  })
  .addStep({
    name: "run tests",
    when: ({ input }) => !input.skipTests,
    timeoutMs: 300_000,
    handler: async ({ signal, status, log }) => {
      let passed = 0;
      const { stdout } = await exec(
        "node",
        ["--experimental-strip-types", "--test", "test/script.test.ts"],
        {
          signal,
          cwd: root,
          onLine: (line) => {
            if (line.startsWith("ok ")) {
              passed += 1;
              status(`${passed} passed`);
            }
          },
        },
      );
      const failed = Number(/^# fail (\d+)$/m.exec(stdout)?.[1] ?? 0);
      if (failed > 0) throw new Error(`${failed} test(s) failed`);
      log(`${passed} tests passed`);
      return { testsPassed: passed };
    },
  })

  /* -- Package ------------------------------------------------------------ */
  .addPhase("Package")
  .addStep({
    name: "write version",
    when: ({ input }) => mutatesLocally(input),
    handler: async ({ ctx }) => {
      await writeManifestVersion(ctx.nextVersion);
      return { versionWritten: ctx.nextVersion };
    },
    // Restore the version we found, so a later failure never leaves the
    // manifest claiming a release that did not happen.
    rollback: async ({ ctx, log }) => {
      await writeManifestVersion(ctx.previousVersion);
      log(`package.json version restored to ${ctx.previousVersion}`);
    },
  })
  .addStep({
    name: "clean dist",
    handler: async () => {
      await rm(path.join(root, "dist"), { recursive: true, force: true });
      return { cleaned: true };
    },
    // We removed the previous build output; putting it back means rebuilding.
    rollback: async ({ signal, log }) => {
      await exec("npx", ["tsc", "-p", "tsconfig.build.json"], { signal, cwd: root });
      log("dist rebuilt from source");
    },
  })
  .addStep({
    name: "build",
    timeoutMs: 180_000,
    handler: async ({ signal, status }) => {
      await exec("npx", ["tsc", "-p", "tsconfig.build.json"], { signal, cwd: root, onLine: status });
      return { built: true };
    },
  })
  .addStep({
    name: "verify artifacts",
    handler: async ({ tasks }) => {
      const checks = tasks(["entry js", "type declarations", "no source maps orphaned", "exports Script"]);

      const read = async (file: string): Promise<string | null> => {
        try {
          return await readFile(path.join(root, "dist", file), "utf8");
        } catch {
          return null;
        }
      };

      checks.get("entry js").start();
      const entry = await read("index.js");
      if (!entry) {
        checks.get("entry js").fail("dist/index.js is missing");
        throw new Error("dist/index.js was not emitted");
      }
      checks.get("entry js").succeed();

      checks.get("type declarations").start();
      const types = await read("index.d.ts");
      if (!types) {
        checks.get("type declarations").fail("dist/index.d.ts is missing");
        throw new Error("dist/index.d.ts was not emitted");
      }
      checks.get("type declarations").succeed();

      checks.get("no source maps orphaned").start();
      const map = await read("index.js.map");
      if (map) checks.get("no source maps orphaned").succeed();
      else checks.get("no source maps orphaned").skip("no maps");

      checks.get("exports Script").start();
      if (!/declare class Script|export declare class Script|Script/.test(types)) {
        checks.get("exports Script").fail();
        throw new Error("dist/index.d.ts does not export Script");
      }
      checks.get("exports Script").succeed();

      return { entryBytes: entry.length };
    },
  })
  .addStep({
    name: "audit tarball",
    timeoutMs: 120_000,
    handler: async ({ ctx, signal, progress, log }) => {
      const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], { signal, cwd: root });
      const parsed = JSON.parse(stdout) as Array<{
        filename?: string;
        size?: number;
        unpackedSize?: number;
        files?: Array<{ path: string; size: number }>;
      }>;
      const report = parsed[0];
      const files = report?.files ?? [];
      if (files.length === 0) throw new Error("npm pack produced an empty tarball");

      const bar = progress({ total: files.length, label: "auditing paths" });
      const unexpected: string[] = [];
      for (const file of files) {
        if (!ALLOWED.some((pattern) => pattern.test(file.path))) unexpected.push(file.path);
        bar.increment();
      }
      bar.done();

      if (unexpected.length > 0) {
        throw new Error(`Unexpected files in tarball: ${unexpected.slice(0, 5).join(", ")}`);
      }
      if (!files.some((file) => file.path === "dist/index.js")) {
        throw new Error("dist/index.js is not in the tarball — check the `files` field");
      }

      const kb = Math.round((report?.size ?? 0) / 102.4) / 10;
      log(`${files.length} files · ${kb}kB packed · ${ctx.pkgName}@${ctx.nextVersion}`);
      return { fileCount: files.length, packedBytes: report?.size ?? 0 };
    },
  })

  /* -- Publish ------------------------------------------------------------ */
  .addPhase("Publish")
  .addStep({
    name: "tag release",
    when: ({ input }) => mutatesLocally(input) && !input.skipGit,
    handler: async ({ ctx, signal }) => {
      await exec("git", ["tag", "-a", ctx.tagName, "-m", `${ctx.pkgName} ${ctx.nextVersion}`], {
        signal,
      });
      return { tagged: ctx.tagName };
    },
    rollback: async ({ output, log }) => {
      await exec("git", ["tag", "-d", output.tagged]);
      log(`deleted local tag ${output.tagged}`);
    },
  })
  .addStep({
    name: "push tag",
    when: ({ input, ctx }) => input.publish && !input.skipGit && ctx.hasRemote === true,
    handler: async ({ ctx, signal, status }) => {
      status(`pushing ${ctx.tagName}`);
      await exec("git", ["push", "origin", ctx.tagName], { signal });
      return { pushed: ctx.tagName };
    },
    rollback: async ({ output, log }) => {
      await exec("git", ["push", "origin", "--delete", output.pushed]);
      log(`deleted remote tag ${output.pushed}`);
    },
  })
  .addStep({
    name: "publish to npm",
    timeoutMs: 300_000,
    handler: async ({ input, ctx, signal, status, log, success }) => {
      if (input.simulateFailure) {
        throw new Error("simulated publish failure (--simulate-failure)");
      }

      const args = ["publish", "--access", "public", "--tag", input.distTag];
      if (!input.publish) args.push("--dry-run");

      status(input.publish ? "uploading" : "dry run");
      try {
        await exec("npm", args, { signal, cwd: root, onLine: status });
      } catch (error) {
        if (error instanceof ExecError && /E402|payment required/i.test(error.stderr)) {
          throw new Error("npm rejected the publish: scoped packages need --access public");
        }
        throw error;
      }

      if (!input.publish) {
        log("dry run complete — rerun with --publish to release for real");
        return { published: false, version: ctx.nextVersion };
      }
      success(`published ${ctx.pkgName}@${ctx.nextVersion} (${input.distTag})`);
      return { published: true, version: ctx.nextVersion };
    },
    // Last step, so this never fires today. It is the honest compensation if a
    // step is ever appended below: a published version cannot be recalled, only
    // deprecated.
    rollback: async ({ ctx, output, log }) => {
      if (!output.published) return;
      await exec("npm", [
        "deprecate",
        `${ctx.pkgName}@${ctx.nextVersion}`,
        "Released in error — do not use.",
      ]);
      log(`deprecated ${ctx.pkgName}@${ctx.nextVersion}`);
    },
  });

const result = await release.run(input);

if (!result.ok) {
  process.exitCode = 1;
} else if (!input.publish) {
  console.log(
    `\n  Dry run passed. Release for real with:\n` +
      `    npm run release -- --publish${input.bump === "none" ? "" : ` --bump ${input.bump}`}\n`,
  );
}
