# R1 actual protected-history semantic freeze boundary

Parent: B-HISTORY-LIFECYCLE / R1 / K2–K3. October 23, 2026.

## Frozen pre-code contract

One bounded deliverable, executor at most 15 active minutes, within the existing
lifecycle history and unchanged stopped32/100 result. Entry shared weekly usage
2%, ordinary usage allowed. Correct checkout: `resonance-v04`, branch
`feature/v0.4-private-transport`, HEAD `c81d2ac55f083c62127d9ea663a3f2d30b078ffb`;
the full source tree already contains unrelated dirty production work.

Use real encrypted protected histories, genuine owner and replica signatures,
and the existing policy-proof/freeze/transfer APIs. Reproduce a post-freeze spend
and late genuine certificate retained after the original signed head. Four
individual original logical witness owners sign their own distinct histories;
replicas supply durability only. No assertion of identical local state.

Observable acceptance: a valid original freeze remains independently verifiable
while the owner's durable head and obligations advance. Compare transfer from
retained old reports with refreshed reports. Preserve policy proof verification,
owner-attributed acceptance and original certificate bytes. If this exposes no
terminal tail/freshness boundary, stop before introducing a semantic cut codec.
This is a structural prerequisite test, not a full productive two-transfer pilot.

Cut-plus-required-tail contract: each cut must bind original genesis/context,
selected proposal, owner and exact head plus complete semantic obligations and
independently verifiable policy archive bytes. Any later mutation needs a complete
contiguous authenticated tail to a durably selected terminal sequence/floor.
Readiness must bind that terminal floor; missing tail, proof or pending outcome
must refuse. A later certificate may enrich existing old uncertainty but may not
create destination-local acceptance or restore allowance. The current API's
phase flag alone is not evidence that this terminal boundary exists.

Exclusions: production edits, new implementation helpers, activation, pruning,
fresh trusted root, capacity changes, dependencies, frozen100, Git writes, CI,
installers and a new campaign. In-process signed replica exchanges are sufficient
for this boundary; no socket or transport qualification is claimed.

## Result

**NO-GO for a terminal semantic cut using only current `OLD_FENCED` reports.**
**Conditional GO for the existing storage-generation freeze as a repair primitive.**
No semantic codec or production change was implemented. R1 and K2/K3 remain OPEN.

The single executable regression creates four independently encrypted protected
logical-owner histories, each backed by five genuine signed replica roles and
four-receipt durable writes, with an actual protected genesis policy proof. The
fifth logical witness is absent; storage replicas are separate principals from
the logical witness owners. In-process exchanges invoke the production signed
request/response path and filesystem persistence; they do not measure sockets.

Trace retained by
`packages/relay/src/__tests__/semantic-freeze-boundary.integration.test.ts`:

1. Persist one genuine vote for the same original-context claim in each of four
   owner histories **before** freezing. Assemble their valid certificate, but
   withhold it from certificate retention until after freeze. No new honest vote
   is generated after the role fence.
2. Freeze four individual owners. Their distinct heads and signatures validate;
   full original replay yields four partial votes, zero retained certificates and
   zero accepted rows.
3. At owner zero, a generic protected spend advances head N to N+1, with at least
   four durable replica copies, while phase remains `OLD_FENCED`. Retaining the
   original genuine certificate advances head to N+2. Reopen/ready preserves both
   the spend and certificate.
4. Transfer preparation still accepts the old bundles and yields exactly the old
   manifest. Refreshing that owner's freeze yields the owner-attributed row and
   original certificate instead. Removing a refreshed tail block without changing
   its signed descriptor refuses.
5. Call the existing `createHistoryCheckpointRecovery.prepare()` on owner zero.
   Four authenticated complete frozen-history receipts select the exact current
   head, and at least four stores retain their generation barrier. A subsequent
   generic spend fails to obtain four acknowledgements, leaves its durable pending
   intent and does not change applied state. The subsequent certificate-retention
   attempt cannot complete that pending operation; reopen/ready also refuses.
   Preparation alone does not allocate or activate a successor generation.

