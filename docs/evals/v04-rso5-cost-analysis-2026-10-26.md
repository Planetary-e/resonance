# RSO5 deep cost analysis and cheaper-alternative proposal — October 26, 2026

**Scope: analysis only. No implementation authorization, work tuning, campaign, cap
change, or R1/R2/K acceptance.** The complete uncapped diagnostic demonstrates a
large architectural cost failure, not a near miss and not merely a cryptographic
overhead problem.

## 1. Evidence and method

Primary evidence is `delivery/results/rso5-operation-work.json`, read programmatically
to sum top-level operations and mechanisms. The artifact and
`RUN-RSO5-001.json` are identical and record `diagnosticUnbounded:true` and
`acceptanceEvaluation:not_run`. Normal acceptance meters and limits were not changed
by this analysis.

Source paths reviewed:

- `sustainable-rso5-runtime.ts`: agreement replay, state transition construction,
  speculative journal encodings and retry materialization.
- `sustainable-rso5-arena.ts`: full archive/reference scans, checkpoint chain and
  sealed local images.
- `sustainable-rso5-protected-arena.ts`: five-replica state protocol, frame and
  delegation recovery, checkpoint publication and JSON/base64 replies.
- `sustainable-rso5-codec.ts` and `sustainable-recovery-codec.ts`: proof references
  and full policy/activation/transition journal decoding.
- `sustainable-recovery-work.ts`: actual charged copy, JSON, base64 and I/O paths.
- `docs/developers/v0.4-rso5-recovery-architecture.md`: original physical and work
  forecast.
- `docs/evals/v04-rso5-recovery-implementation-2026-10-26.md`: implementation and
  measurement history.

Three evidence classes are kept distinct:

1. **Artifact facts:** sums and maxima computed from the final operation records.
2. **Completed trace-analysis findings:** the supplied 41-frame recovery count and
   the 721,536 B/recovery duplicate-read analysis. These are consistent with the code,
   but the JSON does not contain a frame-by-frame trace from which to independently
   recount them.
3. **Models:** savings ranges and directional CPU, memory-bandwidth, latency and
   energy consequences. These are not measured facts and are never added to the
   artifact total.

## 2. Artifact-derived cost ledger

The complete measurement is **677,973,227 B**. Forecast was 270,132,258 B, so the
forecast delta is **407,840,969 B**. Against the unchanged cumulative comparison of
268,435,456 B, actual excess is **409,537,771 B**. The first cumulative crossing is at
**275,192,330 B** (`reserveInstall:2:2` in this artifact), before the first transfer
has completed installation. Maximum local recovery is **17,741,154 B**, and **28**
operations exceed the original 4,718,592 B operation comparison.

### 2.1 Work by mechanism

| Mechanism | Bytes | Share of total |
| --- | ---: | ---: |
| Serialize | 250,831,026 | 37.0% |
| Parse | 120,512,866 | 17.8% |
| Concat | 85,618,543 | 12.6% |
| Base64 | 54,413,173 | 8.0% |
| **Serialize + parse + concat + base64** | **511,375,608** | **75.43%** |
| Copy | 23,022,880 | 3.4% |
| Encrypt | 15,095,128 | 2.2% |
| Decrypt | 36,434,557 | 5.4% |
| Disk read | 48,692,474 | 7.2% |
| Disk write | 26,248,784 | 3.9% |
| Allocate | 10,169,075 | 1.5% |
| Legacy | 6,934,721 | 1.0% |

The dominant cost is representation churn: JSON, text/base64 encoding and repeated
buffer assembly. Encryption and decryption matter, but they do not explain the
failure. This directly contradicts an interpretation that RSO5 misses the target by
only the original forecast's 0.63%.

### 2.2 Work by operation class

Counts and values below are computed from operation labels, not copied from the
forecast. Agreement phase totals exclude the six leader proposals, shown separately.

