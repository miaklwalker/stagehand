
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import { Script } from "../dist/index.js";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;



/** Run a command, returning stdout. Throws with stderr attached on failure. */
async function sh(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(command, args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string; message: string };
    const detail = (shell.stderr || shell.stdout || shell.message).trim().split("\n");
    throw new Error(`${command} ${args.join(" ")}\n${detail.slice(-12).join("\n")}`);
  }
}



const preflight = new Script({
  name: "preflight",
  description: "Everything that must hold before a release",
  // A check that fails should report, not unwind — nothing here mutates.
  rollback: "none",
})
  .addPhase("Quality")
  .addStep({
    name: "typecheck",
    handler: async ({ tasks, status }) => {
      // Split rather than calling `npm run typecheck`, so a failure points at
      // which of the three projects broke.
      const projects = [
        { label: "library", args: ["--noEmit", "-p", "tsconfig.json"] },
        { label: "examples", args: ["--noEmit", "-p", "examples"] },
        { label: "tests", args: ["--noEmit", "-p", "test"] },
        { label: "scripts", args: ["--noEmit", "-p", "scripts"] },
      ] as const;
      const list = tasks(projects.map((p) => p.label));

      for (const project of projects) {
        const task = list.get(project.label);
        task.start();
        status(project.label);
        try {
          await sh("./node_modules/.bin/tsc", [...project.args]);
        } catch (error) {
          task.fail();
          throw error;
        }
        task.succeed();
      }
      return { projects: projects.length };
    },
  })
  .addStep({
    name: "tests",
    clean: ["projects"],
    handler: async ({ note, status }) => {
      // Read the directory rather than listing files: a new test file should
      // be picked up by the release gate without anyone remembering to add it.
      const files = (await readdir(`${root}test`))
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => `test/${name}`)
        .sort();
      if (files.length === 0) throw new Error("no test files found");
      status(`${files.length} files`);

      // TAP explicitly: the default reporter's shape depends on Node version
      // and on whether stdout is a TTY, and this parses its output.
      const output = await sh("node", [
        "--experimental-strip-types",
        "--test",
        "--test-reporter=tap",
        ...files,
      ]);

      const pass = /^# pass (\d+)$/m.exec(output)?.[1];
      const fail = /^# fail (\d+)$/m.exec(output)?.[1];
      if (pass === undefined || fail === undefined) {
        throw new Error("could not read a pass/fail count from the test output");
      }
      if (Number(fail) > 0) throw new Error(`${fail} failing test(s)`);
      note(`${pass} passing in ${files.length} files`);
      return { pass: Number(pass), files: files.length };
    },
  })
const result = await preflight.run();

if (!result.ok) {
  console.error("\n  preflight failed — nothing was released\n");
  process.exitCode = 1;
}
