---
feature_id: FEAT-001
status: blocked
requirement_ids: [PRD-002, PRD-003, PRD-011]
control_ids: [ARCH-001, ARCH-002, ARCH-005, ARCH-006, ARCH-007, CMP-004]
evaluation_ids: [EVL-003, EVL-004, EVL-005, EVL-015]
updated_at: "2026-11-02T06:29:34Z"
---

# FEAT-001: Genuinely different recovery architecture decision

## Outcome and non-goals

Produce an executable R1 architecture decision for a genuinely different sustainable recovery model. It must define current semantic state, certified boundaries, bounded suffixes, configuration continuity, fault/trust assumptions and decisive positive/negative schedules for acknowledged and uncertain operations, competing state cuts, restarts and disjoint successors. It must address complete prospective physical closure, predecessor-independent role-private recovery, compact scope/key-version delegation, shared immutable proof ciphertext and reference/availability transfer where relevant.

Non-goals: no RSO3/RSO4/RSO5 tuning, threshold/trust/quorum change, stopped campaign, recovery implementation, production integration, K2/K3 closure or release decision. The finite accepted experimental slice is not a substitute for this feature.

## Current baseline and relevant evidence

R1/R2 and K1–K8 are open. RSO3 and RSO4 are rejected. DEC-002 authorized one new design exploration, producing `docs/developers/v0.4-rso5-recovery-architecture.md`. RSO5 replaces catalogs/snapshots with self-contained immutable frames, scope-key delegation and signed append-only checkpoints.

RSO5 physically closes at C=258,595 B with 3,549 B headroom and forecasts bootstrap 4,249,359 B, first cold reserveInstall 4,278,375 B and returning reserveInstall 1,728,233 B. Its complete four-node two-transition cumulative forecast is 270,132,258 B against 268,435,456 B, excess 1,696,802 B. Independent R1 review returned **CONFIRM REJECTION**. The coherent physical/crash model does not cure cumulative work.

A separate finite experimental correction slice has 13/13 focused tests, 46/46 composed tests, actual-source noEmit and independent acceptance for its bounded schedules only. That evidence does not accept R1/R2 or any K gate.

## Allowed paths, tools, permissions, and external effects

DEC-002 authorized one design-only comparison/forecast, independent review and one documentation correction. That budget is complete. No recovery implementation, product tests, campaigns, builds, installers, deployment, release, threshold/trust change or external operational effect is authorized. Any further approach needs a new owner decision and must be genuinely different, not an RSO5 tuning pass.

## Acceptance criteria mapped to evaluations

The following remain future acceptance definitions, not current results:

- **EVL-003:** a reviewed model must support the varied K2 fault matrix with zero lost acknowledged operations, conflicting accepted spends or resurrected withdrawals and recovery p95 <=5 min under unchanged limits.
- **EVL-004:** the eventual path must support 100 correct cycles across >64 configurations with all required proofs and prospective funding; no campaign was run.
- **EVL-005:** authority/cutoff/freshness assumptions must support the lifecycle and revocation targets without stale service.
- **EVL-015:** every proposed production role/interface must preserve key/store separation, authentication, bounded schemas/frames/deadlines and private data flows with negative controls.

FEAT-001 remains blocked because the explored model did not satisfy its cumulative-work prerequisite. No evaluation case or K gate passed.

## Implementation plan and dependencies

No implementation plan is active. FEAT-002 depends on an accepted genuinely different architecture plus its own implementation/review gates. FEAT-003 depends on FEAT-002 and separate campaign authorization. RSO5 may inform future analysis but is not an accepted architecture or implementation baseline.

## Budget and stop conditions

The DEC-002 comparison/forecast, independent review and documentation correction are complete. Stop conditions remain structural counterexamples, inability to fund complete closure, privacy/safety conflicts or any need to change accepted limits. Do not omit checkpoint work, recovery copies or operation phases, use per-participant resets, or infer a larger threshold. Existing alternative/effort history is cumulative.

## Human gates and required approvers

Independent R1 review is complete and confirms rejection. A new product-owner decision is required for any fundamentally different approach beyond RSO5. Implementation requires a separate owner decision after an accepted design; software architecture and production approvals remain pending. No agent may approve these gates.

## Verification results and evidence IDs

Design-only evidence: independent arithmetic and protocol review confirmed physical C closure and cumulative-work rejection. The reviewer also corrected the displayed cold-reserve frame term to 3,354,368 B; the published total already used that correct value. EVL-003/004/005/015 remain unexecuted.

