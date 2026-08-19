# @michaelrwalker/stagehand — Skill Spec

Stagehand is a fully typesafe, saga-style script framework for TypeScript with a
live terminal UI. A script is a sequence of phases, each a sequence of steps;
any step can declare a compensation that runs if a later step fails, and every
handler's return value widens a compile-time-checked context that later steps
read with no hand-written generic. It has zero runtime dependencies, works in
any TypeScript/Node ≥20 project, and is not tied to any framework.

## Domains

| Domain | Description | Skills |
| --- | --- | --- |
| Building a script | Structural primitives: phases, steps, the accumulating typed context, validated input | getting-started, structuring-phases-and-steps, typed-context-and-input |
| Compensation and context safety | Saga guarantees: rollbacks, rollbackKeys reservation, clean, when-skipping | adding-rollbacks, cleaning-context, conditional-steps |
| Observability while it runs | The handler UI surface and where it renders | reporting-progress, log-placement-and-rendering |
| Caching | Reusing prior work across runs | caching-expensive-work |
| Reuse and composition | Sharing steps and phase fragments | splitting-steps-across-files, reusable-routines-and-mounts |
| Errors and results | The shape of run()'s outcome and every error class | handling-results-and-errors |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| --- | --- | --- | --- | --- |
| getting-started | lifecycle | building-scripts | first script end-to-end, run()/RunResult | 3 |
| structuring-phases-and-steps | core | building-scripts | addPhase/addStep, retry/timeoutMs, outline() | 4 |
| typed-context-and-input | core | building-scripts | ctx widening, input vs ctx, defineInput | 2 |
| adding-rollbacks | core | compensation-safety | rollback, rollbackKeys, rollback scope, cancellation | 5 |
| cleaning-context | core | compensation-safety | clean, reserved-key rules | 3 |
| conditional-steps | core | compensation-safety | when on step/phase, skip semantics | 3 |
| reporting-progress | core | observability | status/note/progress/task/tasks | 4 |
| log-placement-and-rendering | core | observability | logPlacement, live vs plain renderer | 3 |
| caching-expensive-work | core | caching | stores, stale/schema, context.cache | 5 |
| splitting-steps-across-files | core | reuse | stepFor, WithStepFor, shared step libraries | 3 |
| reusable-routines-and-mounts | core | reuse | routineFor, use(), multi-mount | 4 |
| handling-results-and-errors | core | errors-results | RunResult, error classes, isAbort | 4 |

**43 failure modes total** across 12 skills (target of 3+ per skill). Only
typed-context-and-input sits at 2 — everything else reached 3+ after the
Phase 4 interview added maintainer-sourced failure modes on top of the
docs/source-derived draft.

## Failure Mode Inventory

### getting-started (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | try/catch around run() expecting it to throw on failure | CRITICAL | docs/guides/script-options-and-result.md | handling-results-and-errors |
| 2 | mutating ctx directly instead of returning new keys | MEDIUM | src/script.ts; docs/guides/cleaning-context.md | typed-context-and-input |
| 3 | returning a bare value from a handler instead of an object | HIGH | src/types.ts; src/script.ts; maintainer interview | — |

### structuring-phases-and-steps (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | duplicate step name within one phase | MEDIUM | src/script.ts; docs/reference/errors.md | — |
| 2 | never calling addPhase, then relying on rollback: "phase" | MEDIUM | src/script.ts; docs/guides/phases-and-steps.md | adding-rollbacks |
| 3 | addStep directly after use() | HIGH | src/script.ts; docs/guides/reusable-scripts.md | reusable-routines-and-mounts |
| 4 | wrapping the whole script in one giant step instead of decomposing it | MEDIUM | maintainer interview | — |

### typed-context-and-input (2 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | calling defineInput after addStep/addPhase | MEDIUM | docs/guides/typed-context.md | — |
| 2 | expecting SchemaValidationError inside RunResult | HIGH | docs/guides/typed-context.md; docs/reference/errors.md | handling-results-and-errors |

