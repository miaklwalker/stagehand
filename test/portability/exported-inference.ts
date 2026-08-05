/**
 * Fixture for the declaration-emit portability guard in
 * `../portability.test.ts`. Nothing here runs.
 *
 * Every value is exported with an *inferred* type, so emitting declarations
 * for this project forces `tsc` to write each one down, naming every type that
 * reaches a public signature.
 *
 * The import is by package name, the way a consumer writes it. That is not
 * quite enough on its own: from inside the repo the emitter can still reach a
 * non-exported type over a relative path (`../../dist/script.js`), so it does,
 * and no TS2742 is raised here. That relative path is precisely what becomes
 * `node_modules/@michaelrwalker/stagehand/dist/script.js` downstream, where the
 * `exports` map makes it unreachable and the consumer's build breaks. So the
 * test asserts on the *specifiers* in the emitted `.d.ts`, not merely on `tsc`
 * exiting zero: anything named through a path other than the package root is
 * a type missing from `src/index.ts`.
 */

import { memoryStore, routineFor, script, stepFor } from "@michaelrwalker/stagehand";
import type { WithStepFor } from "@michaelrwalker/stagehand";

/** Bare routine — names `Routine` and `Commit`. */
export const bare = routineFor<{ channel: string }>()("bare", (s) =>
  s
    .addPhase("Fetch")
    .addStep({ name: "authenticate", handler: ({ input }) => ({ token: `t_${input.channel}` }) }),
);

/** Cached phase — `Commit` folds a real slot in, so `SlotValue` shows up too. */
export const cached = routineFor<{ channel: string }>()("cached", (s) =>
  s
    .addPhase("Fetch", { cache: { store: memoryStore() } })
    .addStep({ name: "pull", handler: () => ({ orders: [{ sku: "a" }] }) }),
);

/** Routine mounting a routine — adds `Mounted` and a nested `Commit`. */
export const composed = routineFor<{ channel: string }>()("composed", (s) =>
  s
    .use(bare, { as: "Upstream" })
    .addPhase("Normalize")
    .addStep({ name: "dedupe", handler: ({ ctx }) => ({ tokenLength: ctx.token.length }) }),
);

/** A routine requiring upstream context — `In`/`Ctx` both non-trivial. */
export const needsContext = routineFor<{ channel: string }, { hash: string }>()("verify", (s) =>
  s
    .addPhase("Verify")
    .addStep({ name: "compare", handler: ({ ctx }) => ({ verified: ctx.hash.length > 0 }) }),
);

/** A plain script — names `Script` and `ClosedPhase`. */
export const plain = script<{ channel: string }>("plain")
  .addPhase("Go")
  .addStep({ name: "run", handler: () => ({ done: true }) });

/** A script that mounts a routine — the `use()` overload's slot math, emitted. */
export const mounting = script<{ channel: string }>("mounting")
  .use(bare, { as: "Fragment" })
  .addPhase("After")
  .addStep({ name: "report", handler: ({ ctx }) => ({ reported: ctx.token }) });

/** A standalone step — names `StepDef`. */
export const standalone = stepFor<{ channel: string }>()({
  name: "standalone",
  handler: ({ input }) => ({ conn: { id: input.channel } }),
});

/** A step whose context came from `WithStepFor` — the merged shape gets emitted. */
export const chained = stepFor<
  { channel: string },
  WithStepFor<typeof standalone, { conditions: string[] }>
>()({
  name: "chained",
  handler: ({ ctx }) => ({ summary: `${ctx.conn.id}:${ctx.conditions.length}` }),
});