| Operation class | Count | Total bytes | Serialize | Parse | Concat | Base64 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Prepare | 24 | 84,493,784 | 35,108,960 | 16,513,472 | 11,008,152 | 1,890,616 |
| Commit | 24 | 92,963,400 | 39,550,056 | 20,441,392 | 11,872,200 | 1,129,256 |
| Execute | 24 | 104,291,040 | 44,009,240 | 23,021,904 | 13,217,280 | 1,221,780 |
| Finish | 24 | 79,214,228 | 30,623,072 | 20,533,760 | 8,586,864 | 939,296 |
| **Prepare + commit + execute + finish** | **96** | **360,962,452** | **149,291,328** | **80,510,528** | **44,684,496** | **5,180,948** |
| Leader proposals | 6 | 1,142,996 | 34,334 | 622,916 | 13,755 | 46,677 |
| **All agreement calls** | **102** | **362,105,448** | **149,325,662** | **81,133,444** | **44,698,251** | **5,227,625** |
| Local-C recovery (excluding startup) | 4 | 70,650,281 | 34,062,920 | 1,144,256 | 15,373,324 | 11,010,798 |
| Local-C recovery startup | 4 | 6,771,140 | 3,019,692 | 1,179,144 | 967,600 | 455,420 |
| First reserveInstall | 4 | 27,390,744 | 3,376,472 | 625,456 | 2,518,732 | 10,042,280 |
| Returning reserveInstall | 4 | 24,244,700 | 5,831,896 | 4,367,408 | 2,780,384 | 4,618,600 |
| Bootstrap | 4 | 21,084,736 | 1,898,576 | 285,360 | 2,240,992 | 7,273,852 |
| Legacy preparation | 4 | 6,826,228 | 1,022,080 | 0 | 0 | 667,404 |
| Explicit observer/policy operations | 34 | 9,305,543 | 4,328,622 | 555,224 | 0 | 405,096 |
| Retry execution | 7 | 3,284,618 | 522,216 | 1,608,294 | 11,529 | 76,599 |

The four non-proposal agreement phases alone are **53.24%** of all measured work.
Local recovery is another **70,650,281 B** before startup. Its serialize, concat and
base64 total is **60,447,042 B**, **85.56%** of local recovery work. Maximum local
recovery is **3.76×** the original per-operation comparison.

## 3. Why the code produces these costs

### 3.1 Full journal decode and evidence replay occur throughout agreement

`openSustainableRecoveryRuntime.read()` decrypts and decodes the complete journal.
`decodeBusinessState()` retrieves and parses the current policy and every activation,
and retrieves/decodes any transition. Therefore even a command unrelated to an old
activation pays for the retained historical policy/activation set.

`materializeRso5Evidence()` fetches every selected vote once and every selected
certificate **twice**: once while filtering and again while mapping to the returned
certificate. Frame parsing and signature verification is also repeated during recovery:
`exactFrame()` authenticates a candidate, then the selected frame is parsed and checked
again before plaintext decoding. These are real repeated copies and verification, not
an indexing issue alone.

The agreement path multiplies this work:

- `validateProposal()` calls `expected()`, which runs `nextState()`.
- `prepare()` runs `nextState()` again for its executed speculative journal. Execute
  repeats the same pair: `validateProposal()` and an explicit `nextState()`.
- Prepare constructs four speculative journals—prepared, commit, executed and
  finished—and encodes all four for maximum-size preflight. It then writes the durable
  prepared journal.
- `signHeader()` recomputes signed header bytes for each signer. Certificate
  verification similarly reconstructs signed bytes for every signature.

The actual `nextState()` evaluation count is **120**: 24 proposals, 48 prepares and
48 executes. `propose()` reaches `expected()` once; `prepare()` reaches it through
`validateProposal()` and then evaluates its executed speculative journal; `execute()`
repeats that pair. Computing next state once per command would leave **24 evaluations**
and eliminate **96**, not 102. This does not imply deleting the full 362 MB agreement
total: each replay contains different amounts of historical policy, activation and
evidence. Exact size-only preflight is a separate change whose callsite attribution and
savings are **unknown**, not a measured result. Direct indexes can reduce uncharged CPU
work without reducing metered bytes; an index must not be presented as a byte-budget
fix.

### 3.2 Incremental checkpoints do not make state access incremental

Checkpoint payloads are incremental, but `publishCheckpoint()` computes coverage by
walking the complete committed checkpoint log and flattening every entry. Arena
`references(ids)` scans all retained frames for every requested proof. Journal decode
remains full-state. Consequently the small checkpoint body does not avoid full-chain
and full-state costs.

