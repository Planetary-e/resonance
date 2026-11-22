# DEC-020 client-held discovery independent review — November 22, 2026

## Verdict

**REVISE.** Client-held originals are a credible content-plane simplification for future evaluation, but the composed design is not implementation-ready. No implementation, model selection, production/K/R acceptance or release follows.

The proposal is `docs/developers/v0.4-client-held-discovery-architecture.md`; authorization is `delivery/decisions/DEC-020.md`. This exploration does not replace FEAT-001 control-plane recovery.

## 1. Refreshed-generation mailbox redeposit is contradictory

Logical request IDs exclude index generation, while storage IDs derive only from mailbox ID and request ID. Inner signed fields bind the exact index sequence/digest, and same storage ID with different bytes is a conflict.

A refresh retaining the same mailbox therefore makes a legitimate redeposit change signed bytes without changing storage ID, causing rejection. Accepting replacement without generation-aware ordering would also let an old-generation observed-remove ACK remove the refreshed deposit.

Required correction: generation-specific storage keys or authenticated supersession with exact old/new generation linkage, stable logical dedup, immutable request expiry, lease-wide quota and safe ACK ordering.

## 2. Lease refresh can duplicate match notices

The existing `replaceAndMatch()` removes the old item, clears withdrawal state, deletes notified pairs involving the publisher and re-runs notification generation. A lease-only refresh can therefore create a second pending notification.

Required correction: stable match/notification identity across lease-only refresh, persisted across restart/replica repair. Distinguish refresh from a semantic revision that legitimately re-matches. Cover pending delivery and restart schedules.

## 3. Mailbox count and byte caps are not jointly satisfiable

Thirty-two maximum 16-KiB envelopes consume exactly 512 KiB before journal rows, ACK/tombstones, admission evidence, dedup state, placement metadata, old-generation drain, conflicts or replacement peaks.

Required correction: define whether 512 KiB is envelope-only or fully inclusive. If inclusive, derive a smaller effective count from complete maximum records. Enforce both count and bytes across generations; exact duplicates and ACK maintenance must remain possible at full quota without uncharged growth.

## 4. Privacy remains open

Safe defaults include private originals/generated text/true embeddings/commitment keys/contact addresses and explicit scoped content grants. HMAC with an independent random key avoids a public unsalted-content confirmation oracle.

These do not solve K5/K6. Public LSH remains vulnerable to known-text/reconstruction attacks; refresh-stable commitments, publication IDs, fingerprints and `clientLeaseId` create linkability. Owner challenges reveal recent activity; mailbox counts, timing, polling and content delivery remain observable.

The owner must decide stable lease pseudonymity versus a separate quota credential. Generated text remains private by default. Full K6 passive/cooperating/Sybil/cross-session games remain required.

## 5. Durability and crash protocol remain incomplete

Useful distinctions are preserved: one-relay `stored` is not multi-replica `queued`; exact immutable sender replay resolves uncertainty; local inbox commit precedes storage ACK; observed-remove ACKs resist stale resurrection; old generations drain with retained authentication and keys.

Before implementation:

- Define the declared replica-loss envelope for `queued`, never equating it with recipient delivery.
- Retain exact sender outbox until sufficient evidence, ACK or immutable expiry.
- Retain conflicting same-sequence operations and quarantine fan-out; current publication-store conflict return does not retain the incoming operation.
- Preserve historical mailbox authentication/keys/routes through drain.
- Compare complete ciphertext/signed bytes for duplicate IDs; current enqueue returns duplicate from ID alone.
- Preserve withdrawal/ACK anti-entropy until no stale deposit is admissible.
- Prove every crash/retry/compaction boundary without lost acknowledgment, duplicate notice or stale resurrection.

## 6. Resource and product scope

For 10,000 maximum 4,096-byte indexes at five replicas, raw current payloads total 204,800,000 B, excluding revisions, journals, mailboxes, matches, metadata, conflicts, repair and replacement peaks. This is not a fit claim.

The model shifts original-content durability/availability to clients. Offline owners cannot deliver originals, permanent client/key/original loss is not repaired by relays, and refresh/polling/repair introduce explicit maintenance. Discovery and original-fulfillment denominators must be frozen separately. Authority, policy, issuer, witness, wallet and configuration recovery remain unchanged and open.

## 7. Local model evaluation

The evaluation plan is broadly sound: existing Nomic Transformers.js FP32 feature extraction, Qwen GGUF Q4_K_M llama.cpp comparison, optional MLX arm, no-generation control, independent English/Spanish holdouts, human faithfulness review, strict output validation, exact cache identity and physical resource measurements.

No model is selected. Parameter-count arithmetic is not download size or RSS. Qwen2.5-3B uses the Qwen Research License and needs separate commercial/distribution review; 1.5B and 0.5B are Apache 2.0. The owner must approve the summary-faithfulness screen and local-generative AI-contract change. Model quality does not resolve fingerprint or observer privacy failures.

## Minimum revision before an implementation decision

1. Fix generation-aware mailbox storage/redeposit/replacement/ACK semantics.
2. Specify lease/withdrawal/conflict transitions, fork retention, one-writer reconciliation and refresh notification dedup.
3. Produce a complete inclusive quota ledger and replica-durability model.
4. Define every crash/retry/drain/withdrawal/compaction boundary.
5. Decide lease pseudonymity versus quota credential and preserve full K5/K6 evaluation.
6. Freeze discovery/fulfillment denominators, client-loss responsibility, maintenance schedules and the unchanged control-plane boundary.
7. Freeze model/runtime/cache/evaluation identities and resolve licensing.

A bounded specification revision is reasonable. Any implementation spike requires a separate owner decision after that revision and review. No production, K1–K8, R, release or control-plane recovery acceptance follows.
