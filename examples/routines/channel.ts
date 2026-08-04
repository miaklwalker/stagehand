/**
 * A reusable fragment: everything needed to pull a sales channel down and
 * normalize it, declared away from any particular script.
 *
 * `routineFor<In, Ctx>()` binds the *minimum* the fragment needs — the input it
 * reads, and the context it expects to already exist — exactly as `stepFor`
 * does for a single step. Whatever it produces flows on into whichever script
 * mounts it.
 */
import { fileStore, routineFor } from "../../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Order {
  id: string;
  total: number;
  channel: string;
}

/** What the routine needs. A mount either offers this, or maps to it. */
export interface ChannelInput {
  channel: string;
  since: string;
  apiKey: string;
}

const cache = fileStore("./.stagehand-cache.json");

/**
 * Needs `channel` and `since` on the input, and nothing in the context.
 *
 * The Fetch phase caches, so the second script to mount this routine gets the
 * data the first one already pulled — which is the whole point of hoisting it
 * out of the sync script in the first place.
 */
export const pullChannel = routineFor<ChannelInput>()(
  "pull channel",
  (script) =>
    script
      .addPhase("Fetch", {
        cache: {
          store: cache,
          // A pull is good for an hour, and only for the window it covered.
          stale: ({ value, input, ageMs }) =>
            ageMs > 3_600_000 || (value as { since?: string }).since !== input.since,
        },
      })
      .addStep({
        name: "authenticate",
        handler: async ({ input, note }) => {
          await wait(180);
          // Each mount brings its own key, so the same routine can pull two
          // storefronts in one run without either knowing about the other.
          note(`${input.channel} · ${input.apiKey.slice(0, 6)}…`);
          return { token: `tok_${input.apiKey}` };
        },
      })
      .addStep({
        name: "pull orders",
        handler: async ({ input, progress, note }) => {
          const bar = progress({ total: 240, label: "downloading" });
          const orders: Order[] = [];
          for (let i = 0; i < 240; i += 1) {
            orders.push({ id: `o_${i}`, total: 5 + (i % 40), channel: input.channel });
            if (i % 20 === 0) {
              bar.update(i);
              await wait(14);
            }
          }
          bar.done();
          note(`${orders.length} orders`);
          return { orders, since: input.since };
        },
      })

      .addPhase("Normalize")
      .addStep({
        name: "dedupe and total",
        clean: ["token"],
        handler: async ({ ctx, tasks }) => {
          const list = tasks(["dedupe", "convert currency", "sum"]);
          for (const key of ["dedupe", "convert currency", "sum"] as const) {
            const task = list.get(key);
            task.start();
            await wait(160);
            task.succeed();
          }
          const gross = ctx.orders.reduce((sum, order) => sum + order.total, 0);
          return { orderCount: ctx.orders.length, gross };
        },
      }),
);
