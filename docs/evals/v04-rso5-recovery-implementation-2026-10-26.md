# RSO5 bounded implementation receipt — October 26, 2026

**Status: DEC-004 complete uncapped diagnostic measured threshold failure; no acceptance or product evaluation.**
R1/R2 and every K1–K8 gate remain open. The DEC-003 capped diagnostic remains
blocked history. DEC-004 completed the intended inventory with no work ceiling;
its lifecycle scenario passed, but actual operation and cumulative thresholds were
crossed. This is diagnostic evidence, not an acceptance run or architecture approval.

## Authorization and boundary

DEC-003 and `obsidian-starfire-drax.md` authorize one experimental RSO5
implementation to measure the existing forecast. The owner explicitly requested the
test. This is not FEAT-002 activation, production integration, an EVL result or a
release decision. One executor owns steps 1–3 only. Parent owns the later complete
diagnostic inventory, independent review and any affected composition after focused
success. No 100-transition campaign, Git/CI/install action, production routing or
RSO2/RSO3 migration/compatibility claim is permitted.

DEC-004, approved at 2026-10-26T13:57:45Z, explicitly removes the work ceiling for
this diagnostic only. The owner demands actual growth beyond the cap because enforcing
the threshold under test made excess unmeasurable. This is a methodological correction,
not a new acceptance limit: no substitute 256 MiB, 512 MiB, `Number.MAX_SAFE_INTEGER`
or other diagnostic cap is allowed. Only the RSO5 lifecycle fixture may opt into a
clearly named no-ceiling scope with a nullable maximum and unbounded flag. Normal
`withSustainableRecoveryWork` behavior and the original comparison thresholds remain
unchanged; nested replicas share one meter and no actual work is omitted.

## Invariants

- Exact original business objects, signatures, reducers, evidence, rights, denials,
  uncertain outcomes, historical signer/configuration chain and policy freshness.
- Five pinned members, quorum four, at most one Byzantine, original locks, fences,
  floors, terminal-cut stability, replay and failed-byte behavior.
- Fresh parallel RSO5 frame/delegation/checkpoint formats and arenas. The global
  checkpoint signer attests availability/order only and never mints business proof.
- Immutable original-signer frames with per-proof DEKs wrapped by scope-key version;
  separate signed P-256 HPKE enrollment; compact scope-key delegation without
  per-proof recipient capsules or catalogs/compaction.
- Append exact frames before checkpoints; four matching durable frame and delegation
  copies before reservation. Previous checkpoint and frames remain intact at 0/1/3/4
  copies. Orphan frames cannot affect business state. Deterministic replay appends
  only missing exact frames and never rewrites/reorders history.
- Predecessor-independent role-private recovery with opaque replicas and no replica
  plaintext. Current exporter is in oldSet and recipient/enrollment in newSet.
- Original C=262144, L/P=65536, D=524288, F=32768, 2 GiB/512 entries/1 MiB,
  cumulative 256 MiB and 3 s/30 s. Acceptance per-operation W remains 4,718,592
  through normal `withSustainableRecoveryWork`. DEC-004's no-ceiling scope is confined
  to the lifecycle fixture and is never production routing or acceptance evidence.
- Prospective funding covers every frame, delegation, checkpoint, journal, policy,
  activation, pending head and failed-byte extent before promises.

## Focused falsifiers

Wrong original signer/scope/configuration/delegation/key version; unauthorized
exporter/recipient/checkpoint signer; exact replay/conflicts and orphan effects;
checkpoint fork/missing previous head; 0/1/3/4 checkpoint crashes; partial tails and
F exhaustion; physical refusal before promises; fewer than four copies; replica
plaintext; predecessor-dependent recovery; stale rotation/delegation; incorrect cold,
returning or new-view suffix catch-up; and any incremental/full reducer divergence
for conflict, denial, split or retry. Any safety/privacy/physical/per-operation
failure stops this slice without tuning.

