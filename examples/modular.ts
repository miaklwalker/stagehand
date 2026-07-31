/**
 * Steps split across files, reused by two different scripts.
 *
 * The steps live in ./steps/tenancy.ts and know nothing about either script
 * below. Each script assembles them with its own inline steps, and the context
 * type is threaded through both the same way.
 *
 *   npm run example:modular
 *   npm run example:modular -- --fail   the shared rollback, borrowed
 */
import { Script } from "../dist/index.js";
import { createTenant, loadAccount, seedDefaults } from "./steps/tenancy.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shouldFail = process.argv.includes("--fail");

/* -- Script one: a normal signup ------------------------------------------ */

const signup = new Script<{ accountId: string; sendEmail: boolean }>({
  name: "signup",
  description: "Provision a brand new account",
})
  .addPhase("Account")
  .addStep(loadAccount)
  .addPhase("Provision")
  .addStep(createTenant)
  .addStep(seedDefaults)
  .addPhase("Notify")
  .addStep({
    name: "send welcome email",
    // Inline steps and imported ones mix freely, and `ctx` here knows about
    // everything the imported steps returned.
    when: ({ input }) => input.sendEmail,
    handler: async ({ ctx, success }) => {
      await wait(150);
      success(`welcomed ${ctx.account.owner} on ${ctx.tenantId}`);
      return { emailed: true };
    },
  });

const first = await signup.run({ accountId: "acct_119", sendEmail: true });
console.log(first.ok ? `\n  ${first.ctx.tenantId} is live\n` : "");

/* -- Script two: the same steps, a different job -------------------------- */

const migrate = new Script<{ accountId: string; fromRegion: string }>({
  name: "migrate",
  description: "Re-provision an account in a new region",
})
  .addPhase("Prepare")
  .addStep(loadAccount)
  .addStep({
    name: "snapshot old region",
    handler: async ({ input, status, note }) => {
      status(`draining ${input.fromRegion}`);
      await wait(240);
      note(`${input.fromRegion} frozen`);
      return { snapshotId: "snp_88" };
    },
    rollbackKeys: ["snapshotId"],
    rollback: async ({ ctx, log }) => {
      log(`thawed ${ctx.snapshotId}`);
    },
  })
  .addPhase("Provision")
  // Same imported step, same rollback — it compensates here too.
  .addStep(createTenant)
  .addStep({
    name: "restore snapshot",
    handler: async ({ ctx, progress }) => {
      const bar = progress({ total: 60, label: `into ${ctx.tenantId}` });
      for (let i = 0; i <= 60; i += 6) {
        bar.update(i);
        await wait(30);
      }
      bar.done();
      if (shouldFail) throw new Error("checksum mismatch on restore");
      return { restored: true };
    },
  });

const second = await migrate.run({ accountId: "acct_204", fromRegion: "us-east-1" });

if (second.ok) {
  console.log(`\n  migrated to ${second.ctx.tenantId}\n`);
} else {
  console.log(`\n  unwound: ${second.rollbacks.map((entry) => entry.step).join(" → ")}\n`);
  process.exitCode = 1;
}
