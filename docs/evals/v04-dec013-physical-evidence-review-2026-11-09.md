# DEC-013 physical evidence review — November 9, 2026

## Verdict

**REVISE.** The completed laboratory is internally consistent and retains useful partial physical diagnostics, but it is not a complete or attributable physical-power result. No production, E2, economic affordability, K1–K8, R1/R2 or release acceptance follows. Do not rerun the campaign from this review alone.

## Original evidence and integrity

The owner-invoked `sudo node scripts/rso5-power-lab.mjs --full` execution ran from 2026-11-07T07:35:49.565Z to 09:51:48.070Z. The owner later reported that Unreal was not running; other host processes were not controlled.

- Exactly 62 unique runs executed in frozen order: 20 scenarios, 41 idle windows and one sustained window.
- 61 entries passed with 52/52 clean stops each (3,172 clean stops). The sustained window failed.
- All 28 frozen source hashes and all 375 recorded artifact hashes verify. The hash set covers six artifacts per run plus the manifest, execution and decision records.
- All 20 order digests, run IDs and seeds match the manifest. No matching laboratory or sampler process remained after completion.
- The original run used wrapper SHA-256 `90b66c0496a2e1598098070114e51516a663cd406962070c50c82bea66d62c53`.
- `delivery/results/econ-power-lab-hashes.json` and the original result artifacts remain unchanged by the later instrumentation revision.

Primary records: `delivery/results/econ-power-lab-execution.json`, `delivery/results/econ-power-lab-decision.json`, `delivery/results/econ-power-lab-hashes.json`, and the per-run `econ-power-power-*` JSON/CSV files.

## Sustained failure remains unclassified

`power-sustained-max-envelope` failed after 205.311 seconds overall, with approximately 78 seconds in its planned 1,800-second baseline phase. Its process artifact records 736 reads and 1,470 retries, consistent with 184 complete read cycles followed by a refusal on `runtime-old-3`'s first retry of the next cycle.

The error `Four current history heads unavailable: observer:observe` and repeated WebSocket 1006 closures do not identify a root cause. The same head-unavailable path covers timeouts and too few usable responses, and member errors are not retained. The failed run has 39 clean stops and 13 escalated stops; cleanup escalation after a metrics/stop error does not prove those workers crashed before the functional failure.

Classify this as an **unclassified functional/qualification failure**. It must not be dismissed as environmental, but the retained evidence does not justify a product-runtime fix.

The ancillary `econ-finalization-power-sustained-max-envelope.json`, `econ-cleanup-power-sustained-max-envelope.json`, `econ-lab-summary-power-sustained-max-envelope.json`, `econ-decision-power-sustained-max-envelope.json`, `econ-owner-assumptions-power-sustained-max-envelope.json`, `econ-authorization-power-sustained-max-envelope.json`, and `econ-new-view-readiness-power-sustained-max-envelope.json` remain root-owned mode 0600 and unreadable to the reviewer. They are outside the 375-artifact hash set. Their preservation and review are required before failure triage is complete.

## Power evidence scope and coverage

The instrument measures host CPU+GPU+ANE estimated power, including workers, coordinator, Vitest, sampler and unrelated host activity. It is neither per-process energy nor whole-system/AC energy. Process CPU, RSS, network and work counters cannot allocate sampled milliwatts to Resonance or another application. The owner's report rules out Unreal, but not other time-varying host activity.

The first pre-idle window averaged approximately 16.47 W combined and 4.16 W GPU over retained intervals; the long idle baseline averaged approximately 0.528 W combined and 0.00082 W GPU. These values demonstrate a substantial time-varying host confound without identifying its source.

Across all 62 runs:

- 8,009 JSON samples are retained with no missing component values.
- 149 genuine two-second gaps total 298 seconds; one legitimate final-sample censor remains.
- Retained integration covers **7,798.0 / 8,158.504 seconds = 95.5812487%** of wall time.
- Every run remains `partial`; all matched-idle incremental energy values are null.
- `absolute_energy_joules` values are retained-subinterval estimates, not complete run energies and not inputs for economic calculations.

The failed sustained run retains **587.5295 J over 199 integrated seconds**, mean 2.9524 W over those intervals, against 205.311 seconds total wall time. Retaining failure energy is correct.

## Instrumentation corrections after preservation

Independent review found two reporting defects in addition to the genuine gaps:

1. The initial-boundary predicate required a sample at or before `startMs - 1000` after filtering to samples at or after `startMs`, making an initial censor unavoidable. All 62 such markers were false; actual first-sample delays were 0.008–0.959 seconds.
2. CSV generation filtered on `atMs` after that field had been removed, so all 62 CSVs omitted every actual sample. JSON samples were intact.

The offline-only revision in `scripts/rso5-power-lab.mjs` corrects both defects, adds retained seconds, coverage ratio and censor counts to per-run evidence, and adds decision-level energy coverage metadata. Five deterministic tests were added in `packages/relay/src/__tests__/sustainable-rso5-power-evidence.test.ts`.

Revised wrapper SHA-256: `e42b1455c210403860ad0cf6221e58406adb23c4c70f9afdfe9c07aa6afcc8fd`. The original manifest is intentionally not rebound to this revised wrapper; it continues to identify the original execution.

Verification:

- New and existing focused evidence suites: **10/10 tests passed**.
- Actual-source TypeScript noEmit and wrapper syntax checks passed.
- Offline recomputation over all 62 retained JSON files produced zero energy differences, zero missing CSV samples and zero false initial markers.
- All 62 runs remain partial because genuine gaps remain. No physical result was rewritten and no campaign was rerun.

## Next action

Preserve the failed/partial package and revised instrumentation. Obtain read access to the ancillary failure-finalization artifacts, then complete failure triage. A fresh physical run requires a separate owner decision after a credible controlled-host measurement plan; it is not authorized by this review. E3, economic affordability, production and K/R acceptance remain open.