### adding-rollbacks (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | defensive rollback on the step that itself failed | MEDIUM | docs/guides/rollbacks.md | — |
| 2 | expecting full ctx in rollback without rollbackKeys | CRITICAL | docs/guides/rollbacks.md; test/rollback-keys.test.ts | — |
| 3 | assuming a throwing rollback replaces result.error | MEDIUM | docs/guides/rollbacks.md; docs/reference/errors.md | handling-results-and-errors |
| 4 | any Error named "AbortError" treated as cancellation, skipping retry | MEDIUM | src/errors.ts; src/script.ts | handling-results-and-errors |
| 5 | a rollback reaching beyond its own step to compensate for another step | MEDIUM | maintainer interview | — |

### cleaning-context (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | cleaning a step's own just-produced output | MEDIUM | docs/guides/cleaning-context.md | — |
| 2 | cleaning a rollbackKeys-reserved key | CRITICAL | src/script.ts; test/rollback-keys.test.ts | adding-rollbacks |
| 3 | assuming a skipped step's clean doesn't fire | MEDIUM | docs/guides/cleaning-context.md; src/script.ts | conditional-steps |

### conditional-steps (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | expecting a skipped step's rollback to fire | LOW | docs/guides/phases-and-steps.md | — |
| 2 | step-level when can't override a phase-level skip | HIGH | src/script.ts | — |
| 3 | when inside a mount sees the mount's input, not the host's | MEDIUM | docs/guides/reusable-scripts.md; src/script.ts | reusable-routines-and-mounts |

### reporting-progress (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | using status() for a value meant to persist | HIGH | docs/guides/handler-surface.md; src/script.ts | — |
| 2 | calling note() repeatedly expecting append | LOW | docs/guides/handler-surface.md | — |
| 3 | tasks() without `as const` loses typed get() | LOW | docs/guides/handler-surface.md | — |
| 4 | progress() values outside [0,total] clamp silently | LOW | src/context.ts | — |

### log-placement-and-rendering (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | "step"/"bottom" treated as a complete log record | MEDIUM | docs/guides/handler-surface.md; docs/guides/terminal-rendering.md | — |
| 2 | logPlacement assumed identical in CI | LOW | docs/guides/terminal-rendering.md | — |
| 3 | hardcoding Stagehand's glyphs in a script's own output | LOW | docs/guides/terminal-rendering.md | — |

### caching-expensive-work (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | `cache: cond ? store : undefined` instead of controlling caching via run()'s CacheMode | HIGH | src/script.ts; docs/guides/caching.md; maintainer interview | — |
| 2 | cache.clear() mid-run expected to re-run the current phase | MEDIUM | docs/guides/caching.md; src/script.ts | — |
| 3 | shape-guarded value read without `raw: true` throws far downstream | MEDIUM | docs/guides/caching.md; src/cache.ts | — |
| 4 | caching relied on as a hard guarantee against re-execution | MEDIUM | docs/guides/caching.md | — |
| 5 | cache.write patch without keepAge resets the TTL | MEDIUM | docs/guides/caching.md; docs/reference/cache.md | — |

### splitting-steps-across-files (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | WithStepFor nested in reverse of real execution order | HIGH | docs/guides/splitting-steps.md | — |
| 2 | reused stepFor step assumed to have independent state per script | LOW | docs/guides/splitting-steps.md | — |
| 3 | writing a bespoke step inline instead of a shared, composable one | MEDIUM | maintainer interview | — |

### reusable-routines-and-mounts (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | mounting the same routine twice without `as` | HIGH | docs/guides/reusable-scripts.md; docs/reference/errors.md | — |
| 2 | routine's own ScriptOptions assumed to survive mounting | MEDIUM | docs/guides/reusable-scripts.md; maintainer interview | adding-rollbacks |
| 3 | `as` rename breaks unprefixed cache.clear/read/write calls | LOW | docs/guides/reusable-scripts.md; docs/guides/caching.md | caching-expensive-work |
| 4 | mount input mapper assumed to re-run per step | MEDIUM | docs/guides/reusable-scripts.md | — |