`encodeRecoveryJournal` emits a binary RBJ1 journal, not JSON. Every journal write
seals that complete binary journal, base64-encodes the ciphertext, and sends it to five
replicas. This is **full binary journal replication**, distinct from JSON/base64
**protected-state envelope churn**. Each replica can reread its previous JSON state
record, verify the signed record, write it, reread it for the reply, and sign a
JSON/base64 reply. The controller again serializes and verifies those replies. A small
incremental checkpoint therefore suppresses neither full binary journal replication
nor historical replay or JSON/base64 state-envelope work.

### 3.3 Local-C recovery amplifies frame and delegation traffic

`recoverSelected()` processes proofs serially. For each missing proof, `recoverProof()`:

1. Requests the complete frame from all five replicas and groups exact payloads by
   digest.
2. If no local delegation exists, requests a **complete delegation list** from every
   replica and requires a matching group.
3. Opens the selected delegation once in `currentDelegation()` and opens it again in
   `recoverProof()` before installing the scope-key entry.

The completed trace analysis counted **41 recovered frames**, giving up to **205
list responses**. The source confirms the multiplicative behavior. The JSON artifact
contains operation-level usage, not enough detail to independently recount those
frames, so this count is labeled trace evidence rather than recomputed artifact fact.

Remote delegation records are not appended locally for reuse. Scope-key entries are
retained in memory, but subsequent proofs still perform remote list discovery while
the local delegation archive is empty. Signed JSON/base64 replies also incur reply
serialization and signature verification on both sides.

The four-status/one-payload analysis is an **upper-bound model**, not a measurement:
**721,536 B per recovery**, or **2,886,144 B across four recoveries**, from avoiding
duplicate remote frame reads. Full-list and signed-reply savings are additional but
**unquantified**. These modeled upper bounds must not be presented as measured savings
or used alone to support cap feasibility.

### 3.4 Mandatory observer/policy work was missing from the original model

The forecast could not be validated by removing work from measurement. The completed
instrumentation now includes observer roots/open/ready, drains, activation creation,
policy signing/advancement, observer advancement and every fresh-policy
request/certificate/history path. Explicit observer/policy operations account for
**9,305,543 B**, and additional policy work is nested inside runtime startup and retry
operations. Original vote and retry proposal construction is included as well.

Thus the model failed in four distinct ways: full-state replication, historical
evidence replay, recovery delegation amplification, and mandatory observer/policy
work. It is not a single arithmetic error and not just a crypto cost.

## 4. Resource consequences beyond the byte counter

The meter measures reconstruction/copy work, not energy or elapsed time. There are
**no per-operation latency, power or energy measurements** in this analysis.

Directionally, repeated JSON/base64 conversion, full-frame downloads and journal
replication increase:

- CPU consumption from parsing, signing, verification and garbage collection;
- memory bandwidth and transient allocation pressure from complete images and replies;
- network payload and replica I/O from full frames, delegations and state;
- latency from serial proof recovery and five-party response processing; and
- energy consumption from the combined CPU, memory, network and disk activity.

Those are engineering consequences to measure in any future implementation, not
claimed latency or power numbers.

The same mechanisms are also a scaling hazard. Activation reads and journal size grow
with retained history. Re-reading and revalidating complete history per agreement step
makes the current approach **quadratic** in transitions/proofs. A 100-transition run
would require explicit C, transition and proof limits before it is even well formed.
No such limits are admitted here. This analysis does not claim a 100-cycle total,
physical fit, completion time or successful physical closure.

## 5. Cheaper alternatives

All alternatives preserve original business objects and signature domains, five pinned
members, quorum four, at most one Byzantine, exact proof identities, authorized epochs,
four-copy availability, authenticated replay/forks/floors, role privacy, original
rights/denials/uncertainty and physical caps. Any work accounting must include every
real binary copy, parse, signature and I/O operation; binary encoding is not a license
to undercount.

### A. Delta journals and incremental signed control records

**Code targets:** `runtime.write`, `encodeRecoveryJournal`, `decodeRecoveryJournal`,
`nextState`, protected state records and startup/replay logic.

