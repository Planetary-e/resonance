# Terminal operator and returning-owner lifecycle — October 23, 2026

Before-code contract: B-HISTORY-LIFECYCLE / R1–R2 / K2–K3. One Sol HIGH deliverable, <=25 active minutes including diagnosis, implementation, focused tests and receipt; existing cumulative effort and stopped legacy100 remain unchanged. Entry shared weekly6% used, ordinary allowed (parent observation).

Concrete result: ordinary node two-transfer test uses explicit operator terminal generation preparation, separately retained local enrollment/state pins, mandatory terminal consumers, and authenticated existing freeze/agreement/download/provision/restore before returning old owners install the successor. Existing exact retries/conflicts/denials and fresh current-policy service assertions must remain.

Mapping: witness handoff operator exports paired terminal preparation; a separate pins artifact derives from configured owner context plus local persisted original genesis/root/head, never imported evidence. Transfer preparation/install require that independent artifact. Existing admission-history-recovery and admission-history-restore compose authenticated successor selection and restoration into a new explicitly selected directory, retaining the terminal old directory and marker. No alternate state machine or automatic successor activation.

Invariants: retain original genesis/key/context/root/generation/exact-head pins; settle charged pending before terminal cut; preserve all original policy/archive/vote/certificate/spend/denial evidence; verify selected continuation comes from exact frozen generation and prepared head. Existing time/work/storage bounds apply.

Acceptance: focused ordinary two-transfer node test by name filter, focused terminal/operator safety controls and affected relay/node noEmit; independent parent-arranged protocol review and composed regression follow stable candidate. No R1/K2/K3 closure from components.

Exclusions: conditional legacy100, live/automatic activation, marker deletion/unfreeze, enrolled-state reset, trust/limit changes, Git/CI/installers/dependencies. Missing continuity invariant or reachable correctness failure stops affected approach with smallest actual counterexample.

Pre-delta bytes, inherited patch and hashes: `/tmp/v04-terminal-operator-lifecycle-2026-10-23/`.

## Result — STOP / lifecycle acceptance failed

The unchanged 2 GiB aggregate storage authority refuses the second of four old-owner terminal preparations, before a complete first transfer. The actual ordinary test reaches authenticated terminal export on owner1; owner2 fails opening the existing `witness-terminal-recovery/history-recovery.json`. No returning-owner restoration is reached. The operator and returning-owner wiring is an unaccepted partial candidate, retained for exact diagnosis, not a successful deliverable or KPI closure. R1/R2/K2/K3 remain OPEN.

Smallest observed distinguishing resource boundary:

| Checkpoint | Reserved bytes | Available bytes | Next recovery-file reservation |
| --- | ---: | ---: | ---: |
| Before owner1 terminal operation | 1,879,374,726 | 268,108,922 | 201,334,784 |
| Before owner2 terminal operation | 2,080,831,047 | 66,652,601 | 201,334,784 |

Authority limit: 2,147,483,648 bytes. Existing recovery state has `maxBytes = 96 * 1024 * 1024`; existing encrypted-state reservation is `2 * maxBytes + 8192 = 201,334,784` bytes. Before owner2's operation the deficit for that file alone is already 134,682,183 bytes; command artifacts and terminal intent reserve additional bytes before the refusal. These checkpoints are measured before the operator call, not an invented exact post-intent total. This is reserved aggregate storage capacity, not measured disk use, memory or RSS. Trace: storage-reservations.reserve -> openEncryptedLocalState -> createHistoryCheckpointRecovery:85 -> protected-admission-history:512. Existing monotone reservations and the first owner's freeze remain; no limit change, cleanup credit, marker deletion or continuation bypass was attempted.

The telemetry rerun was started immediately before parent freeze instruction; it reran the same one ordinary test solely to identify this owner/reservation boundary. No broader campaign or sample change. Conditional legacy100 test body is byte-for-byte unchanged from the pre-delta snapshot and was excluded by the test name filter; no skip was added.

### Exact commands and evidence