### handling-results-and-errors (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | `result.error instanceof StepFailedError` to get phase/step | HIGH | docs/reference/errors.md | — |
| 2 | throwOnError assumed to skip compensation | MEDIUM | docs/guides/script-options-and-result.md | — |
| 3 | catching RollbackFailedError from run() | MEDIUM | docs/reference/errors.md | adding-rollbacks |
| 4 | any "AbortError"-named error assumed to mean script cancellation | MEDIUM | src/errors.ts | adding-rollbacks |

## Tensions

| Tension | Skills | Agent implication |
| --- | --- | --- |
| Caching speed vs. compensation guarantees | caching-expensive-work ↔ adding-rollbacks | caching a rollback-protected phase silently removes it from the saga's safety net |
| Simple first draft vs. rollbackKeys permanence | getting-started ↔ adding-rollbacks ↔ cleaning-context | adding a rollback later can retroactively break unrelated `clean` calls elsewhere |
| Rich live view vs. complete log record | reporting-progress ↔ log-placement-and-rendering | can't have locality (step/bottom) and completeness (scrollback) at once — one setting, whole script |
| Routine authoring instincts vs. host-controlled ScriptOptions | reusable-routines-and-mounts ↔ adding-rollbacks ↔ log-placement-and-rendering | a routine can't bake in its own rollback/logPlacement/silent policy; the host always wins |

## Cross-References

| From | To | Reason |
| --- | --- | --- |
| getting-started | handling-results-and-errors | run() resolving instead of throwing is the first thing to get right |
| adding-rollbacks | cleaning-context | rollbackKeys and clean share one reservation mechanism |
| adding-rollbacks | caching-expensive-work | cached work never rolls back |
| caching-expensive-work | reusable-routines-and-mounts | cache slots travel with a mount and get renamed by `as` |
| conditional-steps | reusable-routines-and-mounts | `when` inside a mount sees the mount's resolved input |
| reusable-routines-and-mounts | structuring-phases-and-steps | a routine owns whole phases; addStep after use() is refused |
| reporting-progress | log-placement-and-rendering | one rendering mechanism, described from two ends |
| handling-results-and-errors | adding-rollbacks | isAbort governs whether/how fast a rollback's unwind triggers |
| typed-context-and-input | cleaning-context | ctx-is-not-a-plain-mutable-object is the shared mental model |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| --- | --- | --- |
| typed-context-and-input | — | Merge/Cleaned/Prettify type-level utilities, if agents start hand-writing intersections |
| caching-expensive-work | fileStore, memoryStore (2 stores — under the 3+ threshold for a formal `subsystems` list, but close) | CacheStore/CacheOptions/CacheHandle full type surface |

No skill in this library has 3+ backends/adapters/drivers with genuinely distinct
configuration surfaces (caching has exactly two built-in stores, both sharing
one `CacheStore` interface), so `subsystems` was not used on any skill.

## Recommended Skill File Structure

- **Lifecycle skills:** getting-started
- **Core skills (framework-agnostic, all of them):** structuring-phases-and-steps, typed-context-and-input, adding-rollbacks, cleaning-context, conditional-steps, reporting-progress, log-placement-and-rendering, caching-expensive-work, splitting-steps-across-files, reusable-routines-and-mounts, handling-results-and-errors
- **Framework skills:** none — Stagehand is framework-agnostic by design
- **Composition skills:** none as standalone skills — Standard Schema integration (Zod/Valibot/ArkType/Effect Schema) is folded into typed-context-and-input's `defineInput` coverage rather than split out, since it is one method call, not an ongoing integration surface
- **Reference files:** caching-expensive-work is the strongest candidate for a `references/cache-api.md` given its 4-method handle plus 2 stores plus stale/schema/keepAge/raw option surface

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| --- | --- | --- |
| Standard Schema (Zod, Valibot, ArkType, Effect Schema, or hand-rolled) | `defineInput()` infers `In` and validates `run()`'s input against any compliant schema | No — covered inline in typed-context-and-input; it is a single, narrow integration point (one method, one interface), not broad enough to warrant its own skill per the maintainer's confirmation that Stagehand "works in any TypeScript ecosystem" with no other required integrations |