**Design:** Persist a full signed state snapshot only at cuts. Between cuts, append
small signed control deltas containing exact previous roots, configuration/view/
sequence, changed evidence references and prepared/locked/stable transitions. Replicas
retain the cut snapshot plus at most the funded 32-slot suffix. The current root is
recomputed from the snapshot and deltas, and all deltas must be available in four
copies before the corresponding agreement step completes.

**Why it matters:** This is the only proposal that directly removes full journal image
replication from every agreement phase. It also bounds suffix decoding instead of
rebuilding every policy/activation history per command. It is likely necessary, not a
micro-optimization.

**Expected savings:** Dominant direction, unquantified. The 362,105,448 B agreement
class is the target, but no exact reduction is promised.

**Tradeoffs:** More complex deterministic replay and crash recovery; suffix pruning
cannot discard prepared locks, stable cuts or required proof floors. Before this design
is meaningful it needs an explicit crash/funding/compaction model for signed deltas,
root reconstruction, snapshot pending generations and four-copy availability. That
model must cover all prepared locks and floors and prove that compaction cannot discard
required evidence or generations. Startup and cold recovery work may increase rather
than disappear. Recreating RSO4's mixed-generation failure is not acceptable.

**Required tests:** Incremental/full reducer equivalence for every command and retry;
torn delta/snapshot writes; 0/1/3/4-copy crashes; fork/equivocation floors; 32-slot
exhaustion; mixed returning histories; exact current-root and four-delta availability;
cold and returning recovery; old activation access only when needed.

### B. Signed-bytes binary transport and exact digest/status replies

**Code targets:** `recordBytes`, `stateBytes`, `replyBytes`, protected `exchange`,
frame/delegation/checkpoint request and response encodings.

**Design:** Use versioned binary records whose signed bytes are transmitted unchanged.
For existing frames/delegations/checkpoints, request exact digests from four replicas
and payload only when required. Use binary exact-status replies rather than duplicating
JSON/base64 payloads and signatures around them. Preserve the existing signature
domains rather than signing a new JSON projection.

**Expected savings:** The claimed **60–65R** repeated-representation reduction and
**160–200 MB** across 96 agreement writes are **untested hypotheses with no defensible
derivation**, not expected savings or support for cap feasibility. Every required
binary parsing, signature, read, write and four-copy replication step remains and must
be charged.

**Tradeoffs:** A new strict wire format and migration matrix are required. Digest-only
replies increase round trips unless carefully batched. Payload-on-demand needs
Byzantine digest grouping and retry behavior.

**Required tests:** Signed-bytes equality end to end; exact replay and same-revision
conflicts; malformed lengths; digest substitution; transport copy accounting; four-copy
ack byte equality; mixed old/new binary checkpoint chains.

### C. Incremental authenticated evidence/activation indexes and single-pass transitions

**Code targets:** `materializeRso5Evidence`, `nextState`, `validateProposal`,
`prepare`, `execute`, `decodeBusinessState`, activation access and speculative
`encodeRecoveryJournal` size computation.

**Design:** Maintain authenticated indexes from issuer/spend to vote/certificate proof
references and from configuration/activation to the required policy objects. Fetch each
selected proof once. Compute the next state once per agreement command. Replace
speculative journal encodings with exact size-only accounting over the same field
schema. Keep activation lookup on demand rather than reading every activation for every
journal read.

**Expected savings:** Computing next state once per command eliminates **96**
`nextState()` evaluations, leaving 24 from 120. Exact size-only preflight has unknown
callsite attribution and unknown savings; no roughly 3 MB estimate is supported. Direct
indexes can additionally reduce CPU, but that does not prove byte savings.

**Tradeoffs:** Index correctness becomes consensus-critical. An incomplete index can
hide a denial or conflict, so it must be reconstructed and checked against the full
reducer. Cached activation/policy objects need lifecycle invalidation rules.

**Required tests:** Incremental versus full reducer equivalence for conflicts, denials,
split uncertainty and retries; current/old-set lookups; every activation/returning
boundary; proof fetched exactly once; prepare/execute nextState exactly once; exact
size versus actual binary encoding; crash/restart index equivalence.

