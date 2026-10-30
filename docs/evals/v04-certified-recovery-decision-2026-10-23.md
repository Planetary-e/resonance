# R1 semantic recovery decision — October 23, 2026

Status: conditional representation result; independent review and exact-P2
correction recheck complete. R1 and K2/K3 remain OPEN. Parent blocker: B-HISTORY-LIFECYCLE. No production
activation, original deletion, resource-limit change or stopped legacy rerun.

## Candidate and assumptions

Checkout: `/Users/marcos/Documents/Codex/2026-09-15/i-x20/resonance-v04`, branch
`feature/v0.4-private-transport`, HEAD
`c81d2ac55f083c62127d9ea663a3f2d30b078ffb`, with inherited dirty production files.
The eval sources below, rather than HEAD alone, identify this candidate:

| Source | SHA-256 |
| --- | --- |
| `packages/eval/src/certified-recovery-model.ts` | `3640496b30e6ff0d5e960b23bb68898e687688be11b923f12478e9b420e83739` |
| `packages/eval/src/__tests__/certified-recovery-model.test.ts` | `0e30d0a2b61cdf25f7013632118568996acf44a60604c4da5d88f031357a0cb4` |

The assumed agreement specification is PBFT-style immutable, prefix-consistent
ordering of control commands, checkpoints and terminal reconfiguration barriers.
This model does not implement agreement or derive it from four matching storage
receipts. It assumes atomic durable protection before message exposure, authentic
non-equivocating historical honest signatures, complete required payloads and
an authenticated genesis-rooted configuration chain. The fifth member can withhold;
the four-honest continuation supplies semantic confirmations and installations.
Arbitrary Byzantine agreement/network schedules are abstracted by the assumed
specification; five/four/one configuration constants are not a consensus proof.

## Fixed finite experiment

Three disjoint five-member cohorts; four confirmations and four installations;
at most one Byzantine member in each cohort; suffix cap two; three symbolic
one-second drain ticks, reset by restart. No wall-clock timing is modeled.

The initial semantic cut contains original accepted-A and its exact retry,
permanent-D, reserved-R and unexpired right-L. Generation zero protects conflicting
partial-P votes and a charged uncertain-U whose original certificate/reply can be
withheld. Generation one resolves that same original-context U and withdraws W,
advancing policy/fence to one. U crosses the first transfer uncertain, resolves
in generation one and crosses the second as accepted original-context evidence.
The P/Q partial conflict remains unresolved through both transfers. Generation two accepts one new current-policy
request and serves the original U retry. W remains denied; old policy refuses.
Imported accepted records preserve their original contexts and certificates.

BFS enumerates all interleavings of the exported 22-action alphabet within that
fixed workload, at most one crash per transferring generation, bounded exposure,
one rival proposal per generation, and exact-state deduplication. It explores
checkpoint/protection races, lost replies, volatile staging loss, crash with
partially/completely installed state, restart drain, missing payload, stale cut,
missing suffix, losing successor proposal and late-old-write refusals. The rival
is an uncommitted proposal; uniqueness of the selected successor is supplied by
the agreement premise. This is not exploration of two independently running BFT
implementations. Terminal installation is atomic at activation by assumption.

The obligation oracle is separate from snapshot projection and recovered state.
Recovery reduces the semantic cut plus actual suffix commands; tests also assert
literal expected original contexts, proposals, votes, charges, denials,
reservations, rights, policy, fence and retry results. Thus a lossy projection
cannot become its own expected answer. Symbolic pre-cut business-image visits
are zero; the model has no physical original-history reader, so this establishes
only its representation/transition behavior, not production I/O or lifetime
storage bounds. Configuration links still grow with transfers.

## Results and mandatory witnesses

The good model exhausted **15,780 states**, **53,595 accepted edges** and
**293,565 refused transitions**, below the fixed 80,000-state ceiling. It reached
3,728 recovered states, 84 second-transfer states, 42 exact-retry states and
64 states containing new current-policy service; no invariant violation.
These counts are reachable states, not independent users or trials.

The fair four-honest continuation reaches cohort two, protects/exposes
`accepted:original-c2-current` in context `c2/policy1`, then returns exactly
`accepted:hidden-original-c0-U` with origin `c0/policy0`. Partial P/Q still refuses
and retains its charge, permanent D and withdrawn W remain denied, and old policy
requests refuse. Restart after two drain ticks and four durable installations
requires all three new ticks before activation. Missing chain links, stale
current-authority indication, fewer than four distinct current pinned signers,
old-cohort signers and missing payload refuse. Chain/signature authenticity and
freshness detection themselves are assumptions, not implementations.

A ten-state cap test returns `exhaustive:false, limitReached:true`; a capped run
is inconclusive. The full good run did not reach the cap.

Each unsafe control below yields the shortest BFS violation in this declared
workload, and the test replays every retained action/state and checks that only
the final state first violates the invariant:

| Removed rule | Explored / discovered | Minimal replay | Violation |
| --- | --- | --- | --- |
| Preserve protected uncertainty | 127 / 242 | stage, protect, stage, protect, cut, recover | lost original-context obligation |
| Validate certified complete cut | 53 / 127 | stage, protect, bad-cut, recover | uncertified cut (reservation also omitted) |
| Require old barrier and drain | 4,778 / 5,437 | stage, protect, stage, protect, confirm ×4, recover, install ×4, activate | overlapping old authority |
| Require contiguous suffix/floor | 55 / 118 | stage, protect, missing-suffix, recover | lost original-context obligation |