This proves mutability and missing terminal freshness in the proposed cut mapping.
The generic spend is a protected-store write, **not** demonstrated end-to-end
admission authorization, exposed acceptance or lost acknowledged external work.
The old partial votes already preserve the certificate's binding: absence of its
assembled bytes in the old manifest is **not** a conflicting-binding exploit.
Refreshed acceptance remains attributed to its original owner; destination-local
acceptance laundering is not exercised. Actual pre-cut replay is used here; no
zero-business-replay measurement or semantic recovery success is claimed.

## Required protocol repair and source anchors

`protected-witness-handoff.ts:60–80` binds the exact key/set/predecessor, writes
PREPARING and OLD_FENCED, refuses pending work, and signs the retained exact head.
Its verifier at lines83–148 authenticates/replays only the supplied prefix; it has
no independently known terminal floor. Generic spends at
`protected-admission-history.ts:645–662` and
`admission-history-records.ts:248–263` do not reject OLD_FENCED. Late certificate
retention at `protected-witness-handoff.ts:201–208` writes another handoff image.

The existing stronger primitive is owner-authenticated generation freeze:
`history-checkpoint-store.ts:754–781` rejects **all** ordinary appends after its
durable barrier; `history-checkpoint-exchange.ts:98–103` flushes that barrier before
signing a frozen head. `history-checkpoint-recovery.ts:95–224` persists freeze
intent, authenticates four responses, reads every selected original block,
refuses missing/conflicting payloads and persists preparation without successor
activation. `protected-admission-history.ts:521–543` requires fresh replication
on ordinary reopen; `history-checkpoint-quorum.ts:154–207` needs fresh append
receipts, which a frozen quorum cannot issue. These are reusable existing APIs,
not a proposal for a new global agreement service.

What is still missing is an owner-exclusive operation that orders logical role
fencing, completion/classification of pending work, authenticated generation
freeze, complete selected-head reconciliation and semantic export. A concurrently
written/uncertain tail must be included or cause refusal. Its funded durable
receipt must bind original genesis/context, proposal, selected terminal head and
policy-proof bytes; successor readiness must bind the same floor. Calling the
two existing operations separately does not prove that ordering. A generation
freeze affects the entire shared history, including unrelated writes and old
readiness; progress requires explicit handling of this scope and the successor
path. Later original certificates need an explicit new-cohort retention path
that preserves old constraints and acceptance provenance. No such repair was
implemented or qualified in this deliverable.

Individual owner signatures also do not establish that one Byzantine owner's raw
denial strings or accepted-row assertions are semantically truthful. Votes and
certificates carry independently checkable original signatures, but policy
archive/retirement and acceptance interpretation currently benefit from full
transition replay. `localEvidence` (`protected-witness-handoff.ts:33–40`) omits
the full policy-proof bundle. Replacing replay needs original policy/retirement
proofs or an explicitly justified conservative-refusal treatment, not silently
promoting raw owner assertions into authority or claiming K1/K4 availability.

## Coverage and limits

Reached: four individual genuine protected owner histories; absent fifth owner;
protected pre-freeze partial votes; delayed original certificate retention;
post-freeze generic spend; durable reopen; original-owner acceptance attribution;
old/refreshed full-replay comparison; missing-tail descriptor rejection; terminal
generation barrier and old-owner readiness refusal.

NOT reached: full hidden-certificate Byzantine matrix, conflicting partial votes,
lost-reply exposure, configured old authorization after fence, destination-local
acceptance laundering, policy cutoffs/retirement, missing archive-proof controls,
capacity/deadline exhaustion, crash/process-death during freeze, stale backup
restore, concurrent terminal selection, three-second observer drain/restart,
readiness/activation, two successive handoffs, productive fresh successor service,
exact old retry or independent pre-cut-read instrumentation. No broad pilot pass,
KPI closure, resource qualification or immutable-terminal claim follows.

