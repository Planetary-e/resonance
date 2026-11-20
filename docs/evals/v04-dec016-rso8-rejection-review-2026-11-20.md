# DEC-016 RSO8 independent rejection review — November 20, 2026

## Verdict

**CONFIRM REJECTION.** `RSO8-Range32` has multiple independent falsifiers. No revision, implementation or production/R1/R2/K/R acceptance is justified. This rejects the presented sharded candidate, not every conceivable architecture.

The candidate specification is `docs/developers/v0.4-rso8-recovery-architecture.md`; authorization is `delivery/decisions/DEC-016.md`.

## Decisive physical failures

### Fixed-five storage impossibility

The actual minimum reducer-produced search row is 276 B. For 10,000 legal accepted rows, four copies and current+pending generations with optimal placement across five volunteers:

```text
one generation                    10,000*276 =  2,760,000 B
current+pending                 2*2,760,000 =  5,520,000 B
four copies                     4*5,520,000 = 22,080,000 B
average per five nodes         22,080,000/5 =  4,416,000 B
D excess                       4,416,000-524,288 = 3,891,712 B
```

One generation alone averages 2,208,000 B per node after four-copy placement. At least 43 storage volunteers are necessary for two plaintext generations under perfect divisibility, before pages, indexes, manifests, consensus or failures; 43 is not a sufficiency claim.

### Hot-key shard overflow

The original parser permits 10,000 combined votes/certificates/accepted rows/denials without a per-spend balance guarantee. A legal state can place all vote/certificate proof references on one spend and therefore one range shard:

```text
one generation       10,000*32 = 320,000 B
current+pending                  = 640,000 B
D                                  524,288 B
excess                             115,712 B
```

Rows, indexes, manifests, sealing and consensus state are excluded, making this a conservative and independently decisive `Range32` falsifier. Originals in C do not eliminate semantic locators.

The balanced 32-shard subtotal of 444,740 B per member recomputes correctly, but its nominal 79,548 B remainder excludes global control, cross-shard state, migration and configuration growth and is not closure evidence.

## Work and aggregate failures

Inherited forecast equations produce:

| Operation | Forecast | Excess over W=4,718,592 B |
|---|---:|---:|
| Cold reserve | 5,321,454 B | 602,862 B |
| NEW_VIEW import | 5,206,766 B | 488,174 B |
| Local-C recovery | 5,174,231 B | 455,639 B |

Two all-shard terminal cuts forecast 448,502,720 B against cumulative 268,435,456 B, before observer/policy, retries, failures, private transfer or recovery. These are inherited forecast falsifiers, not measured universal lower bounds. Per-shard work resets are forbidden.

Under the retained additive baseline, 160 data-member scopes produce 604 entries against 512, an excess of 92 before control entries. Bytes remain under 2 GiB in that arithmetic. This entry result is conditional on the additive baseline, unlike the physical counterexamples.

## Original-semantics routing defect

Spend-range routing correctly colocates same-spend votes, certificates, accepted bindings, conflicts, splits and retries across issuers and historical sets. However, the claim that a legacy attribution batch affects only its explicitly listed spends is false.

The original reducer removes selected rows **and every other row belonging to the attributed issuer keys**, then permanently retires those issuers. Therefore explicit spends do not enumerate all mutated shards. A transaction limited to them would leave issuer rows elsewhere and fail to reproduce the original transition. A correct participant set must include every shard containing those issuers' rows; the global denial head alone does not repair this defect.

## Protocol references and scope

OmniLedger/Atomix supports initialize→lock→unlock commit/abort, acceptance from every input, rejection for abort and another party driving a stalled unlock. Its permissionless sampling, UTXO model and pruning do not establish Resonance safety or retention. RapidChain's large sampled honest-majority committees and synchronous model likewise do not match five-member/quorum-four volunteer trust.

Certificate-gated cross-shard outcomes, durable descriptors, participant-lock recovery, old-cohort fences and ciphertext-only replicas are reasonable qualitative shapes, not executable safety proofs. Configuration >64 closure and non-finite private recovery remain unestablished.

## Next decision

Close DEC-016 and RSO8-Range32 as rejected. If production recovery continues, the owner must separately authorize a genuinely different architecture or suspend the line. Do not delete originals, reduce legal workloads, enlarge caps, hide global indexes, reset per-shard work or infer implementation authorization.
