# DEC-014 production recovery architecture review — November 19, 2026

## Decision

**RSO7 receives REVISE and is not ready for implementation.** Full BFT-engine adoption is rejected for this pass. No production, R1/R2, K1–K8, economic or release acceptance follows. A revised RSO7 requires a separate owner decision under the existing stop policy.

The comparison and design specification are in `docs/developers/v0.4-rso7-recovery-architecture.md`; owner authorization is `delivery/decisions/DEC-014.md`.

## Alternatives compared

### Candidate A — authenticated single-transition state machine

Each voting member independently evaluates the exact original transition at most once, compact certificates authenticate the resulting mutation, stable cuts replace repeated full-journal reconstruction, and immutable role-private evidence remains separate. This directly targets the measured RSO5 representation/reconstruction cost while retaining the TypeScript verifier.

The initial forecast claimed:

- C=258,595 B against 262,144 B;
- maximum local recovery 4,613,447 B against W=4,718,592 B;
- cumulative work 214,492,899 B against 268,435,456 B.

Those were forecast values only. Independent review falsified the present closure.

### Candidate B — full established BFT-engine adoption

BFT-SMaRt supplies established Byzantine ordering and state transfer compatible with the basic five-member/one-Byzantine fault size, but full non-sidecar adoption requires a Java port of the live deterministic business core and custom funded durability. Its stock client receipt, state-transfer, durability, view-distribution and timing behavior do not supply Resonance's complete acknowledgment, private recovery, original authority or four-copy semantics.

The difficult private recovery work remains while language/runtime migration and JVM operational costs are added. No credible bottom-up resource advantage or complete forecast was established. Candidate B is therefore rejected for integration/economic scope, not declared universally unsafe.

Primary references include the [BFT-SMaRt paper](https://www.di.fc.ul.pt/~bessani/publications/dsn14-bftsmart.pdf), [ApplicationState contract](https://bft-smart.github.io/library/javadoc/bftsmart/statemanagement/ApplicationState.html), and [v2.0 implementation notes](https://raw.githubusercontent.com/bft-smart/library/v2.0/README.md). These do not establish Resonance correctness or fit.

## Independent RSO7 findings

### 1. Mandatory cold delegation restoration exceeds W

The published cold-reserve total 4,490,505 B omits durable delegation restoration `11*Del=261,393 B`.

```text
published cold reserve       4,490,505
required restoration           261,393
corrected subtotal           4,751,898
W                            4,718,592
excess                          33,306
```

This is a concrete forecast failure, not an unmeasured margin. It cannot be repaired by deleting mandatory work or invoking the DEC-012 research budget.

### 2. View-change and stable-cut records are incomplete

New-view records must carry and authenticate the committed chain, commit QCs, suffix entries and every required prepared lock, with exact configuration/genesis scopes and deterministic selection. Local higher floors/locks must block stale installation.

Stable votes must bind one canonical statement covering transition, storage, evidence, delegation and, at a cut, snapshot identity. The current 141-byte vote and 852-byte stable-head arithmetic do not encode the stated fields consistently.

### 3. Physical closure is incomplete

Current+pending intents/heads are capped at 2,048 B, while pending `T+M` alone is 2,748 B before command material, prepared QC, locks, archive metadata or heads. Pending records are not separately funded in D.

Fixed 65,536 B state, 72-entry index and 2,208 B mutation bounds do not prove closure for all accepted rows, permanent denials, competing bindings, policy/activation ancestry or >64 configurations. Existing reducers permit substantially larger inherited categories.

### 4. Maximum torn snapshots exceed F

A sealed state image is 65,820 B against F=32,768 B. The stated maximum snapshot-tear schedule therefore refuses rather than proving bounded local recovery. Atomic replacement must confine the failed extent to a funded tail, or that schedule fails.

### 5. The cumulative command mix is wrong

The actual four-node scenario has 12 non-cut and 12 cut integrated member operations, not 18 non-cut and 6 cut. Replacing only that mix adds 3,557,688 B. Adding four omitted cold restorations adds another 1,045,572 B. These demonstrate invalidity; neither result is a complete corrected forecast.

### 6. Operation derivations are incomplete

Full local-C recovery, startup, export, install, forced cut, view change, retry and observer/policy work lack complete RSO7 primitive derivations. Local recovery's published value includes an unexplained 951 B difference and does not demonstrate the four-entry suffix charge. Leader/member roles and possible duplicate control-record work need separation.

### 7. Historical provenance differs from the retained artifact

The retained RSO5 artifact sums to 677,938,671 B, while the RSO7 document reports 677,973,227 B, a 34,556 B difference without an identified additional class. Later accepted DEC-012 research evidence uses the former's corrected instrumented history; the RSO7 provenance must name its exact source instead of silently mixing artifacts.

## Minimum revision and decision gate

A materially complete revision must:

1. Specify view change, committed chains, prepared locks, stable statements, acknowledgment/promotion/retirement and successor fencing.
2. Define complete binary schemas and recompute affected records.
3. Fund pending commands/transitions/locks/heads, ancestry, indexes, temporary generations and failed extents.
4. Prove mutation/state/index bounds for every original command and >64 configurations.
5. Supply primitive equations for every operation and charge every vote, receipt, payload, restoration and durable write exactly once.
6. Use the actual cumulative command schedule and correct historical provenance.
7. Resolve torn-snapshot recovery and the cold-reserve overflow through architecture, not deleted obligations.

One bounded revised design review is justified only after those corrections and a new owner decision. No implementation spike, campaign, dependency installation, production routing or release is authorized.
