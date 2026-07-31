/**
 * `logPlacement`: where log(), info(), warn(), error() and success() land.
 *
 * The same script runs three times, once per placement, so the difference is
 * visible directly rather than described:
 *
 *   "scrollback" (default) — a permanent line above the whole frame, in
 *                             order, for the entire run. The complete record.
 *   "step"                 — nested under the step that logged it, next to
 *                             its tasks and progress bar.
 *   "bottom"                — a rolling tail of the most recent lines, below
 *                             the whole phase tree.
 *
 * "step" and "bottom" both cap what they keep (the most recent few) — they
 * trade completeness for locality. Reach for "scrollback" when the log is
 * the thing you need to still have once the run is over.
 *
 *   npm run example:log-placement
 *
 * Only the live (TTY) renderer honours this — pipe the output and every
 * placement falls back to printing each line immediately, in place, since a
 * plain scrolling log has no other sensible behaviour.
 */
import { Script, type LogPlacement } from "../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(logPlacement: LogPlacement): Promise<void> {
  await new Script({ name: `logPlacement: "${logPlacement}"`, logPlacement })
    .addPhase("Warehouse")
    .addStep({
      name: "check stock",
      handler: async ({ log, status }) => {
        status("querying");
        await wait(150);
        log("warehouse A: 12 in stock");
        await wait(150);
        log("warehouse B: 3 in stock");
        return { available: 15 };
      },
    })
    .addPhase("Reserve")
    .addStep({
      name: "hold units",
      handler: async ({ ctx, info, success }) => {
        await wait(150);
        info(`holding ${ctx.available} units`);
        await wait(150);
        success("hold confirmed");
        return { held: ctx.available };
      },
      // Compensations log too — with "step" placement, this appears nested
      // under "hold units" even though it runs much later, on failure.
      rollback: async ({ log }) => {
        await wait(100);
        log("released the hold");
      },
    })
    .addPhase("Ship")
    .addStep({
      name: "dispatch",
      handler: async ({ warn }) => {
        await wait(150);
        warn("courier is running late");
        throw new Error("no courier available");
      },
    })
    .run();
}

for (const logPlacement of ["scrollback", "step", "bottom"] as const) {
  await run(logPlacement);
  console.log("");
}
