/**
 * Reusable steps, declared away from any particular script.
 *
 * `stepFor<In, Ctx>()` binds the *minimum* shape a step needs: the input it
 * reads and the context it expects to already exist. Inference is preserved,
 * so the handler's return type still flows into whichever script uses it — and
 * `addStep` refuses the step if that script has not produced `Ctx` yet.
 */
import { stepFor } from "../../dist/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Account {
  owner: string;
  plan: "free" | "pro";
}

/** Needs only `accountId` on the input, and nothing in the context. */
export const loadAccount = stepFor<{ accountId: string }>()({
  name: "load account",
  description: "Fetch the billing record",
  handler: async ({ input, note }) => {
    await wait(180);
    const account: Account = {
      owner: `${input.accountId}@example.com`,
      plan: input.accountId.endsWith("9") ? "pro" : "free",
    };
    note(account.plan);
    return { account };
  },
});

/** Needs an `account` in the context — whoever uses it must supply one. */
export const createTenant = stepFor<{ accountId: string }, { account: Account }>()({
  name: "create tenant",
  handler: async ({ ctx, status, note }) => {
    status(`provisioning for ${ctx.account.owner}`);
    await wait(320);
    const tenantId = `tnt_${ctx.account.plan}_41`;
    note(tenantId);
    return { tenantId };
  },
  // Creating a tenant is a real mutation, so it carries its own undo — and the
  // key that undo needs travels with the step, wherever it is dropped in.
  rollbackKeys: ["tenantId"],
  rollback: async ({ ctx, log }) => {
    await wait(140);
    log(`destroyed tenant ${ctx.tenantId}`);
  },
});

/** Needs the tenant the previous step made. */
export const seedDefaults = stepFor<{ accountId: string }, { tenantId: string; account: Account }>()({
  name: "seed defaults",
  handler: async ({ ctx, tasks }) => {
    const list = tasks(["roles", "billing profile", "sample project"]);
    for (const key of ["roles", "billing profile", "sample project"] as const) {
      const task = list.get(key);
      task.start();
      await wait(160);
      // Free plans get no sample project — the checklist says so out loud.
      if (key === "sample project" && ctx.account.plan === "free") {
        task.skip("pro only");
        continue;
      }
      task.succeed();
    }
    return { seeded: true };
  },
});