DEC-003 final corrected-candidate evidence: focused RSO5 manifest **12/12 PASS** (parent reproduction 5.50 s tests / 6.12 s total) and actual-source noEmit **PASS**. Independent review returned **ACCEPT bounded corrected implementation and blocked measurement**, verifying all 11 candidate hashes and every correction. The parent-reproduced diagnostic remains **blocked** at `bootstrap:0`: 4,718,569 B attempted before checkpoint acknowledgments failed from work exhaustion (12.55 s tests / 13.15 s total). One legacy preparation used 1,706,557 B and cumulative measured work is 6,425,126 B. No 256 MiB crossing occurred; later inventories remain zero. The 110,592 B lower-bound issue remains explicit. Final identical result artifacts have SHA-256 `b2d78b5cb5f526ec1dec9e07c5e8570bbe8c68574520d475df3802a54057094d`. These artifacts are not EVL or K-gate results.

DEC-004 policy/observer-complete evidence: mandatory proposal, retry request/vote, drain, activation, policy signing/advancement, observer advancement and fresh-policy paths execute inside the unbounded meter with real replay/materialization, parsing, signature, snapshot, I/O and nested helper charges. The complete lifecycle passed with 102 phase calls, 7 retries, 2 view groups/8 member newView calls and 4 full recoveries. Focused manifest is **17/17 PASS** and actual-source noEmit **PASS**. Actual cumulative work is **677,938,671 B**, 407,806,413 B above forecast and 409,503,215 B above comparison. First operation crossing is `bootstrap:0` at 5,271,184 B; first cumulative crossing is `reserveInstall:2:2` at 275,192,330 B. Maximum operation is `local-C-recovery:3` at 17,741,154 B. Both result artifacts have SHA-256 `c8629699254ce4bcb57dd1b6316e163f33834f7ef042e227e39f525cb0981d34`. No unreachable classes or acceptance is claimed.

## Final independent review

Independent review returned **ACCEPT bounded implementation and internally consistent failed diagnostic**. It verified all 23 candidate hashes, the complete inventory and instrumentation, and the finalizer's consistency checks. This does not accept RSO5 architecture, R1/R2 or any K gate.

## Remaining work and exact next action

Independent review of the unified 20-run baseline can proceed. Full 30-minute baseline review is blocked: the v6 idle artifacts are complete but 6 ms short, and sustained final evidence is missing after timeout. Do not start another window without a new owner decision. FEAT-001 remains blocked and prototype-only, with E2/E3 and economic/production acceptance open.

## DEC-008 independent-process laboratory

Owner authorization at 2026-10-29T05:43:10Z reopens FEAT-001 only for the approved RSO5 physical laboratory. Allowed work is an isolated `scripts/` harness, RSO5 laboratory worker modules/tests, sanitized economic evidence artifacts and delivery records. Use independent Node runtime/replica/observer processes, per-process arenas/keys and authenticated real WebSocket loopback transport; no direct-function transport, production routing, dependency installation, privileged command, Git/CI/installer or stopped campaign.

Preserve exact RSO5 business/recovery behavior, original reducers/signatures/privacy, four-copy durability and physical quotas. Instrument process-tree CPU/RSS/lifecycle, actual per-edge/direction/purpose bytes and available disk/nettop/iostat counters without treating work bytes as energy/network or loopback as Internet. Power is blocked with exact reason `powermetrics requires superuser; no calibrated external AC meter authorized`; no power samples may be fabricated. E2, economic affordability and all K/R gates remain unaccepted.

The current execution is limited to one full smoke lifecycle and focused checks. Freeze all 20 seeds/order and host/config/role/instrument identity in `delivery/results/econ-lab-manifest.json` before that run. Owner prices, budget and value remain pending. Independent review is required before any matrix execution.

Reproduction `reproduction-16`: **PASS** as a diagnostic only, 80.12 s, with focused manifest **17/17 PASS** and actual-source noEmit **PASS**. Matrix selection/order/identity smoke passed with zero matrix runs. The driver covers cold, returning, new-view and local-loss with per-run manifests/artifacts. Per-role/channel credentials and explicit method authorization refused forged-role and privileged replica runtime-read operations. Bounded stop and exact-path cleanup proved 52/52 clean exits and zero survivors.

Predecessor-independent recovery restored 164 proofs and 164 logical process-held copy audits with RSO5 signature/identity verification; these are not physical-device/crash-durability claims. Actual application WebSocket accounting reconciled 18,215 messages, 103,159,105 payload bytes and 103,269,285 frame bytes, including one separately accounted refused forged request. Per-role work recomputed to 677,397,548 B; worker CPU 28.882461 s user + 8.889759 s system; maximum sampled tree RSS 171,032,576 B. Recursive process-tree and per-role work records are retained. No private marker detected. All invalid attempts remain preserved.

