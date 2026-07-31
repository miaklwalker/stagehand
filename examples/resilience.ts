/**
 * Everything that governs how long a step is allowed to take, and how often it
 * gets to try: `retry`, `retryIf`, `timeoutMs`, and cancellation.
 *
 *   npm run example:resilience              retries, then succeeds
 *   npm run example:resilience -- --timeout a step that hangs past timeoutMs
 *   npm run example:resilience -- --fatal   retryIf refuses to retry
 *   npm run example:resilience -- --cancel  an external signal, mid-run
 */
import { Script, StepTimeoutError, isAbort } from "../dist/index.js";

const mode = {
  timeout: process.argv.includes("--timeout"),
  fatal: process.argv.includes("--fatal"),
  cancel: process.argv.includes("--cancel"),
};

/**
 * A sleep that loses the race when the step is aborted. Handlers get a
 * `signal` that fires on timeout, on Ctrl-C, and on an external cancel — real
 * work (fetch, child processes, database drivers) should be handed the same
 * signal so a cancelled step stops immediately instead of running to
 * completion in the background.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

let connectAttempts = 0;

const job = new Script({ name: "resilience", description: "Retries, timeouts and cancellation" })
  .addPhase("Connect")
  .addStep({
    name: "reach the API",
    // Four tries, backing off 200ms, 400ms, 600ms. `attempt` is 1-based, and
    // the frame shows "(retry n)" while it is happening.
    retry: {
      attempts: 4,
      delayMs: (attempt) => attempt * 200,
      // A 400 will never succeed on a retry, so do not waste the attempts.
      retryIf: (error) => !/^4\d\d/.test((error as Error).message),
    },
    handler: async ({ signal, attempt, warn, note }) => {
      connectAttempts = attempt;
      await sleep(150, signal);
      if (mode.fatal) throw new Error("401 unauthorized — token is not valid");
      if (attempt < 3) {
        warn(`attempt ${attempt}: 503 from the load balancer`);
        throw new Error("503 service unavailable");
      }
      note(`connected on attempt ${attempt}`);
      return { session: "sess_a91" };
    },
  })

  .addPhase("Work")
  .addStep({
    name: "run the report",
    // A step that outlives this budget is aborted with StepTimeoutError. The
    // signal fires first, so a well-behaved handler stops on its own.
    timeoutMs: 800,
    handler: async ({ signal, progress, note }) => {
      const total = mode.timeout ? 40 : 12;
      const bar = progress({ total, label: "aggregating" });
      for (let i = 0; i < total; i += 1) {
        await sleep(50, signal);
        bar.increment();
      }
      bar.done();
      note(`${total * 100} rows`);
      return { rows: total * 100 };
    },
    rollbackKeys: ["rows"],
    rollback: async ({ ctx, log }) => {
      log(`dropped the ${ctx.rows}-row scratch table`);
    },
  })
  .addStep({
    name: "upload results",
    handler: async ({ ctx, signal, status }) => {
      status(`sending ${ctx.rows} rows`);
      await sleep(mode.cancel ? 5_000 : 200, signal);
      return { uploaded: true };
    },
  });

// --cancel pulls the plug from outside, the same way a parent process or an
// HTTP request abort would. The interrupted step fails, and every step that
// had already finished still compensates on the way out.
const controller = new AbortController();
if (mode.cancel) setTimeout(() => controller.abort(), 2_200);

const result = await job.run(undefined, { signal: controller.signal });

console.log("");
if (result.ok) {
  console.log(`  done in ${Math.round(result.durationMs)}ms after ${connectAttempts} connect attempts\n`);
} else {
  const why = result.error instanceof StepTimeoutError
    ? `timed out after ${result.error.timeoutMs}ms`
    : isAbort(result.error)
      ? "cancelled from outside"
      : (result.error as Error).message;
  console.log(`  stopped at "${result.failedAt?.step}": ${why}\n`);
  process.exitCode = 1;
}