- `npx vitest run packages/node/src/__tests__/protected-witness-handoff.integration.test.ts -t 'hands already-issued'`: sandbox-only first attempt failed `listen EPERM` in 1.11s.
- Same command with approved local-loopback escalation: `ordinary-second.log`, 1 failed ordinary test / 1 test excluded by name filter, 27.37s total / 26.42s test. First product failure is aggregate storage refusal.
- Same name-filtered command with funding checkpoint telemetry: `ordinary-capacity.log`, 1 failed ordinary test / 1 excluded by name filter, 28.12s total / 27.13s test. Same exact reservation refusal, now attributed to owner2.
- Bare `npx tsc --noEmit -p packages/node/tsconfig.json` failed against stale relay declarations; do not treat prior bare package checks as evidence of fresh cross-package source.
- `node_modules/.bin/tsc --noEmit -p /tmp/v04-terminal-operator-lifecycle-2026-10-23/source-tsconfig.json`: PASS, exit0, current core/relay/node source mapped directly; no emits. Exact config and empty `source-tsc.log` retained. The only later source delta is the telemetry `console.info` statement.

No independent review/composed regression is claimed. Parent review should assess the failed composed approach, not certify these unaccepted wrappers. Original ordinary positive business assertions remain present but later ones were not reached. The proposed generic recovery path additionally needs exact continuity/prepared-head validation and actual restart/restore/policy-service evidence before adoption; none is asserted here.

### Candidate and process receipt

Changed within this block: `packages/relay/src/witness-handoff-command.ts`, `packages/node/src/__tests__/protected-witness-handoff.integration.test.ts`, `scripts/admission-history.ts`, and this receipt. Inherited dirty files preserved. No other production source changed. Pre-delta bytes, inherited patch, three exact overlay patches, final files and hash manifests are under `/tmp/v04-terminal-operator-lifecycle-2026-10-23/`.

Actual routing: Sol HIGH executor, no reviewer/subagent. First-pass acceptance: FAILED (resource boundary); no acceptance or material review finding. No repair after resource stop; one telemetry-only rerun. Entry shared weekly6% used (parent), exit verified7% used, ordinary usage allowed. The +1 percentage-point change is shared/coarse, not a model-specific charge or new allowance. All work stayed within the original <=25 active-minute cap; no budget/alternative reset.

## Authorized funding redesign — before implementation

Owner said Adelante to retaining2GiB and redesigning honest reservations. Parent
remains B-HISTORY-LIFECYCLE/R1–R2/K2–K3; old failed candidate and all counters
are retained, not reset. Astra MEDIUM read-only decision <=5min + necessary
<=4min follow-up rejected an immutable-only fix: five new32MiB mutable snapshot
ceilings alone would add335,585,280 bytes to1,879,374,726, exceeding2GiB before
any recovery work. No tests were rerun for that static lower bound.

Selected contract: explicitly opt in NEW recovery workspaces and NEW restored
owner destinations to monotone funded growth, keeping all generic defaults,
existing allocations, original data ceilings, original pins/proofs and all
time/work/storage limits. This does not guarantee admission of unfunded future
work. It must guarantee completion of already accepted work. No refund, shrink,
cleanup credit, deleted original or automatic old-generation unfreeze.

Use existing captured reservation authority and encrypted local-state machinery.
Encrypted file ceiling maxBytes retains its actual ciphertext-wrapper meaning.
For a component's encrypted-image high-water bound H, preflight Hnext=max(existing
H,current encoded length,EVERY promised completion-image bound), then reserve
2*Hnext+8192 before the operation's intent or external effects. Include old/new
atomic images, ownership headroom, schema-max future receipt/signature/timestamp
metadata and retained-preparation-plus-retry. Obtain fresh leases after growth;
never silently switch authorities. Persist/validate opt-in mode, ceiling and
binding to path/component/original authority. Reopen checks EXISTING funding and
retained obligations; it does not fabricate missing funding or fix the contract
by allocating more during reopen. Partial reservations remain charged on failure.

