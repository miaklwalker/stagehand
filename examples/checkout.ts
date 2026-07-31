/**
 * Saga semantics: `rollback`, `rollbackKeys` and `clean`.
 *
 * A checkout touches three systems that cannot be undone by a database
 * transaction — inventory, the payment gateway, the warehouse. Each step that
 * mutates something declares how to undo it, and the run unwinds in reverse
 * when a later step fails.
 *
 *   npm run example:checkout          watch it unwind
 *   npm run example:checkout -- --ok  the happy path
 */
import { Script } from "../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shouldFail = !process.argv.includes("--ok");

interface Order {
  customerId: string;
  items: Array<{ sku: string; qty: number }>;
  cardToken: string;
}

const checkout = new Script<Order>({
  name: "checkout",
  description: "Reserve stock, take payment, ship it",
  rollback: "all",
})
  .addPhase("Cart", { description: "Nothing here mutates anything" })
  .addStep({
    name: "price the cart",
    handler: async ({ input, note }) => {
      await wait(180);
      const units = input.items.reduce((sum, item) => sum + item.qty, 0);
      note(`${units} units`);
      // The card token lands in the context so a later step can consume it —
      // and so this example has something worth cleaning up afterwards.
      return { total: units * 24.5, units, cardToken: input.cardToken };
    },
  })

  .addPhase("Reserve")
  .addStep({
    name: "reserve inventory",
    handler: async ({ ctx, status, note }) => {
      status("holding stock");
      await wait(320);
      note(`${ctx.units} units held`);
      return { reservationId: "res_7741" };
    },
    // The compensation needs the id it created, so it asks for it.
    // From here on, no step is allowed to `clean` that key away.
    rollbackKeys: ["reservationId"],
    rollback: async ({ ctx, log }) => {
      await wait(160);
      log(`released reservation ${ctx.reservationId}`);
    },
  })

  .addPhase("Payment")
  .addStep({
    name: "authorize card",
    handler: async ({ ctx, status, note }) => {
      status("contacting gateway");
      await wait(420);
      note(`$${ctx.total.toFixed(2)} held`);
      return { authId: "auth_9c21" };
    },
    // The token has done its job — drop it from the context so no later step
    // (or the returned result) can carry it around. `output` is untouched, so
    // this step's own rollback still sees everything it returned.
    clean: ["cardToken"],
    rollbackKeys: ["authId"],
    rollback: async ({ ctx, log }) => {
      await wait(140);
      log(`voided authorization ${ctx.authId}`);
    },
  })
  .addStep({
    name: "capture payment",
    handler: async ({ ctx, note }) => {
      await wait(260);
      note(`$${ctx.total.toFixed(2)} captured`);
      return { chargeId: "ch_5518" };
    },
    rollbackKeys: ["chargeId"],
    rollback: async ({ ctx, log }) => {
      await wait(200);
      log(`refunded charge ${ctx.chargeId}`);
    },
  })

  .addPhase("Fulfil")
  .addStep({
    name: "create shipment",
    handler: async ({ status }) => {
      status("booking courier");
      await wait(300);
      if (shouldFail) throw new Error("courier API rejected the address");
      return { shipmentId: "shp_3390" };
    },
  });

const result = await checkout.run({
  customerId: "cus_1",
  items: [
    { sku: "keyboard", qty: 1 },
    { sku: "cable", qty: 2 },
  ],
  cardToken: "tok_live_do_not_log_me",
});

if (result.ok) {
  console.log(`\n  shipped ${result.ctx.shipmentId} for $${result.ctx.total.toFixed(2)}\n`);
} else {
  // Everything that succeeded has been compensated, newest first.
  console.log(`\n  unwound: ${result.rollbacks.map((entry) => entry.step).join(" → ")}`);
  process.exitCode = 1;
}

// Either way the token is gone — from the type and from the object.
console.log(`  cardToken in result.ctx: ${"cardToken" in result.ctx}\n`);
