# DEC-021 client-held discovery implementation-feasibility conclusion — November 22, 2026

## Final verdict

**ACCEPT FOR BOUNDED PROTOTYPE EVALUATION.** The revised design provides a plausible implementation for a bounded evaluation prototype. This is not implementation authorization, production acceptance, K1–K8/R acceptance, model selection or release approval. A prototype requires a separate owner decision and must satisfy the staged controls and stop criteria.

The specification is `docs/developers/v0.4-client-held-discovery-architecture.md`; authorization and scope are `delivery/decisions/DEC-021.md`.

## Findings resolved

The DEC-020 independent findings and DEC-021 follow-up correction are resolved in the specification:

- Generation-scoped mailbox deposit, replacement and ACK records permit refreshed-index redeposit while preserving stable logical request IDs, recipient dedup, immutable expiry and safe old-generation drain.
- Lease sequence and semantic revision are separate. Lease-only refresh does not re-match or clear notification dedup; match/notification identity persists across restart, repair and semantic revision.
- One-active-writer reconciliation, full-byte exact duplicate checks, conflict retention/quarantine, withdrawal dominance, stored/queued distinctions, sender uncertainty, inbox-before-ACK and compaction barriers are specified.
- Stable `clientLeaseId` is an explicit prototype choice for quota enforcement, with cross-refresh linkability documented and full K5/K6 evaluation still open.
- Original-content fulfillment remains dependent on the required clients being online; permanent client/key/original loss is not repaired by relays.
- The first protocol spike uses fixed derivation/embedding fixtures and needs no generative model or new queue dependency. Model/runtime evaluation remains a separate owner-approved arm.

No remaining specified schedule was found that inherently produces a duplicate spend/notice, loses an acknowledged request within the declared two-of-three replica-loss envelope, or resurrects an ACKed/withdrawn request. This is a design-review conclusion, not an executed safety proof.

## Corrected inclusive quota

The final model charges both active and draining generations:

```text
per logical request                       223,232 B
fixed per lease                            53,248 B
16 requests + fixed                    3,624,960 B
4 MiB allowance                        4,194,304 B
remaining headroom                       569,344 B
```

The count and actual-byte caps are independent. The maximum-cardinality control fills all 16 logical requests with active+draining generations, conflict evidence and prepaid ACK/withdrawal state, rejects the 17th request, rejects actual byte overflow and verifies maintenance at full quota.

## Plausible prototype boundary

The specification maps concrete source changes and stages:

1. Versioned schemas, exact replay and inclusive quota ledger.
2. Lease/refresh/withdrawal/conflict state and notification identity.
3. Generation-aware encrypted offline mailbox and fault matrix.
4. Authorized online original delivery and content commitment verification.
5. Composed resource, privacy and client-offline/loss evaluation.
6. Optional separately approved local-model comparison.

The bounded replica claim is limited to three selected signed receipts and repair after losing up to two of those copies. It is not Byzantine-receipt safety or arbitrary-disaster recovery. Actual implementation must execute the full staged controls, including old-ACK/new-deposit races, withdrawal-before-deposit, recipient crash around inbox/ACK, compaction crash and the full two-generation quota case.

## Next owner decision

Decide whether to authorize the bounded protocol prototype. Production feasibility, privacy, availability, economics, model selection and K/R acceptance remain open. FEAT-001 control-plane recovery is unchanged and remains open.