Final driver corrections require `runtime:startup` after every `runtime:newView` and record durable serving sequence/digest readiness. Actual run decisions now report run-specific completion while aggregate E2 remains blocked. Every matrix manifest preregisters `node:crypto.randomBytes` as nondeterministic, not an exact business replay, with source/seeds/scenarios/run count/analysis frozen before results and no seed retrofitting or draw discard. Final selection smoke and focused/noEmit passed without another lifecycle or any matrix run.

The actual 20-run matrix completed in frozen order: five cold, five returning, five new-view and five local-loss diagnostic runs, all with unique `matrix-*` identities, immutable per-run artifacts and zero surviving workers. Post-newView startup/readiness passed. Aggregate work is 7,604,737,825 B; authenticated messages 265,814; application payload/frame 2,316,046,867/2,318,400,849 B; CPU 410.475847 s user + 132.727686 s system; maximum sampled tree RSS 181,436,416 B. Local-loss recovered 820 proofs with 820 signed logical process-held copy audits. Failure identities and artifacts are preserved. `docs/evals/v04-recovery-economic-matrix-2026-10-29.md`, `delivery/results/econ-matrix-execution-resume-6-final.json`, `delivery/results/econ-matrix-baseline-final.json` and `delivery/results/econ-matrix-evidence-hashes-final.json` support parent baseline independent review.

The earlier matrix is explicitly mixed-version invalid diagnostic history, not a unified baseline. The new unified 20-run matrix used one frozen source-hash set and per-run traffic resets. It completed all 20 runs with exclusive `unified-*` identities and complete artifact coverage. Unified aggregate work is 7,604,826,829 B; request+response envelopes 240,430; payload/frame 1,429,623,281/1,431,083,271 B; CPU 408.574828 s user + 132.099268 s system; maximum sampled tree RSS 179,683,328 B. The final baseline, receipt and 256-artifact review hashes are `delivery/results/econ-unified-baseline-final.json`, `docs/evals/v04-recovery-economic-unified-matrix-2026-10-29.md` and `delivery/results/econ-unified-review-hashes.json`.

E2 remains blocked by incomplete aggregate matrix/30-minute windows and physical power with no samples. Application payload/frame accounting excludes handshake/control/TCP/IP, nettop matched zero rows, iostat is host-only, and per-process disk/fsync counters remain unavailable. Loopback is not Internet evidence. `docs/evals/v04-recovery-economic-evidence-2026-10-28.md` was regenerated from exact `reproduction-16` artifacts plus final selection evidence; final review may proceed without K/R or affordability acceptance.

Baseline postmortem: v6 `idle-baseline-complete` has complete artifacts and 52/52 clean stops, but its measured baseline is 1,799,994 ms, 6 ms below the strict gate. It records 384,324 B work, 563 request+response envelopes, 5,334,244/5,337,672 payload/frame B, 6.839109 s user + 2.252906 s system CPU, and 117,489,664 B maximum sampled tree RSS. The sustained window produced only its authorization artifact before the 75-minute deadline interrupted finalization; required process/disk/network/work/summary/decision/owner/power/cleanup evidence is absent, so no sustained or aggregate totals are claimed. Orphan PID 98966 was cleaned with zero survivors. The blocked execution/baseline, 55-artifact hashes and receipt are `delivery/results/econ-baseline-windows-execution.json`, `delivery/results/econ-baseline-windows-baseline.json`, `delivery/results/econ-baseline-windows-hashes.json` and `docs/evals/v04-recovery-economic-baseline-windows-2026-10-30.md`. Full baseline review is blocked; unified matrix review remains available.

## DEC-006 established BFT exploration

Authorization: owner instruction “Explore a different approach” at 2026-10-27T05:34:24Z, approved in `delivery/decisions/DEC-006.md`. This reopened FEAT-001 only for one bounded design/forecast pass, one independent review and at most one documentation correction.

Result: `docs/developers/v0.4-cometbft-recovery-architecture.md` selects CometBFT v1.0.1 (`d222995`) plus the existing Node application behind ABCI and a separate append-only encrypted evidence/delegation store, with one agreement journal. Private C=258,595 B and D=131,712 B close. Listed sidecar reservations are 952,288 B per node and 3,809,152 B for four nodes; their aggregate arithmetic is 2,046,728,966 B, 100,754,682 B below 2 GiB. These reservations omit block headers, last commits, encoding and a funded retention/streaming/pruning schedule; they are not a full storage bound or physical-headroom claim.