### D. Four-status/one-payload recovery with durable delegation and key reuse

**Code targets:** `recoverSelected`, `recoverProof`, `remoteList`,
`currentDelegation`, delegation archive and `scopeKeys` restoration.

**Design:** Query frame/delegation status from four replicas, fetch one exact payload,
and use digest-race retry only when no exact payload or a conflicting digest arrives.
Restore selected delegations durably before proofs, open each once, and reuse installed
scope-key versions across all selected proofs. Batch checkpoint/delegation discovery
instead of requesting full lists per proof.

**Expected savings:** The **721,536 B per recovery** and **2,886,144 B across four**
figures are upper-bound models, not measured savings; full-list and signed-reply effects
remain unquantified. It improves recovery traffic but cannot solve the agreement total
alone.

**Tradeoffs:** More protocol states and retry scheduling. A fast but conflicting
replica must not win. Durable delegation restoration must preserve exporter, recipient,
key-version and enrollment authentication. Restoration adds delegation validation,
writes and retained bytes; those effects are not free or implicitly funded and must be
preflighted within the existing **3,549 B C headroom** before any append.

**Required tests:** Byzantine payload/digest races; one/two bad responders; list versus
payload conflicts; durable delegation reopen; scope-key reuse across 41 proofs;
predecessor-disabled recovery; exact proof/kind/length/digest checks; delegation
restoration before checkpoint floors; preflight proof that all restored delegations,
validation writes and retained bytes fit the 3,549 B C headroom.

## 6. Can these meet the original limits?

| Alternative | Credibly sufficient alone? | Reason |
| --- | --- | --- |
| A: Delta journals | **No evidence it is sufficient alone** | It attacks the largest structural term, but recovery, evidence and protocol churn remain. |
| B: Binary transport | **No** | It reduces representation churn but not historical replay, delegation amplification or full-state reconstruction. |
| C: Incremental evidence | **No** | It removes replay and index costs but does not remove full journal replication. |
| D: Efficient recovery | **No** | Its modeled upper bound is small relative to the 409.5 MB cumulative excess and agreement cost. |

A+B+C+D could justify **one bounded research forecast** because their mechanisms are
complementary: A removes repeated full-state replication, B removes transport churn, C
removes historical replay, and D removes recovery amplification. That is a reason to
evaluate a coherent design, not a numeric combined forecast and not a promise that the
result fits. No supported basis exists to claim either 4,718,592 B per operation or
268,435,456 B cumulative will be met. Physical C, transition and proof limits would
have to be established independently before any 100-transition scenario.

The A–D ordering below is **research only**, not an implementation GO, cap-feasibility
claim or guarantee of fit.

### Research order if the original cap is mandatory

1. **Design and review A first.** If delta journals cannot be made crash-safe and
   physically bounded, stop; micro-optimizations will not rescue the architecture.
2. **Add C** so replay and evidence indexes do not recreate full history at every step.
3. **Add B** to suppress signed JSON/base64 transport churn without changing signature
   domains.
4. **Add D** and measure full local-loss recovery independently.
5. Only then produce a single bottom-up bounded forecast covering all mandatory
   observer/policy work, binary copies and failure paths. Do not start another
   implementation round without that forecast and independent review.

### Research order if the goal is simply cheaper recovery

D offers the most contained recovery-specific improvement and a modeled upper bound. B
and C then reduce general representation and replay costs. A remains necessary for
long-running scalability and should not be deferred merely because smaller improvements
help the finite fixture.

## 7. Conclusion

RSO5's measured failure is architectural. Full-state replication, historical evidence
replay, delegation/list amplification and mandatory observer/policy work invalidated
the forecast; they were not optional overhead and cannot be normalized away. The
75.43% representation-churn share and 53.24% agreement-phase share explain why small
cryptographic tweaks or direct indexes cannot credibly rescue the limits.

A+B+C+D is a coherent alternative research direction, not an implementation approval,
GO decision, acceptance claim or guaranteed fit. Delta journals are the essential
structural research topic; binary transport, incremental evidence and efficient
recovery address complementary costs. Any next step should be a bounded, independently
reviewed design and forecast, with exact invariants and failure evidence, rather than
another RSO5 tuning pass.