## Verification receipt

Independent Astra HIGH review (three-active-minute task ceiling) found no
material issue in this scope and verified the exact test and stated 536-file
source identities. The review confirms the terminality/currentness distinction
and conditional reuse of the existing generation barrier; it does not approve
the missing semantic-export protocol. No suite was rerun by the reviewer.
Preparation's lack of successor activation is supported by source inspection,
not an explicit test assertion. The final reopen refusal has a pending append;
clean frozen reopen behavior was inspected in source rather than separately
exercised. Preserve those coverage limits. The bare-OLD_FENCED terminal-cut
variant is rejected under the structural stop rule; R1/K2/K3 remain open.

Environment: macOS, Node v24.19.0, Vitest4.1.11, unchanged dirty source checkout
identified above. The sandbox denied process inventory (`ps`); no running-command
inventory was established. No socket binding or escalation was used.

```text
node_modules/.bin/vitest run packages/relay/src/__tests__/semantic-freeze-boundary.integration.test.ts --maxWorkers=1
PASS: 1 file / 1 test, 6.69s total, 6.13s test.

node_modules/.bin/tsc --noEmit --composite false --incremental false -p packages/relay/tsconfig.json
PASS: exit 0, no diagnostics, after the final test change.
```

First pass: not accepted (fixture replica-parent directory absent). Second run
corrected that and exposed only the test's assumption about certificate vote
ordering; canonical ordering was adopted without changing original signatures.
Two fixture/assertion correction rounds, then the requested terminal control and
final pass. No independent protocol review has been claimed by this executor.
Executor effort upper bound15 active minutes, charged to the same lifecycle/R1
history; no exact token charge or runtime reasoning-effort telemetry is available.
Entry2%, exit3% shared weekly used; observed account delta1 percentage point is
shared/coarse, not this agent's attributable cost. Ordinary usage remains allowed.

Relevant SHA-256 source identities (existing dirty production bytes preserved):

The sorted536-file `rg --files packages/core/src packages/relay/src` identity is
`284169bc5c5a5874526edd289c72675c764c515ff096fb95a86ecbc39b4abdc5`.
Algorithm: SHA-256 over concatenated UTF-8 relative path, NUL, then raw32-byte
SHA-256 of that file's contents, in Python lexical path order. This includes
unrelated source bytes to identify the dirty source tree without relying on HEAD.

```text
924d3d2275284125012228a949f6d417c89e1656a1bb388f1d06746db476dda5  packages/relay/src/__tests__/semantic-freeze-boundary.integration.test.ts
6234732aea0b3452d486e9ee9107ed79d7c23184a01e7934d626ea97c206eb5a  packages/relay/src/protected-witness-handoff.ts
47f728644e5f9060d55f118b0ad2ceb781aaaee5b40521202b89d538d4446c70  packages/relay/src/protected-admission-history.ts
9b3d7d8aef2f5c92ce46c3d8f3ee8d0b8dc19a2d94e5ac836671fe61457640cd  packages/relay/src/admission-history-records.ts
8eee364414312904133ee1245907705473d33629e3ca9cad7e9eb71c5a0f9819  packages/relay/src/witness-handoff-state.ts
e7c63f473cee8f75a3f259fc5696aacd187f39fa016b270f3971bd9baa0074df  packages/relay/src/history-checkpoint-recovery.ts
1a5e5e36a643f83ec8711b8b11ea2b1b04ff6c9f84429a53eb7c851ca501f61e  packages/relay/src/history-checkpoint-store.ts
6693f2aede91ce32a34d4a01d8fd2392fa9cfe8d9e6bc4484054d21df206d1cb  packages/relay/src/history-checkpoint-exchange.ts
9fde1957ec9b25d32d9f34db21f210031c693d6e46ed8943c2f7996bfe0bd9fb  packages/relay/src/history-checkpoint-quorum.ts
```