Independent review **CONFIRMS REJECTION**. First cold reserve is 5,510,156 B (791,564 B over W), full local private recovery is 4,913,112 B (194,520 B over W), and suffix-replay startup is 7,134,196 B (2,415,604 B over W). The displayed 428,484,946 B cumulative arithmetic imports all 102 RSO phases and is not protocol-derived or complete for CometBFT. The six-command/four-copy baseline has 12 cut and 12 non-cut executions with separate proposer/other ABCI costs. Mechanical count substitution gives 262,681,555 B before other corrections, not a validated total; no corrected total is claimed. `V=5,872` means `8*(670+64)`. Arithmetic and JSON/diff only were checked; no implementation, product tests, campaigns, Git/CI, timing, energy, 100-transition or K/R acceptance evidence was produced.

## DEC-005 design-only RSO6 review

Authorization: owner selection of Option 1 at 2026-10-27T04:45:36Z, approved in `delivery/decisions/DEC-005.md`. This reopens FEAT-001 only for one coherent design/forecast pass, one independent review and at most one documentation correction for material findings.

Budget and stop conditions: design only. No production or product-test edits, implementation, campaign, Git/CI/installer or release action. Preserve original business objects/signatures/reducers/rights/denials, five pinned members/quorum four/at most one Byzantine, original C/L/D/P/F/W, aggregate 2 GiB/512 entries/1 MiB, 3 s/30 s and prospective funding. Do not tune RSO5 or infer a larger cap. A physical or work closure failure rejects the design before implementation.

Required design: signed incremental deltas with cut snapshots and <=32 suffix; crash-safe snapshot/pending generations without RSO4 mixed-generation loss; signed-bytes binary transport; authenticated incremental evidence indexes with full-original-reducer equivalence and single-pass nextState; exact size-only preflight; four-status/one-payload recovery with exact digest-race retry and preflighted durable delegation restoration. Include complete 10-scope/72-proof physical/work closure, falsifiers and crash/security/reducer/resource tests. No 100-transition fit or timing claim.

## DEC-004 uncapped diagnostic measurement

Authorization: owner instruction “Do not impose a budget! How do you pretend you are going to calculate the excess if you do not let it grow beyond your cap?” at 2026-10-26T13:57:45Z, approved in `delivery/decisions/DEC-004.md`. This reopens FEAT-001 only for the diagnostic and supersedes only DEC-003's diagnostic work-ceiling restriction.

Methodological correction: a measurement of actual excess must not truncate execution at the threshold being measured. Only the RSO5 lifecycle fixture may use a clearly named no-ceiling diagnostic scope with nullable maximum and an explicit unbounded flag. No substitute 256 MiB, 512 MiB, `Number.MAX_SAFE_INTEGER` or other cap is permitted. Normal acceptance metering and thresholds remain unchanged. Nested replicas share the same meter and every actual copy, parse, base64, allocation and disk operation remains charged.

Required evidence: complete four-node/two-transition inventory where correctness permits; per-operation actuals, cumulative total, first operation/cumulative crossings, forecast differences and unreachable classes without extrapolation. Original operation W=4,718,592 and cumulative 268,435,456 remain comparison thresholds only. `diagnosticUnbounded:true` is mandatory in result artifacts. No acceptance, EVL/K/R result, production routing, composed suite, campaign, Git/CI or installer action follows.

## DEC-003 bounded implementation measurement

Authorization: owner instruction “Do the test and let's if that calculation is accurate” at 2026-10-26T06:21:36Z, approved in `delivery/decisions/DEC-003.md`. This reopened FEAT-001 only for one experimental feasibility spike; it is not design acceptance, FEAT-002 activation, an EVL/K result or release authorization.

Allowed paths: fresh `packages/relay/src/sustainable-rso5-*.ts` modules; `packages/relay/src/__tests__/sustainable-rso5-*.ts`; `docs/evals/v04-rso5-recovery-implementation-2026-10-26.md`; `docs/handover/2026-10-26/rso5-candidate-hashes.json`; `delivery/results/rso5-operation-work.json`; `delivery/results/RUN-RSO5-001.json`; this work file and delivery-owned state/progress records. Existing crypto, reservation authority, work meter and legacy fixtures were reused unchanged. No RSO3 migration or production routing occurred.

Budget: one coherent implementation pass, focused correctness checks, one diagnostic inventory and independent correctness/metering corrections are complete. No work-tuning round, 100-transition campaign, production integration, installer, Git or CI occurred. Per-operation W remained 4,718,592 and physical limits were unchanged. Cumulative collection beyond 256 MiB was diagnostic only and was not reached.

Evidence: focused RSO5 manifest output, actual-source noEmit, exact changed source/test hashes in `docs/evals/v04-rso5-recovery-implementation-2026-10-26.md` and `docs/handover/2026-10-26/rso5-candidate-hashes.json`, plus `delivery/results/rso5-operation-work.json` and `delivery/results/RUN-RSO5-001.json` (`blocked` on unreachable inventory). No EVL/K gate is marked passed.