Independent Astra review found one P2: the initial barrier/drain negative control
set a failure flag and returned before actual successor activation. That circular
evidence was corrected in the same deliverable, one material rework round. The
corrected transition always advances generation/transfers and installs successor
authority; it preserves independent per-cohort terminal-sequence, observer-seal
and remaining-live-lease records. The invariant detects overlap when a retired
cohort can still issue a new authorization or honor an existing live one while
the current cohort can issue a new authorization. No failure flag remains.

The minimal 14-action barrier trace now ends with `generation:1, transfers:1`,
chain `[0,1]`, and these independently inspectable authority facts:

```json
[
  {"configuration":0,"terminalSequence":null,"observerSealed":false,"leaseRemaining":3},
  {"configuration":1,"terminalSequence":null,"observerSealed":false,"leaseRemaining":3}
]
```

Both cohorts admit new authorization; the original cohort also honors its live
lease. Tests repair only the old record to terminal sequence 2, sealed observer
and zero remaining lease, which removes the violation. Restoring one live tick
restores the violation. A separate drain-only bypass actually activates generation
one after two post-restart ticks: the old barrier/seal refuse new authorization,
but the old live lease still admits existing authorization concurrently with the
new cohort. Normal activation permits neither form of old authorization.
The four controls still replay every step; the good exploration remains exhaustive
within its declared finite space. The same Astra HIGH reviewer verified the
corrected source hashes and narrowly confirmed this exact P2 addressed, with no
concrete remainder for that finding. No suite was rerun by the reviewer. This is
acceptance after correction, not first-pass acceptance or production approval.

The separate mobile-retired-key fixture compromises four original cohort keys
and produces `genesis,c0->attacker` beside `genesis,c0->c1,c1->c2`. A genesis-only
client cannot distinguish these histories under that attack. This is explicitly
OUT OF SCOPE under the accepted non-mobile key fault model; tolerating it needs
a separately approved trust mechanism.

## Reproduction and validation

Host: Darwin arm64, Node v24.19.0, existing Vitest v4.1.11; no dependencies fetched.
Run from the checkout above:

```sh
node_modules/.bin/vitest run packages/eval/src/__tests__/certified-recovery-model.test.ts --maxWorkers=1
node_modules/.bin/tsc --noEmit --composite false --incremental false -p packages/eval/tsconfig.json
node --import tsx --input-type=module -e 'import {exploreCertifiedRecovery} from "./packages/eval/src/certified-recovery-model.ts"; for(const rules of [{},{carryUncertain:false},{validateCut:false},{barrierAndDrain:false},{contiguousSuffix:false}]) {const start=performance.now(); const r=exploreCertifiedRecovery(rules); console.log(JSON.stringify({rules,...r,counterexample:r.counterexample?.map(s=>s.action),elapsedMs:performance.now()-start}));}'
shasum -a 256 packages/eval/src/certified-recovery-model.ts packages/eval/src/__tests__/certified-recovery-model.test.ts
```

First focused test pass: 10/10, 2.15 seconds, before productive-service refinement.
Final corrected focused test pass: 10/10, 4.60 seconds (tests 4.49 seconds). Eval noEmit
compilation passed both before and after the refinements. No failed test run or
broad regression was hidden; subsequent runs followed changed model/test sources.
Final exploration timings: good model 3522.784ms; dropped uncertainty 21.922ms;
uncertified cut 8.748ms; barrier/drain bypass 950.101ms; missing suffix 8.764ms.
These are local model runtimes, not protocol latency measurements.

## Concrete unresolved production mapping and acceptance conditions

1. `history-checkpoint-agreement.ts` operates over a ciphertext store. First
   assess semantic cuts signed by four existing logical witness owners under
   their epoch protocol; do not assume a new global BFT service is necessary.
   Establish its actual agreement, semantic access, canonical encoding and
   complete durable evidence floors. A boolean
   model certificate and four counters provide neither crypto nor availability.
2. `core/history-successor.ts` currently requires the full original selected chain
   (`ids.length == sequence + 1`). Map semantic cuts, retained originals, current
   authority freshness and chain continuity into that contract without silently
   introducing a new genesis or asserting constant lifetime chain storage.
3. Integrate actual issuer, witness/coordinator, observer and wallet obligations;
   justify that the finite semantic schema is complete for their live rights,
   partially emitted votes, conflicts, retry provenance and reservations. The
   finite workload cannot establish completeness for arbitrary application state.
4. Implement actual atomic persistence, protected-before-exposure quorum behavior,
   durable successor selection, old observer seal, full real three-second restart
   drain, installation readiness and monotonic recovery floors. The workload
   does not prove arbitrary quorum omissions, arbitrary replica crashes or
   Byzantine liveness beyond the explicit specification abstraction.
5. Independent protocol review must accept this conditional representation
   decision before R2. Actual cold/warm recovery, real signatures, process death,
   privacy/access and unchanged physical time/byte/RSS/work limits then require
   the R2 vertical slice and its predeclared qualification. No R1/KPI closure or
   physical safety/performance claim follows from these symbolic passes.
