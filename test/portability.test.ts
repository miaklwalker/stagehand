import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

const PROJECT = "test/portability";
const EMITTED = new URL("../.portability-check/exported-inference.d.ts", import.meta.url);

/** Every `import("…")` the emitter wrote, deduped. */
function specifiers(declarations: string): string[] {
  const found = declarations.matchAll(/import\("([^"]+)"\)/g);
  return [...new Set([...found].map((match) => match[1] as string))].sort();
}

test("every inferred public type is nameable from the package root", async () => {
  await rm(new URL("../.portability-check/", import.meta.url), { recursive: true, force: true });

  // Emitting is half the check: a type the emitter cannot name at all fails
  // here outright, with TS2742.
  await run("node_modules/.bin/tsc", ["-p", PROJECT], { cwd: root, maxBuffer: 8 * 1024 * 1024 });

  // The other half. From inside the repo the emitter can still reach a
  // non-exported type over a relative path into dist/, which downstream
  // resolves to a subpath the `exports` map does not publish. Only the package
  // name is portable.
  const emitted = await readFile(EMITTED, "utf8");
  const used = specifiers(emitted);

  assert.notEqual(used.length, 0, "fixture emitted no type references — it is no longer a guard");
  assert.deepEqual(
    used,
    ["@michaelrwalker/stagehand"],
    "a type reaching an inferred public signature is not re-exported from src/index.ts",
  );
});