## DEC-007 production-cost validation

Owner selected **Validate production cost** at 2026-10-27T11:41:59Z. Local `/usr/bin/time -l` measurement completed on Apple M3 Pro/arm64 with Node24.19.0: 68.04 s real, 25.20 CPU seconds (~37.04% of one core), and 385,236,992 B peak RSS (367.4 MiB). The complete in-process diagnostic used 677,938,671 B work. These are not idle-CPU, physical-power, independent-network, production or K7/K8 results.

The independently accepted `docs/evals/v04-recovery-economic-validation-2026-10-27.md` defines 20 laboratory runs covering cold, returning, new-view and complete local-loss recovery; physical power/process/disk/every-edge network evidence; and a separately authorized >=5-operator/>=3-network/14-day natural-churn pilot with labor, repair tails and correlation analysis. No monetary cost is inferred from work bytes.

Current classification is **prototype-only**. The next owner decision is whether to authorize the 20-run physical laboratory program or remain prototype-only. FEAT-001 remains blocked and no budget, architecture or production approval follows.

## DEC-009 bounded prototype acceptance

The owner accepted RSO5 as a **bounded research prototype** at 2026-10-30T10:44:34Z. Accepted evidence includes the functional lifecycle, predecessor-independent recovery, new-view readiness and independently reviewed unified 20-run matrix. `delivery/results/econ-prototype-acceptance.json` records the decision.

This does not accept state of the art, production, a complete v0.4, economic affordability, R1/R2 or any K1–K8 gate. Physical power is unmeasured, sustained finalization is incomplete, original work thresholds fail and all architecture/compliance/release approvals remain pending. FEAT-001 remains blocked for full acceptance.

Next action: await an owner decision on production requirements/deployment or continued bounded research; no SOTA or release claim.

## DEC-010 corrected production evaluation windows

Authorization at 2026-10-30T15:07:44Z reopens FEAT-001 only to complete corrected idle and sustained physical evidence and then evaluate whether a revised work budget could support RSO5. The observable result is two sequential 52-worker diagnostic windows with monotonic baseline elapsed of at least 1,800,000 ms, 60,000 ms warmup/cooldown, correct returning-set retry authorization, bounded finalization, complete per-role/process/disk/network/authorization/owner/power/cleanup artifacts and zero survivors. Preserve original recovery behavior, safety, privacy, four-copy availability, quotas and retry rules.

Root-cause work is limited to timer semantics, duplicate/unbounded metrics and traffic finalization, missing failure-phase evidence and cleanup behavior. Do not merely enlarge the timeout, optimize work, create proofs/configurations, weaken authorization or hide finalization failures. Emit phase/failure evidence early enough to diagnose every outcome; collect each worker's metrics and paginated traffic once, bound stop/finalization steps and retain exact accounting.

Resource checkpoint: focused noEmit/tests and one frozen two-window execution only; no unified matrix rerun, stopped campaign, deployment, production routing, dependency installation, privileged command, Git/CI/installer or release action. Power remains exactly blocked with no samples. E2, E3, K/R, economic affordability and production approval remain open; any revised budget requires measured mandatory maxima, uncertainty margins and separate owner approval.

Outcome: both v2 runs completed finalization with complete artifacts and 52/52 clean stops plus zero survivors. Idle passes monotonic timing at 1,800,004.189 ms; sustained passes its 30-minute baseline at 1,800,046.339 ms but fails the frozen warmup gate at 42,613.754 ms instead of 60,000 ms. Actual work is 384,324 B idle and 24,495,738,843 B sustained; request+response envelopes are 459 and 1,879,633. Aggregate values are descriptive, not an accepted baseline. The corrected decision is `blocked_window_gate`; budget evaluation cannot proceed as a corrected baseline. See `delivery/results/econ-production-baseline-baseline.json`, `delivery/results/econ-production-evaluation-decision.json`, the 78-artifact hash set and `docs/evals/v04-production-evaluation-baseline-2026-10-30.md`. No new window follows validation.

## DEC-011 corrected full-warmup baseline repetition

Authorization at 2026-10-31T06:30:25Z permits exactly one corrected baseline repetition. The sole lifecycle correction is to enforce at least 60,000 ms monotonic warmup before the sustained bootstrap/lifecycle, while preserving both 1,800,000 ms baseline phases and both 60,000 ms cooldowns. Required evidence remains 52 workers per run, real traffic, exact per-role work/process/disk/network/authorization/owner/power/cleanup/finalization artifacts and zero survivors. Preserve DEC-010's stack-safe bounded finalization and all prior failures and unified hashes.