Focused commands only:

```
./node_modules/.bin/vitest run --maxWorkers=1 packages/relay/src/__tests__/sustainable-rso5-manifest.test.ts
./node_modules/.bin/tsc -p docs/handover/2026-10-24/source-tsconfig.json --noEmit
```

Lifecycle/integration/equivocation/composed suites are not run by this executor.
Evidence will record exact hashes and every incomplete requirement. A cumulative
256 MiB crossing in the parent-owned later diagnostic is not acceptance and must not
be relabeled. No product evaluation is claimed by this focused work.

## Steps 1–3 focused result

Implemented the fresh parallel RSO5 modules and focused suite. No RSO2/RSO3
migration, compatibility claim or production routing was added. Original agreement
and business reducers, physical quotas and the unchanged work meter are preserved.
The new checkpoint path is availability/order-only; imported checkpoint signers are
checked against an explicit authorized cohort allowlist rather than assuming one
exporter for the complete historical chain.

Initial focused manifest: **5/5 PASS**, 3.51 s tests / 4.10 s total, Node24.19.0 /
Vitest 4.1.11, one worker. Initial actual-source noEmit: **PASS, exit 0**. After the
diagnostic-only AES key-derivation correctness fix, focused manifest rerun was
**5/5 PASS**, 3.54 s tests / 4.13 s total, and actual-source noEmit again passed.
No equivocation or composed suite was run, and no cumulative acceptance or product
evaluation is claimed.

Covered: physical closure; invalid frame/delegation/checkpoint authentication and
scope/key versions; exact replay/conflicts and replica ciphertext; rotation and local
C recovery; 0/1/3/4 checkpoint copies; forks, missing previous heads, unauthorized
signers, partial tails and F exhaustion; cold/returning/new-view suffixes; and
incremental versus full original conflict/denial/split/bound outcomes.

## Steps 4–6 diagnostic result: BLOCKED

Command:

```
./node_modules/.bin/vitest run --maxWorkers=1 packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts
```

The first harness attempt exposed a real implementation error: `keyFor` concatenated
context onto a 32-byte key and passed the oversized result to AES-256-GCM. The arena
now derives a 32-byte HMAC-SHA-256 key bound to the authenticated reservation
authority ID. This and the reviewer corrections below are correctness/metering fixes,
not work tuning; C/L/D/P/F, aggregate limits and W=4,718,592 remain unchanged.

Following independent review, the candidate now also: preflights delegation, missing
frames, prepare/commit checkpoints and journal/pending/suffix images before any import
append; groups exact recovery frames by digest and requires four matches; makes exact
state replay idempotent, rejects same-revision conflicts and requires four matching
startup records with exact ack bytes; publishes only new-frame checkpoint entries,
replays checkpoints without duplicate appends and reconciles journal/checkpoint floors;
derives checkpoint signers from authenticated journal/configuration history including
mixed original and disjoint returning cohorts; and charges protected-arena base64 and
JSON conversions. Six focused regressions distinguish these behaviors, including a
Byzantine frame substitute and completed-checkpoint/failed-journal recovery.

Follow-up corrections authenticate every 256-byte archive header, including its type,
with a keyed MAC bound to authority/owner/copy. R5H1→R5C1 mutation is quarantined
before floor advancement. Each checkpoint now authenticates its executed configuration
in both head and body; signer checks require membership in that configuration, with
valid-key future/retired epoch negatives. Archive-header allocation and previous-state
`readFileSync` bytes are charged as `allocate` and `disk-read` respectively.

Final focused evidence on this exact source: **12/12 PASS**, parent reproduction
5.50 s tests / 6.12 s total; actual-source noEmit **PASS, exit 0**. The parent's final
diagnostic rerun ran 12.55 s tests / 13.15 s total and stopped at `bootstrap:0` after **4,718,569 B**,
with four checkpoint acknowledgments unavailable because work was exhausted. One
legacy preparation used **1,706,557 B**, so measured cumulative work is **6,425,126 B**.
There is **no 256 MiB crossing** because the run cannot proceed; this is `blocked`, not
`failed` on cumulative overflow. The corrections did not make bootstrap pass.

