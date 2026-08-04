/**
 * Reaching the cache from inside a step.
 *
 *   npm run example:invalidate            pull, or reuse an earlier pull
 *   npm run example:invalidate -- --patch correct a value without refetching
 *   npm run example:invalidate -- --drop  throw the entry away
 *   npm run example:invalidate -- --drift read a field an older entry never had
 *
 * The cache lands in ./.stagehand-invalidate.json — delete it to start over.
 *
 * Run it once to pay for the pull, then again to watch Fetch come back cached.
 * `--patch` and `--drop` are the two ways a later step can act on that entry:
 * correct it in place, or admit it is beyond saving.
 */
import { CacheShapeError, Script, fileStore } from "../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flag = (name: string) => process.argv.includes(`--${name}`);

const cache = fileStore("./.stagehand-invalidate.json");

interface Order {
  id: string;
  sku: string;
  qty: number;
}

// An entry written before `discountApplied` existed — exactly what you inherit
// when a cache outlives the code that wrote it.
if (flag("drift")) {
  await cache.write("Fetch", {
    value: { orders: [{ id: "o_1", sku: "SKU-1", qty: 3 }] },
    savedAt: Date.now() - 20 * 60_000,
  });
}

const sync = new Script<{ channel: string }>({
  name: "stock sync",
  description: "Pull once, then correct or discard the entry from a later step",
})
  .addPhase("Fetch", { cache: { store: cache } })
  .addStep({
    name: "pull orders",
    handler: async ({ input, progress, note }) => {
      const bar = progress({ total: 120, label: "downloading" });
      const orders: Order[] = [];
      for (let i = 0; i < 120; i += 1) {
        orders.push({ id: `o_${i}`, sku: `SKU-${i % 8}`, qty: 1 + (i % 5) });
        if (i % 10 === 0) {
          bar.update(i);
          await wait(18);
        }
      }
      bar.done();
      note(`${orders.length} from ${input.channel}`);
      return { orders, discountApplied: false };
    },
  })

  .addPhase("Adjust")
  .addStep({
    name: "reconcile stock",
    handler: async ({ ctx, cache, log, warn, note, success }) => {
      await wait(200);

      // `cache` is typed to the phases cached above this step. "Fetch" is a
      // slot; "Adjust" is not, and neither is a name that no longer exists.
      const age = await cache.ageOf("Fetch");
      note(age === undefined ? "fresh pull" : `entry ${Math.round(age / 1000)}s old`);

      if (flag("drift")) {
        const stored = await cache.read("Fetch");
        try {
          // Typed as boolean — today's step returns it. The stored entry
          // predates it, so the guard throws right here rather than letting
          // `undefined` travel into the report.
          if (stored?.discountApplied) log("discount already applied");
          warn("expected the old entry to be caught, and it was not");
        } catch (error) {
          if (!(error instanceof CacheShapeError)) throw error;
          warn(`${error.name}: ${error.path} is missing from "${error.slot}"`);
          await cache.clear("Fetch");
          success("dropped the stale entry — the next run repulls");
        }
        return {};
      }

      if (flag("patch")) {
        // A correction that costs nothing: rewrite the entry, keep the pull.
        const corrected = ctx.orders.map((order) =>
          order.sku === "SKU-1" ? { ...order, qty: 0 } : order,
        );
        // keepAge holds the original savedAt. Correcting a value is not the
        // same as refreshing it, and restamping would quietly buy another full
        // TTL for data that is exactly as old as it was a moment ago.
        await cache.write(
          "Fetch",
          { orders: corrected, discountApplied: ctx.discountApplied },
          { keepAge: true },
        );
        success("patched SKU-1 to 0 in the cache — no refetch, age unchanged");
        return { corrected: true };
      }

      if (flag("drop")) {
        await cache.clear("Fetch");
        success("entry dropped — the next run pulls again");
        return { corrected: false };
      }

      log("nothing to reconcile; pass --patch, --drop or --drift");
      return { corrected: false };
    },
  })

  .addPhase("Report")
  .addStep({
    name: "summarise",
    handler: async ({ ctx, note }) => {
      await wait(160);
      const units = ctx.orders.reduce((sum, order) => sum + order.qty, 0);
      note(`${units} units`);
      return { units };
    },
  });

const result = await sync.run({ channel: "amazon" });

if (result.ok) {
  console.log(`\n  ${result.ctx.orders.length} orders, ${result.ctx.units} units\n`);
} else {
  process.exitCode = 1;
}