Freeze new DEC-011 identities and outputs before execution. Do not change recovery behavior, retry authorization, work/cost or timing requirements; do not rerun the unified matrix or a stopped campaign. Focused tests/noEmit and the authorized corrected pair are the only execution paths. Power remains blocked with no samples. Independent budget review may proceed only if every timing, evidence and cleanup gate passes; any revised budget still needs measured mandatory maxima, uncertainty/history margins and separate owner approval. No deployment, E2, K/R or economic acceptance.

Outcome: both DEC-011 runs pass every timing, evidence and cleanup gate. Idle warmup/baseline/cooldown is 60,002.140/1,800,003.706/60,245 ms; sustained is 102,237.834/1,800,081.799/69,309 ms. Each run has 52/52 clean stops and zero survivors. Work is 384,324 B idle and 24,600,514,019 B sustained; aggregate work is 24,600,898,343 B with 1,888,276 request+response envelopes, 3,406,943,820 payload B and 3,418,296,256 frame B. The independent validator and 50-artifact hash set pass. See `delivery/results/econ-dec11-baseline-baseline.json`, `delivery/results/econ-dec11-budget-review-decision.json` and `docs/evals/v04-dec11-full-warmup-baseline-2026-10-31.md`. Independent budget review may proceed; revised-budget approval remains separate, with no deployment, E2, K/R or economic acceptance.

## DEC-012 scenario-fit research work budget

Authorization at 2026-10-31T16:26:23Z reopens FEAT-001 only for revised-budget research evaluation. The concrete active research contract is per-operation work **26,611,731 B**, cumulative work **1,016,959,841 B**, and arrival intensity at most **4.13%** of the DEC-011 measured sustained recovery intensity. It is not production, K/R, deployment or economic approval. Original caps and all original-cap failures remain preserved history and are not relabeled.

Implement these values in `SUSTAINABLE_RECOVERY_LIMITS` and the RSO5 finalizer, with no contradictory original-cap formula in active metering. Run the current lifecycle only with normal bounded metering (`diagnosticUnbounded:false`, `budgetId:'DEC-012'`), and derive `acceptanceEvaluation` from actual bounded operation/cumulative results plus complete required inventory. Preserve safety, privacy, physical quotas, trust, business reducers, funding and retry behavior. Do not tune any failure or use the uncapped diagnostic for the new result.

Evidence plan: focused RSO5 manifest, actual-source noEmit and one complete bounded lifecycle; then regenerate result artifacts, candidate hashes, receipt and delivery records. Independent review may follow; parent owns commit/push. Power, physical network, labor, representative-maxima and E3 evidence remain missing. No 100-transition campaign, production routing or release action.

Outcome: focused RSO5 manifest **17/17 PASS**, actual-source noEmit **PASS**, and complete bounded lifecycle **PASS** with 272 records and complete inventory. Every operation used `maximumBytes:26611731` with no unbounded flag. Actual cumulative work is **678,000,451 B**, below the DEC-012 cumulative limit by 338,959,390 B. Maximum operation is `local-C-recovery:3` at **17,741,154 B**, below the operation limit by 8,870,577 B. Zero operation/cumulative crossings and no unreachable classes. Acceptance evaluation is `passed_revised_budget_research` only. Result artifacts are `delivery/results/RUN-RSO5-DEC-012.json` and `delivery/results/rso5-dec012-operation-work.json`, both SHA-256 `b2655804beb469ba5d07b166925ef7173df659e8aed27f88796aef562a05f20e`; summary, 23-hash candidate and receipt are in `delivery/results/rso5-dec012-evidence-summary.json`, `docs/handover/2026-10-31/rso5-dec012-candidate-hashes.json` and `docs/evals/v04-rso5-dec012-bounded-research-2026-10-31.md`. Independent review may follow; production, E3, economic and K/R acceptance remain open.

## DEC-013 physical power instrumentation

Authorization at 2026-11-02T06:10:36Z permits only `sudo powermetrics` for the approved RSO5 laboratory. One owner-invoked `scripts/rso5-power-lab.mjs` wrapper will run the entire driver with permission for the sampler, workers and tests; no other privileged behavior is allowed. Do not run the full matrix or windows in this task. Only a short sampler/parser smoke using the existing authorized manual sample is permitted.

Implement continuous 1-second sampling with actual timestamps and CPU/GPU/ANE/combined mW, trapezoidal absolute energy, matched idle-subtracted energy only when a valid matched baseline exists, and explicit missing/censored intervals and validity. Use combined power once; never derive energy from CPU time or work bytes. Join new power runs to process/disk/network/work artifacts without changing those measurements or double counting.