The known **110,592 B** archive-header lower-bound issue remains explicit and is not
waived or hidden. It belongs to the intended-inventory lower-bound analysis, not this
partial run. The actual final bootstrap meter records **58,774 B** in `allocate` at its
earlier stopping point; neither value is extrapolated into a complete total.

| Inventory | Required | Actual |
| --- | ---: | ---: |
| Legacy preparations | 4 | 1 |
| Runtime phase calls | 102 (6 leader proposals + 96 other phases) | 0 |
| Real retries | 7 | 0 |
| View-change groups | 2 | 0 |
| Member `newView` calls | 8 | 0 |
| Complete post-transfer local-C-loss recoveries | 4 | 0 |

The forecast's 120 phase evaluations incorrectly include four proposals per command;
only the deterministic leader can propose. Its two view-change groups also cannot be
compared directly with eight member calls. These are reconciliations of the intended
inventory, not fabricated actual counts.

The successful-bootstrap forecast of 4,249,359 B is already contradicted: actual
bootstrap exceeds 4,718,569 B with outstanding work, more than 469,210 B above forecast.
The complete 270,132,258 B forecast and its projected
1,696,802 B overflow are **not experimentally confirmed or refuted**, because the
required inventory is unreachable. No extrapolated total or crossing is reported.

Raw top-level operation meters, including nested replica work exactly once and legacy
preparation in chronological cumulative order, are in
`delivery/results/rso5-operation-work.json` and `delivery/results/RUN-RSO5-001.json`.
Both records are identical and `blocked`.

Frozen hashes:

```
799b4be4d88eccc15863d9ec8da3ef95f2f543c092a0bc42fe7a546d92ea54b8  packages/relay/src/sustainable-rso5-opaque.ts
b19c5cba4c085757a0b1bf1d4770e55253602e5ea67ccbed5a07de60c671f982  packages/relay/src/sustainable-rso5-arena.ts
d607c928fa3e5143d2e1b6a1f4967a3f6e9d74f835a6b492ea4de8e474753436  packages/relay/src/sustainable-rso5-protected-arena.ts
f20f841e31d0610c6707aef7f521acb0b571252c56197a2e3af66bc17a62cb72  packages/relay/src/sustainable-rso5-codec.ts
ac98127fcf7e7c8cfd86fde30c8c26a685626fa4a8652c9e773266ab9733d6f3  packages/relay/src/sustainable-rso5-manifest.ts
85f3a223da1992eebe7cd84719e458d0cc5509d970cb958d3e431087c948f2f6  packages/relay/src/sustainable-rso5-runtime.ts
6e3f81e15665c4c1086425306858d7d0e5d47cca0f6eda0c0c546c7278e831cf  packages/relay/src/__tests__/sustainable-rso5-manifest.test.ts
da3ae8fb1613c46c6bf0eb6f54a32864576fc7fd2f7b54fb132babc6104fbe4e  packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts
b2d78b5cb5f526ec1dec9e07c5e8570bbe8c68574520d475df3802a54057094d  delivery/results/rso5-operation-work.json
b2d78b5cb5f526ec1dec9e07c5e8570bbe8c68574520d475df3802a54057094d  delivery/results/RUN-RSO5-001.json
89b15c55f6785c950152005dd7e1aeb78522ce7877e4297eb120d01837a66a85  delivery/work/FEAT-001.md
```

The candidate identity and command results are also in
`docs/handover/2026-10-26/rso5-candidate-hashes.json`.

## Remaining integration risks