Preflight BEFORE pending acceptance/dispatch must cover protected pending+final
applied snapshots, writer pending+maximum completion certificate, immutable
pending block and promised checkpointReserveBytes. The quorum writer already
computes pending+completion headroom; funding must commit it, not only check a
ceiling. Retry/reopen reconstruct and validate the retained completion obligation
before transmission. Exhausting the remaining authority later must not prevent
completion of a previously funded accepted operation.

Exact-selection terminal/recovery operations pre-fund their selected originals,
root/gen/barrier/ordered IDs/exacthead plus maximum attempt/receipt/preparation
metadata BEFORE freezing. Generic unknown-history recovery keeps its96MiB fixed
default. Separate immutable download copies stay retained and charged; no new
deduplication store. Downloads fund retained+next block+checkpoint promises and
manifest replacement before publishing a block. Reopen verifies indexed and
permitted unindexed/temp data before cleanup. Fixed-default ancestry checks stay;
opted-in ancestry validates its authenticated funded contract rather than
pretending to retain252MiB+4MiB fixed capacity.

Observable acceptance is the COMPLETE ordinary two-transfer node test, including
all five returning-owner restorations and unchanged original exact-retry, denial,
conflict and current-policy service assertions, under the unchanged2GiB authority.
Also require meaningful fault tests: refusal before write/freeze; accepted pending
completion after authority exhaustion and restart; missing funding/wrong authority/
changed mode or ceiling fail closed; crash ordering at reservation, pending,
block/manifest rename and final state; monotone no-refund; generic-default behavior.
Current-source core/relay/node noEmit, one independent critical review and one
affected composed regression follow. Preserve stopped legacy100 byte-for-byte
and do not run it. A failed honest integration exposes the exact first boundary.

One Sol HIGH executor owns this complete funding/lifecycle deliverable (<=35
active minutes); no parallel implementers/helper completion claims. Parent
arranges one Astra HIGH critical review after stable evidence. These task ceilings
are not a new spending allowance or reset of historical effort. No Git/CI/build/
installer/dependency, trust change, new state machine or live automatic route.

## Funded lifecycle follow-up — STOP at unchanged reservation-entry capacity

The authorized monotone-funding candidate is **unaccepted**. Honest incremental
byte funding passes the earlier owner2 boundary and permits the first transfer
plus three returning-owner restorations. The fourth returning owner fails during
successor provisioning: its first two replica provisions complete, but replica2
is the earliest observed refusal, `Storage reservation entry capacity exhausted`.
Replicas3/4 repeat that primary error. The owner reports the secondary `Four
authenticated provision receipts unavailable`; it is not a timeout diagnosis.
The fifth returning owner and completed second-transfer service are unreached.
R1/R2/K2/K3 remain OPEN. No independent acceptance review/composed qualification
is requested or claimed for this stopped composition.

Exact first primary boundary (`ordinary-provision-diagnostic.log:47`):

| Field | Observed value |
| --- | ---: |
| Owner / replica | witness-4 / 2 |
| Recovery step | 4 (provision) |
| Authority revision | 629 |
| Allocated component entries | 512 |
| Reserved bytes | 2,049,387,890 |
| Available bytes | 98,095,758 |
| Aggregate byte limit | 2,147,483,648 |

`STORAGE_RESERVATION_MAX_ENTRIES` remains512. Both the metadata-entry bound and
2GiB authority are unchanged. Earlier accepted reservations and partial provisions
remain charged; no entry reuse/refund, cleanup credit, deleted original, trust
switch, new deduplication store or larger limit was attempted. The exact primary
and secondary records are retained in `first-entry-boundary.json`. A deterministic
minimal test reserves512 one-byte components with >900,000 bytes still available
and proves the513th allocation fails without changing the ledger. This removes
crypto, network and byte-capacity ambiguity from the new stopping condition.
The previous failed fixed-reservation result above remains historical evidence.

### Candidate changes and distinguishing evidence

Core encrypted state has an explicit NEW-state `monotone-v1` option. The encrypted
wrapper authenticates canonical path, component, original authority identity,
unchanged ciphertext ceiling and funded high-water H. Growth commits2H+8192
before replacement; leases refresh through captured authority. Reopen checks
existing funding and authenticated retained obligations without allocating missing
capacity. Generic fixed ceilings remain. Wrong mode/ceiling/authority/path and
missing allocations fail closed. Recognized temporary data is checked before
cleanup; partial reservation growth remains charged after a failed write.