Freeze existing scenario seeds/order and analysis before execution. Full runs must remain pending and distinct from smoke. Include all 20 scenarios, 30-minute idle/sustained windows, matched pre/post idle windows and failure energy. Power JSON/CSV must exclude serial/UUID/IP/keys/plaintext/private logs and preserve all previous evidence. E2 remains incomplete until full physical evidence validates; no economic, production or K/R acceptance and no commit/push.

Outcome: wrapper and full-lab integration are implemented with 28 matching source hashes; actual-source noEmit and syntax checks pass. Offline smoke used only the authorized manual sample and proves actual mW parsing (CPU 412, GPU 1, ANE 0, combined 413 at `2026-11-02T06:07:54.000Z`) plus a separately labeled 1 J arithmetic check. No full scenario ran, and no execution/decision/hash artifacts exist. Full owner command is `sudo node scripts/rso5-power-lab.mjs --full`; independent review follows complete evidence. No privileged action was run by this agent and no production, E2, economic or K/R acceptance follows.

## DEC-013 completed run and independent physical-evidence review

The owner-invoked full laboratory completed all 62 entries in frozen order. Sixty-one passed with 52/52 clean stops; the sustained window failed after 205.311 seconds and remains an unclassified functional/qualification failure. All 28 source hashes and 375 artifact hashes verify. No laboratory process remains.

Host CPU+GPU+ANE sampling retained 8,009 samples, with 149 genuine two-second gaps totaling 298 seconds and one legitimate final censor. Retained integration covers 7,798.0/8,158.504 seconds (95.5812487%). Every run is partial, every matched-idle increment is null, and absolute values are retained-subinterval diagnostics rather than complete run energies. The owner reported no Unreal process, but other host activity was uncontrolled and per-process/whole-system attribution is unavailable.

Independent review returned **REVISE**, not acceptance. It also found an unavoidable initial-sample censor predicate and CSV sample omission. Offline-only corrections preserve the original result files and manifest while fixing those defects and adding retained seconds, coverage ratio and censor metadata. Revised wrapper SHA-256 is `e42b1455c210403860ad0cf6221e58406adb23c4c70f9afdfe9c07aa6afcc8fd`. Ten focused tests and actual-source noEmit pass; recomputation over all retained JSON produces zero energy differences and restores every CSV sample without changing genuine gaps.

See `docs/evals/v04-dec013-physical-evidence-review-2026-11-09.md`. Ancillary finalization/cleanup/summary evidence remains root-owned and unreadable. Complete failure triage before considering a controlled-host rerun, which requires a separate owner decision. No production, E2, economic or K/R acceptance follows.

## Change history and related DEC/ADR IDs