- No agreement phase, transfer, reserve/install, real retry, new-view protocol or
  post-transfer local-C recovery executed in the lifecycle diagnostic. The harness
  contains those required paths, but their behavior and work remain unmeasured.
- Real checkpoint suffix convergence under adversarial history, exact fresh-policy
  timing, complete lock/floor behavior and all physical L/D/P/F edge cases remain
  integration work. Timing 3 s/30 s and real-network behavior are unverified.
- No equivocation, composed suite, 100-transition campaign or product acceptance
  evaluation was run; the required lifecycle inventory is blocked.

## Independent final verdict

The independent reviewer returned **ACCEPT bounded corrected implementation and
blocked measurement**. All 11 candidate hashes match, including both parent-regenerated
result artifacts at `b2d78b5c...`. The reviewer found no concrete remaining defect in
the reviewed corrections: archive type/header authentication blocks pending-to-
committed mutation; exact checkpoint configuration restricts future/retired signers;
archive-header allocations and previous-image reads are charged; all earlier preflight,
recovery, replay, checkpoint-floor, authority and conversion findings remain corrected.

This accepts only the bounded implementation corrections and internally consistent
blocked evidence. It does not accept RSO5 as an architecture, R1/R2 or any K gate.
Bootstrap attempted 4,718,569 B and stopped before complete acknowledgments; the full
forecast and 0.63% projected excess remain experimentally unverified. No near-pass is
inferred and no composed acceptance or campaign follows.

All RSO5 source/tests and this receipt remain untracked in the inherited working tree;
unrelated dirty/untracked files were preserved. No threshold change, Git/CI/installer,
campaign or release claim occurred.

## DEC-004 complete uncapped diagnostic

DEC-004 was recorded above before instrumentation edits. The new
`withDiagnosticUnboundedRecoveryWork` scope has `maximumBytes:null` and
`diagnosticUnbounded:true`; it does not substitute any numeric ceiling. Only lifecycle
operations and legacy preparations opt in. Nested replicas share each operation's meter,
and ordinary `withSustainableRecoveryWork` retains its acceptance ceiling and behavior.

During measurement, only concrete correctness/metering defects were corrected:
per-operation meter capture, canonical business proof roots, divergent checkpoint
history/branch import, retained-proof deduplication, cold-recipient binding order,
successor-epoch evidence lookup, terminal-cut view-change placement, complete local-C
file recreation, frame-before-checkpoint recovery and recovered scope-key retention.
Focused regressions cover these behaviors. No work optimization or cap/physical/trust
change occurred.

Final focused result: **17/17 PASS**, parent reproduction 8.39 s tests / 9.02 s total;
actual-source noEmit **PASS, exit 0**. Parent lifecycle scenario: **PASS**, 68.87 s
tests / 69.47 s total.
That scenario completion is not acceptance. Result records explicitly say
`diagnosticUnbounded:true` and `acceptanceEvaluation:not_run`.

| Inventory / measurement | Actual |
| --- | ---: |
| Legacy preparations | 4 |
| Runtime phase calls | 102 = 6 leader proposals + 96 other phases |
| Real retries | 7 |
| View-change groups | 2 |
| Member `newView` calls | 8 |
| Complete post-transfer local-C-loss recoveries | 4 |
| Recorded top-level operations including preparation | 226 |
| Unreachable classes | none |

- Total actual work: **666,381,561 B**.
- Forecast: **270,132,258 B**; actual is **396,249,303 B higher** (2.4669×).
- Original cumulative comparison: **268,435,456 B**; actual excess is
  **397,946,105 B**. Forecast excess was 1,696,802 B.
- First operation crossing: `bootstrap:0`, **5,271,184 B** against 4,718,592 B.
- First cumulative crossing: `reserveInstall:2:2`, cumulative **274,330,208 B**;
  that operation itself used 6,847,686 B.
- Maximum operation: `local-C-recovery:3`, **17,741,154 B**; its forecast was
  4,278,375 B, a difference of 13,462,779 B.
