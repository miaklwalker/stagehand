import assert from "node:assert/strict";
import test from "node:test";

import { Script, stepFor } from "../dist/index.js";
import type { WithStepFor } from "../dist/types.js";

const quiet = { silent: true, handleSignals: false } as const;

interface Input {
  channel: string;
}

/**
 * `WithStepFor` is a type. Most of what is worth checking is checked by `tsc`
 * on this file — `Expect<A, B>` resolves to `never` on a mismatch, so the
 * `= true` beside it stops compiling. The runtime test at the bottom is there
 * to prove the type agrees with what the script actually builds.
 */
type Expect<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const logIntoDb = stepFor<Input>()({
  name: "log into db",
  handler: () => ({ conn: { id: 1 }, token: "t" }),
});

const loadRows = stepFor<Input>()({ name: "load rows", handler: () => ({ rows: [1, 2, 3] }) });

const asyncStep = stepFor<Input>()({ name: "async", handler: async () => ({ fetched: true }) });

const voidStep = stepFor<Input>()({ name: "void", handler: () => {} });

const compensating = stepFor<Input>()({
  name: "compensating",
  handler: () => ({ handle: "h" }),
  rollbackKeys: ["handle"],
  rollback: ({ output }) => {
    void output.handle;
  },
});

const needsContext = stepFor<Input, { user: { id: string } }>()({
  name: "needs context",
  handler: ({ ctx }) => ({ userId: ctx.user.id }),
});

/* -------------------------------------------------------------------------- */
/* Type assertions                                                             */
/* -------------------------------------------------------------------------- */

/** The step's output, merged over whatever else the context already holds. */
const _basic: Expect<
  WithStepFor<typeof logIntoDb, { conditions: Array<{ name: string }> }>,
  { conditions: Array<{ name: string }>; conn: { id: number }; token: string }
> = true;

/** `Rest` defaults to nothing, leaving just the step's own output. */
const _bare: Expect<WithStepFor<typeof loadRows>, { rows: number[] }> = true;

/** Nesting composes, innermost first. */
const _nested: Expect<
  WithStepFor<typeof loadRows, WithStepFor<typeof logIntoDb, { rest: boolean }>>,
  { rest: boolean; conn: { id: number }; token: string; rows: number[] }
> = true;

/** Three deep, to be sure it is not a one-level trick. */
const _deep: Expect<
  WithStepFor<
    typeof loadRows,
    WithStepFor<typeof compensating, WithStepFor<typeof logIntoDb, { rest: boolean }>>
  >,
  { rest: boolean; conn: { id: number }; token: string; handle: string; rows: number[] }
> = true;

/** An async handler is awaited, not left as a promise. */
const _async: Expect<
  WithStepFor<typeof asyncStep, { rest: boolean }>,
  { rest: boolean; fetched: boolean }
> = true;

/** A step returning nothing contributes nothing. */
const _void: Expect<WithStepFor<typeof voidStep, { rest: boolean }>, { rest: boolean }> = true;

/** `Out` also sits in `rollback`'s parameter; extraction still works. */
const _rollback: Expect<
  WithStepFor<typeof compensating, { rest: boolean }>,
  { rest: boolean; handle: string }
> = true;

/** Only the output is read — the step's own `Ctx` requirement is not folded in. */
const _outputOnly: Expect<
  WithStepFor<typeof needsContext, { rest: boolean }>,
  { rest: boolean; userId: string }
> = true;

/** On a collision the outermost step wins, as the last one to run would. */
const shadow = stepFor<Input>()({ name: "shadow", handler: () => ({ token: 42 }) });
const _shadowed: Expect<
  WithStepFor<typeof shadow, WithStepFor<typeof logIntoDb, {}>>,
  { conn: { id: number }; token: number }
> = true;

/** The point of the whole thing: it feeds the next `stepFor` without restating. */
const downstream = stepFor<Input, WithStepFor<typeof logIntoDb, { conditions: string[] }>>()({
  name: "downstream",
  handler: ({ ctx }) => ({ summary: `${ctx.conn.id}:${ctx.token}:${ctx.conditions.length}` }),
});

void [
  _basic,
  _bare,
  _nested,
  _deep,
  _async,
  _void,
  _rollback,
  _outputOnly,
  _shadowed,
];

/* -------------------------------------------------------------------------- */
/* Runtime agreement                                                           */
/* -------------------------------------------------------------------------- */

test("a step typed through WithStepFor sees the context the type promised", async () => {
  const seed = stepFor<Input>()({
    name: "seed",
    handler: ({ input }) => ({ conditions: [input.channel] }),
  });

  const result = await new Script<Input>(quiet)
    .addPhase("Run")
    .addStep(seed)
    .addStep(logIntoDb)
    .addStep(downstream)
    .run({ channel: "alpha" });

  assert.ok(result.ok);
  assert.equal(result.ctx.summary, "1:t:1");
});