- v1, 2026-10-25: created the work contract as blocked under DEC-001.
- v2, 2026-10-25: reopened design-only exploration under DEC-002.
- v3, 2026-10-25: completed RSO5 comparison/forecast and independent R1 review; confirmed rejection and returned FEAT-001 to blocked. No ADR was accepted.
- v4, 2026-10-26: reopened only for DEC-003 bounded implementation measurement.
- v5, 2026-10-26: focused gates passed; diagnostic blocked at first bootstrap under unchanged per-operation W.
- v6, 2026-10-26: independent-review correctness/metering corrections applied; 11/11 focused tests and noEmit passed.
- v7, 2026-10-26: archive-header authentication, per-epoch signer checks and allocation/read metering added; 12/12 focused tests and noEmit passed.
- v8, 2026-10-26: independent review accepted the bounded corrected implementation and blocked measurement; FEAT-001 remains blocked and no composed acceptance or campaign followed.
- v9, 2026-10-26: DEC-004 reopens only the no-ceiling diagnostic; authorization and the methodological correction were recorded before instrumentation edits.
- v10, 2026-10-26: complete uncapped lifecycle measures 666,381,561 B and all required inventory; actual threshold failure recorded with no acceptance claim.
- v11, 2026-10-26: policy/observer/proposal/retry-complete instrumentation measures 677,938,671 B; first cumulative crossing is reserveInstall:2:2 at 275,192,330 B.
- v12, 2026-10-26: independent review accepted the bounded implementation and internally consistent failed diagnostic; RSO5 remains blocked and no composed acceptance or campaign followed.
- v13, 2026-10-27: DEC-005 design-only RSO6 completed and rejected: cold reserve 4,789,307 B exceeds W by 70,715 B; cumulative 311,198,374 B exceeds comparison by 42,762,918 B. No production or product-test edits.
- v14, 2026-10-27: DEC-005 single documentation correction confirms rejection, records 201/272 included records and 71 omissions, uncharged index maintenance, and the cut four-record requirement. No corrected total or further design/implementation.
- v15, 2026-10-27: DEC-006 design-only CometBFT sidecar exploration rejected before implementation on three per-operation failures; initial cumulative/physical qualifications are superseded by v16. No implementation, product-test, campaign, Git/CI or acceptance action.
- v16, 2026-10-27: DEC-006 single documentation correction records independent CONFIRM REJECTION. Cumulative 428,484,946 B is rejected non-protocol-derived arithmetic; mechanical 12-cut/12-non-cut substitution is 262,681,555 B before other corrections, not a validated total. Listed physical reservations are incomplete, and V=5,872 is 8*(670+64). Delivery is paused awaiting owner requirements/budget or a genuinely different approach; no further design/implementation.
- v17, 2026-10-29: DEC-008 reopens only the independent-process RSO5 laboratory. Authorization and boundaries recorded before harness edits; current execution is one smoke lifecycle plus focused checks, with power blocked and no E2/economic/K/R acceptance.
- v18, 2026-10-29: Independent-process smoke and focused gates pass with 52 clean stops, predecessor-independent recovery of 164 proofs, 164 four-copy audits and exact WebSocket accounting. Eleven invalid attempts retained. FEAT-001 returns to blocked pending independent review; matrix, power, E2 and economic/K/R acceptance remain blocked.
- v19, 2026-10-29: Independent REVISE corrections add immutable reproduction identities, actual unexecuted matrix driver, per-role/channel authorization, bounded cleanup, recursive process trees, signed logical-copy audits and per-role work evidence. Reproduction-16 passes focused/noEmit/smoke with exact current artifacts; re-review may proceed, matrix/power/E2/K/R remain blocked.
- v20, 2026-10-29: Final driver corrections require post-newView startup/readiness and run-specific completion statuses, and freeze nondeterministic business randomness plus analysis before results. Focused/noEmit/final selection pass with zero matrix runs; final review may proceed.
- v21, 2026-10-29: Actual immutable 20-run matrix completed in frozen order after preserving entry/startup/readiness/metrics failures and using distinct retry identities. All scenario, cleanup, work, traffic, power and readiness artifacts validate. Parent baseline independent review may proceed; no30-minute windows or E2/K/R acceptance.
- v22, 2026-10-29: Earlier matrix marked mixed-version invalid history. One frozen harness completed unified 20 runs with traffic reset, consistent request+response semantics and complete artifact hashes. Unified baseline/receipt and 256-artifact review hashes validate; independent review may proceed.
- v23, 2026-10-30: Baseline attempts stop with a blocked postmortem. V6 idle artifacts are complete but 6 ms short; sustained final artifacts are missing after the 75-minute timeout. One orphan was cleaned with zero survivors. Blocked execution/baseline, 55-artifact hashes and receipt preserve every attempt; full baseline review is blocked, unified matrix review remains available, and no further window or acceptance is claimed.
- v24, 2026-10-30: DEC-010 v2 runs finalize complete evidence with 52/52 clean stops and zero survivors. Monotonic baselines pass, finalization is bounded and stack-safe, but sustained warmup fails at 42,613.754 ms. Decision and budget evaluation are blocked; actual metrics, 78-artifact hashes and receipt are preserved, with no new attempt or production/economic acceptance.
- v25, 2026-10-31: DEC-011 enforces sustained warmup before bootstrap. Both runs pass all timing, finalization, work, traffic, authorization, power and cleanup gates with 52/52 clean stops and zero survivors. Actual aggregate work is 24,600,898,343 B; 50 evidence hashes validate. Independent budget review may proceed, with revised-budget, E2/E3, production, economic and K/R decisions still open.
- v26, 2026-10-31: DEC-012 normal bounded lifecycle passes with complete inventory and zero operation/cumulative crossings: 678,000,451 B total and 17,741,154 B maximum operation, within the research contract. Original-cap history is preserved. Result/summary/candidate/receipt and 23 hashes validate; independent review may follow, with production, E3, economic and K/R acceptance still open.
- v27, 2026-11-02: DEC-013 power wrapper and frozen full-lab test implemented. Offline smoke parses actual 413 mW combined and verifies 1 J arithmetic; no full scenario or privileged action ran. Twenty scenarios, two baselines and 40 paired idle windows remain pending under 28 matching source hashes. Owner command is `sudo node scripts/rso5-power-lab.mjs --full`; no production, E2, economic or K/R acceptance.
- v28, 2026-11-09: DEC-013 completed 62 entries with 61 passes and one unclassified sustained failure. Independent REVISE confirms 375 artifact hashes and 95.5812487% retained power coverage, but no complete/attributable energy or acceptance. Offline reporting corrections and ten focused tests pass; ancillary failure evidence remains unreadable and a controlled-host rerun needs a separate owner decision.