- **28** operations exceed the original operation comparison.

Every per-operation meter and available forecast delta is recorded in
`delivery/results/rso5-operation-work.json`. `RUN-RSO5-001.json` is identical and
records outcome `failed` solely as the diagnostic threshold result, never an acceptance
evaluation. The 110,592 B historical lower-bound issue remains preserved above; no
normalization or extrapolation was used.

Final same-run hashes:

```
d123ec73672a8922408ab401db4ffb0f1cb46914dc9805c1c0f07ad1fa7ab5a3  packages/relay/src/sustainable-recovery-work.ts
799b4be4d88eccc15863d9ec8da3ef95f2f543c092a0bc42fe7a546d92ea54b8  packages/relay/src/sustainable-rso5-opaque.ts
b19c5cba4c085757a0b1bf1d4770e55253602e5ea67ccbed5a07de60c671f982  packages/relay/src/sustainable-rso5-arena.ts
7a446e2e35eb433de421aa64cf6bef32d2efea588cf102380793e4726618632d  packages/relay/src/sustainable-rso5-protected-arena.ts
f20f841e31d0610c6707aef7f521acb0b571252c56197a2e3af66bc17a62cb72  packages/relay/src/sustainable-rso5-codec.ts
ac98127fcf7e7c8cfd86fde30c8c26a685626fa4a8652c9e773266ab9733d6f3  packages/relay/src/sustainable-rso5-manifest.ts
48b1d68f2d1438c2c2bcee5a7ead31ec3c95d8d3adaff70817d140751c2aaf10  packages/relay/src/sustainable-rso5-runtime.ts
ed8798244bc1ee77c4c1c60f31b3c07adb09d5a3e237d8fbd81216c522df8f78  packages/relay/src/__tests__/sustainable-rso5-manifest.test.ts
a2c7251a9747507290126967ec4dbf0043397ab2ffb0dfc219bd194592970fed  packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts
fca446a2cca50558cc0563dfddc24ab7a01995679d26295b7f5aca339d383586  delivery/results/rso5-operation-work.json
fca446a2cca50558cc0563dfddc24ab7a01995679d26295b7f5aca339d383586  delivery/results/RUN-RSO5-001.json
6143e0394ed2dde16a86626ce7a52b1adeb20970e5d4d9db6d59c0e42a062b54  delivery/work/FEAT-001.md
```

No unreachable inventory remains. No composed suite, campaign, production routing,
Git/CI/install action or K/R acceptance followed.

## DEC-004 policy/observer/proposal/retry-complete measurement

Earlier uncapped totals remain lower-bound history. The final run additionally meters
original vote construction, every retry request and the returning handoff proposal using
real admission signature/materialization hooks. Previously instrumented replay, policy,
observer, snapshot, persistence, transport and fresh-policy paths remain included. No
numeric ceiling, output estimate or normalization was introduced.

Final focused result: **17/17 PASS**; actual-source noEmit **PASS, exit 0**. Complete
lifecycle: **PASS**, with 272 top-level records and no unreachable classes. This remains
diagnostic, not acceptance.

- Total actual work: **677,938,671 B**, **407,806,413 B above forecast**.
- Actual excess over 268,435,456 B: **409,503,215 B**.
- First operation crossing: `bootstrap:0`, **5,271,184 B**, cumulative 7,378,039 B.
- First cumulative crossing: `reserveInstall:2:2`, cumulative **275,192,330 B**;
  that operation used 6,847,686 B.
- Maximum operation: `local-C-recovery:3`, **17,741,154 B**.
- **28** operations exceed the old per-operation comparison.

These values and the candidate manifest were generated programmatically from the final
artifact. Earlier labels and totals are not forced to earlier values. Both result files
are identical with SHA-256 `c8629699254ce4bcb57dd1b6316e163f33834f7ef042e227e39f525cb0981d34`. `diagnosticUnbounded:true` and
`acceptanceEvaluation:not_run` remain explicit.