The candidate preflights protected pending+final images, writer certificate
completion and immutable payload/checkpoint obligations before pending intent or
replica dispatch. Exact recovery retains declared selected originals and ordered
IDs, funds attempt/preparation metadata before freeze, and rejects differing
selected history. Generic unknown-history recovery retains96MiB. Downloads and
new restored owner snapshots/archives opt into authenticated funded growth;
separate recovery copies and download originals remain retained. Operator config
explicitly selects the new mode and an independently retained originals file.
Selected ancestry reopens its authenticated funded variant under the independently
selected authority; the generic252MiB+4MiB checks remain for fixed states.

The ordinary path additionally exposed a pre-existing representation bug:
reconstructed and parsed restoration images have recursively identical fields and
values but different top-level insertion order. Existing replay digests hash JSON
representation. Exact witness: `field-order-witness.json`, with retained/baseline
digest `sha256:b8994a2ccc54d0cf0e87c2a95782e33a67162f17d5f994658eb7fe86fb7f634d`
and reparsed digest `sha256:8dfe84cec8303ed99963f5d4994919feb1e056e881a64f9e576a14770b7575f5`.
The narrow fix invokes the same full authenticated image parser under the existing
startup operation budget before computing the unchanged digest. It changes no
signature, context/genesis/selected-head pin, digest function/domain or restoration
equality assertion. A focused signed-image regression proves reordered fields
normalize equally, a real denial-field change changes the digest, and a forged
policy fails verification. Initial automatic review rejected this proposed change
as a possible continuity relaxation before execution. After this isolated evidence
and explicit parent authorization, one fresh review approved the precise parser
normalization; no alternate-tool/default-sandbox workaround was used. Exact
rejection, evidence and reconsideration are in `approval-review.txt`.

Canonical-resource binding also needed the existing macOS `/var`→`/private/var`
ancestor alias to identify the same file. Its focused test proves no new funding
is allocated through that ancestor alias and a copied nonalias path is refused.
An initial test used an immediate symlink parent, which existing ownership rightly
rejects; it was corrected to the actual ancestor-alias shape, without changing
ownership restrictions. All failed intermediate results are preserved.

### Exact tests and remaining obligations

All commands use this checkout's `node_modules/.bin/` and logs under
`/tmp/v04-funded-lifecycle-2026-10-23/`.

- Ordinary command: `vitest run packages/node/src/__tests__/protected-witness-handoff.integration.test.ts -t 'hands already-issued'`. Final diagnostic:1failed ordinary /1excluded by name filter,73.23s test /74.18s total. Earliest primary boundary above. Seven bounded ordinary attempts/diagnostics total are retained, including missing-import, closed-original-inspection, exact digest mismatch, alias-binding and initial provision failures; no unchanged broad campaign.
- Initial affected fixed-default regression:88/88 PASS (`focused-first.log`). This is earlier candidate evidence, not final product acceptance.
- Current affected funding files:67/67 PASS (`funding-current.log`,29.09s), covering core funding, recovery refusal before freeze, exact-selection retry/reopen, actual retained pending completion after lost durable replies + authority exhaustion + restart, and funded download block/manifest uncertain renames followed by exhausted-authority reopen. The later source additions are selection-cap/independent-authority checks; no final composed regression is claimed.
- Final core funding/fault/minimal-boundary tests:8/8 PASS (`core-fault-final.log`,4.64s tests), including mode/ceiling/path/authority/missing-funding refusal, monotone no-refund, failed rename, completion after exhaustion/restart, generic fixed default, canonical ancestor alias and512-entry counterexample.
- Signed-image round-trip proof:1/1 PASS (`roundtrip-proof.log`); current core/default/round-trip set40/40 PASS (`core-funding-final.log`) before the final additional alias/entry tests.
- Actual-source core/relay/node `tsc --noEmit -p /tmp/v04-terminal-operator-lifecycle-2026-10-23/source-tsconfig.json`:PASS, empty final log. Package-source mappings are explicit; stale dist declarations are not used as evidence.

