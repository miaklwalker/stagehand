/**
 * Typed input from a schema, and the whole handler UI surface.
 *
 * `defineInput` takes any Standard Schema validator — Zod, Valibot, ArkType,
 * Effect Schema. This file hand-rolls one in ~20 lines to keep the example
 * dependency-free and to show there is no magic: the spec is one method.
 *
 *   npm run example:intake              a clean import
 *   npm run example:intake -- --bad     input the schema rejects
 *   npm run example:intake -- --dirty   rows that fail validation
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { SchemaValidationError, Script } from "../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dirty = process.argv.includes("--dirty");
const bad = process.argv.includes("--bad");

interface Feed {
  source: string;
  rows: number;
}

/** The entire Standard Schema contract: a `~standard.validate` method. */
const feedSchema: StandardSchemaV1<unknown, Feed> = {
  "~standard": {
    version: 1,
    vendor: "hand-rolled",
    validate: (value) => {
      const input = value as Partial<Feed>;
      const issues: Array<{ message: string; path: [string] }> = [];
      if (typeof input?.source !== "string" || input.source === "") {
        issues.push({ message: "must be a non-empty string", path: ["source"] });
      }
      if (typeof input?.rows !== "number" || input.rows <= 0) {
        issues.push({ message: "must be a positive number", path: ["rows"] });
      }
      return issues.length > 0
        ? { issues }
        : { value: { source: input.source as string, rows: input.rows as number } };
    },
  },
};

const intake = new Script({ name: "intake", description: "Pull a feed, clean it, load it" })
  // Call this first: `In` is inferred from the schema, and run() validates
  // before a single step executes.
  .defineInput(feedSchema)

  // The callback form of addPhase keeps the type flow while grouping steps.
  .addPhase("Fetch", (script) =>
    script
      .addStep({
        name: "open the feed",
        handler: async ({ input, status, info }) => {
          //             ^ input is { source: string; rows: number }
          status(`connecting to ${input.source}`);
          await wait(200);
          info(`feed ${input.source} is reachable`);
          return { endpoint: `https://feeds.example/${input.source}.ndjson` };
        },
      })
      .addStep({
        name: "download rows",
        handler: async ({ input, progress, note }) => {
          // A progress bar, relabelled as it goes.
          const bar = progress({ total: input.rows, label: "streaming" });
          for (let read = 0; read < input.rows; read += 25) {
            bar.update(read, read > input.rows / 2 ? "buffering" : "streaming");
            await wait(20);
          }
          bar.done();
          note(`${input.rows} rows`);
          return { raw: input.rows };
        },
      }),
  )

  .addPhase("Validate")
  .addStep({
    name: "check the batch",
    handler: async ({ ctx, tasks, status, warn, note }) => {
      // A whole checklist at once, keyed for typed lookup.
      const checks = tasks(["schema", "duplicates", "required fields", "encoding"]);

      for (const key of ["schema", "duplicates", "required fields", "encoding"] as const) {
        const check = checks.get(key);
        check.start();
        status(key);
        await wait(220);
        if (dirty && key === "required fields") {
          check.fail("18 rows missing an id");
          warn("18 rows will be quarantined");
          continue;
        }
        check.succeed();
      }

      const rejected = dirty ? 18 : 0;
      note(rejected === 0 ? "all rows valid" : `${rejected} quarantined`);
      return { clean: ctx.raw - rejected, rejected };
    },
  })

  .addPhase("Load")
  .addStep({
    name: "write to warehouse",
    // Skipped entirely when there is nothing left to write.
    when: ({ ctx }) => ctx.clean > 0,
    handler: async ({ ctx, progress, success, note }) => {
      const bar = progress({ total: ctx.clean, label: "inserting" });
      for (let done = 0; done < ctx.clean; done += 40) {
        bar.update(done);
        await wait(25);
      }
      bar.done();
      note(`${ctx.clean} rows loaded`);
      success(`warehouse is ${ctx.clean} rows heavier`);
      return { loaded: ctx.clean };
    },
  });

// --bad exercises the validator: run() throws before any step starts.
const input = bad ? ({ source: "", rows: -3 } as unknown as Feed) : { source: "orders", rows: 400 };

try {
  const result = await intake.run(input);
  if (result.ok) {
    console.log(`\n  loaded ${result.ctx.loaded} of ${result.ctx.raw} rows\n`);
  } else {
    process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof SchemaValidationError)) throw error;
  // Every issue, with its path — nothing ran.
  console.error(`\n  input rejected: ${error.message}\n`);
  process.exitCode = 1;
}
