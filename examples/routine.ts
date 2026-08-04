/**
 * One reusable fragment, mounted by two scripts written months apart.
 *
 *   npm run example:routine
 *   npm run example:routine -- --multi   the same routine mounted twice
 *
 * The fetch pipeline lives in ./routines/channel.ts and knows nothing about
 * either script below. The report script mounts it and — because the routine's
 * Fetch phase caches — pays nothing to get the data the sync script pulled.
 *
 * Delete ./.stagehand-cache.json to watch the second script do the work.
 */
import { Script } from "../dist/index.js";
import { pullChannel } from "./routines/channel.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const multi = process.argv.includes("--multi");

/* -- Script one: the nightly sync, written first --------------------------- */

const sync = new Script<{ channel: string; since: string; apiKey: string; strict: boolean }>({
  name: "channel sync",
  description: "Pull a channel and check it over",
})
  // The host's input already has everything the routine reads, so it mounts
  // as-is — no mapping needed.
  .use(pullChannel)
  .addPhase("Validation")
  .addStep({
    name: "check totals",
    // `orderCount` and `gross` came from the routine, fully typed.
    handler: async ({ ctx, input, warn, success }) => {
      await wait(220);
      if (input.strict && ctx.gross <= 0) warn("gross is zero — check the window");
      success(`${ctx.orderCount} orders, ${ctx.gross} gross`);
      return { validated: true };
    },
  });

await sync.run({
  channel: "amazon",
  since: "2026-07-01",
  apiKey: "amzn_live_8f2c",
  strict: true,
});

/* -- Script two: the report a manager asked for weeks later ---------------- */

const report = new Script<{ month: string; credentials: Record<string, string> }>({
  name: "monthly report",
  description: "The same pull, a completely different job",
})
  // This script's input looks nothing like the routine's, so the mount maps
  // one onto the other. Resolved once, when the mount is reached.
  .use(pullChannel, {
    input: ({ input }) => ({
      channel: "amazon",
      since: `${input.month}-01`,
      apiKey: input.credentials.amazon ?? "",
    }),
  })
  .addPhase("Report")
  .addStep({
    name: "build summary",
    handler: async ({ ctx, input, note }) => {
      await wait(260);
      const average = (ctx.gross / ctx.orderCount).toFixed(2);
      note(`avg ${average}`);
      return { line: `${input.month}: ${ctx.orderCount} orders, ${ctx.gross} gross` };
    },
  });

const built = await report.run({
  month: "2026-07",
  credentials: { amazon: "amzn_live_8f2c", shopify: "shop_live_41ab" },
});

if (built.ok) console.log(`\n  ${built.ctx.line}\n`);
else process.exitCode = 1;

/* -- Two storefronts, one routine, mounted twice --------------------------- */

if (multi) {
  // Phase names have to stay unique — `as` prefixes them, which also keeps the
  // two mounts on their own cache entries.
  const both = new Script<{ since: string; amazonKey: string; shopifyKey: string }>({
    name: "all channels",
    description: "The same routine, once per storefront",
  })
    // `as` keeps the phase names — and so the cache slots — apart; `input`
    // gives each mount its own channel and credentials.
    .use(pullChannel, {
      as: "Amazon",
      input: ({ input }) => ({
        channel: "amazon",
        since: input.since,
        apiKey: input.amazonKey,
      }),
    })
    .use(pullChannel, {
      as: "Shopify",
      input: ({ input }) => ({
        channel: "shopify",
        since: input.since,
        apiKey: input.shopifyKey,
      }),
    })
    .addPhase("Combine")
    .addStep({
      name: "merge",
      handler: async ({ ctx, success }) => {
        await wait(200);
        success(`${ctx.orderCount} orders after the last mount`);
        return { merged: true };
      },
    });

  await both.run({
    since: "2026-07-01",
    amazonKey: "amzn_live_8f2c",
    shopifyKey: "shop_live_41ab",
  });
}