Remaining: all five returning-owner restorations, full second-transfer retry/
conflict/denial/current-policy service assertions, independent critical acceptance
review, composed regression and complete funded process-death fault qualification.
Fault injection is not represented as full process-death coverage. Original business
assertions remain unchanged. Conditional stopped legacy100 body is byte-identical
SHA256 `2c8427a4a8e3e27d68f95dd79b8e4597ff47d82b3c98c672bf7afd4b91ca6c03`,
never run and only excluded by the ordinary name filter; no skip was added.
The inherited telemetry fields `recoveryStateMaximumBytes=96MiB` and
`recoveryReservationBytes=201334784` annotate the GENERIC FIXED DEFAULT, not the
actual opt-in incremental allocation. Only measured authority totals above support
the funding boundary; do not read that stale annotation as opt-in usage.

Before/after source bytes, inherited patch/status/HEAD, task delta, final hashes,
logs and the exact source configuration are retained in the same temporary folder.
All84 inherited dirty/untracked entries are preserved except explicitly owned
source deltas and this append-only receipt. Previously clean tracked source bytes
are reconstructible exactly from the recorded HEAD and initial clean status;
those baselines are saved alongside the inherited dirty copies. No Git mutation,
CI/build/installers/dependency change or checkpoint/roadmap rewrite was performed.

Actual routing: one Sol HIGH executor as dispatched, no subagents/reviewer. First
pass failed; successive bounded corrections/diagnostics are preserved above.
Entry shared weekly8%used (parent), exit9%used verified, ordinary usage allowed.
The+1percentage-point observation is shared/coarse, not a model-specific cost or a
new allowance. Active work stopped within the original<=35minute ceiling; exact
elapsed time is recorded in the final temporary manifest. Historical effort,
architecture decision time, previous failed alternatives and spending limits were
not reset. Parent owns any subsequent architecture decision and roadmap update.

## Complete static resource budget — NO-GO before further code

[Source-backed complete resource budget](../developers/v0.4-recovery-resource-budget.md)
records the full allocation families, observed346→373→512 reconciliation,
conditional563–564-entry successful-path skeleton (lower bound563, no proved full
upper bound), and UNKNOWN complete byte peak. At the refusal, necessary missing
replica+fixed coordinator bytes alone consume64,053,248 of98,095,758 remaining;
future encoded restoration/download/output/completion obligations remain unknown.
The missing one-path ledger reconciliation and restored policy-mirror creation
are explicit uncertainties, not invented green evidence. Prospective directory
scope needs deterministic enforced aggregate slots; current directory lease alone
cannot safely aggregate child reservations. No grouping code/trial is approved.
100 cycles, >64 ancestry and stopped256MiB reconstruction-work conditions remain
unresolved. Reproducible static arithmetic/source SHA256 inventory:
`/tmp/v04-complete-budget-2026-10-23/`. One Sol MEDIUM bounded source-only block;
entry shared weekly9%used/ordinary allowed; no tests/reruns/subagents/production
edits/Git/CI/build/limits/refunds. Parent records review/exit usage. R1/R2/K1–K8 OPEN.

### Complete resource-budget audit — reviewed NO-GO

Owner authorized BOTH-dimensional complete-path accounting before more code.
[Resource decision](../developers/v0.4-recovery-resource-budget.md): conditional
per-file successful-path skeleton563–564, lower bound563/excess51, not an exact
upper count. Full byte/entry/serialized-metadata bounds remain unproven. Necessary
remaining terms alone consume64,053,248 of98,095,758 available bytes. Independent
Astra MEDIUM review confirmed missing restored policy mirrors for owners1–4,
corrected opening count overstatement and classified grouping as subordinate to
certified sustainable cut/compaction architecture. Sol MEDIUM source audit +
Astra MEDIUM bounded review; sharedweekly9%→10%observed, ordinaryallowed.
Arithmetic/source reproduction PASS, no production edits/tests/campaign reruns.
No implementation/trial GO, no KPI closure or historical effort reset.