Final same-run hashes:

```
a30ef803491f8eb6d7ec6fc21364aa93cd69c3adc596d2f0c38823a6e318348e  packages/core/package.json
520e3fe1c833bfe6bee0c60336e6edf54065180364e5b245e09f8bac0be838cf  packages/core/src/admission-work.ts
eb4c2b0009e78fedd68701c1d42224a1cfc87a2aa7a345b4c1aed8b85ae2ad67  packages/core/src/admission-policy.ts
186d95b010074b88e7d9e2a097b2e20e9a412884e22f9d06cb9e796812cc2956  packages/core/src/admission-policy-advance.ts
4b9f4ce2b970a1358e859fd999bad853bd83792aaf0cbb2b7e223221e3cf1b04  packages/core/src/admission-policy-freshness.ts
4c7d8f0ebd24a65a4fce600775824c913932e38e17b7216e972eea0527bd8e59  packages/core/src/admission-witness.ts
9444bac8fbc2493f86ee334688a5a181184fbc6f926c7a9822f9cb4bee1b7a8c  packages/core/src/admission-witness-handoff.ts
1dfb07a6d2ff695c44c50a94d94cea42e0f01865998bb8af9b44f231bbdc5427  packages/relay/src/protected-policy-observer.ts
5daa22fd8879101cd0a53cccc9ec019927d8de3efddc141ea6a53a9e4729952d  packages/relay/src/witness-handoff-state.ts
d123ec73672a8922408ab401db4ffb0f1cb46914dc9805c1c0f07ad1fa7ab5a3  packages/relay/src/sustainable-recovery-work.ts
799b4be4d88eccc15863d9ec8da3ef95f2f543c092a0bc42fe7a546d92ea54b8  packages/relay/src/sustainable-rso5-opaque.ts
b19c5cba4c085757a0b1bf1d4770e55253602e5ea67ccbed5a07de60c671f982  packages/relay/src/sustainable-rso5-arena.ts
7a446e2e35eb433de421aa64cf6bef32d2efea588cf102380793e4726618632d  packages/relay/src/sustainable-rso5-protected-arena.ts
f20f841e31d0610c6707aef7f521acb0b571252c56197a2e3af66bc17a62cb72  packages/relay/src/sustainable-rso5-codec.ts
ac98127fcf7e7c8cfd86fde30c8c26a685626fa4a8652c9e773266ab9733d6f3  packages/relay/src/sustainable-rso5-manifest.ts
48b1d68f2d1438c2c2bcee5a7ead31ec3c95d8d3adaff70817d140751c2aaf10  packages/relay/src/sustainable-rso5-runtime.ts
ed8798244bc1ee77c4c1c60f31b3c07adb09d5a3e237d8fbd81216c522df8f78  packages/relay/src/__tests__/sustainable-rso5-manifest.test.ts
b1f2bfaaf5c6161b899cf7435248f81455de42463ded42a7884c3aa38aefa41a  packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts
c8629699254ce4bcb57dd1b6316e163f33834f7ef042e227e39f525cb0981d34  delivery/results/RUN-RSO5-001.json
c8629699254ce4bcb57dd1b6316e163f33834f7ef042e227e39f525cb0981d34  delivery/results/rso5-operation-work.json
9625d28c205dc31a681c1ce6de1ecaaa18a5e42885b6d007c4169aa4905e0856  delivery/work/FEAT-001.md
467ce874ee74f6af1888a7f9b47debe3b86338b14beb03268c06fcfa29cc7f30  delivery/results/rso5-evidence-summary.json
edcfdb2c5b66650a4344be196b4acb1f1f0059122cd712874cb7e0d61ca67262  scripts/rso5-finalize-evidence.mjs
```

No composed suite, campaign, production routing, Git/CI/install action or acceptance
claim occurred.
