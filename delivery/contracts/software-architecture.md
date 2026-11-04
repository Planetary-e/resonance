---
contract_id: ARCH-CONTRACT
title: Software architecture contract
version: 1
status: draft
updated_at: "2026-10-25T19:34:44Z"
owners:
  - role: software_architecture_owner
    name: unassigned
  - role: security_reviewer
    name: unassigned
approvals:
  - decision_id: null
    status: pending
    scope: software_architecture
related_ids: [PRD-CONTRACT, AI-CONTRACT, CMP-CONTRACT, DEC-001]
---

# Software architecture contract

## System context and constraints

Resonance is an existing TypeScript/Node research prototype, not a production network. Workspaces are `packages/core` (cryptography, local embeddings/fingerprints, protocol objects and mailboxes), `packages/node` (CLI, encrypted local state, clients, migration and channels), `packages/relay` (matching, durable journal, replication, authenticated relay links and delivery), `packages/app` (Tauri/React desktop plus local Node backend and optional OS relay service), and `packages/eval` (quality/privacy/resource/recovery evaluations). Root engines require Node >=24.

The intended deployment has personal nodes, independently operated volunteer relays, separate policy/witness/issuer roles, and fresh pairwise relationships. Trust remains five pinned members, four confirmations, at most one Byzantine. R1–R6 is the required order. RSO3/RSO4 are rejected; the accepted 13/46/noEmit finite slice is not R1/R2 or K acceptance. No recovery implementation is authorized under DEC-001.

Binding limits include 2 GiB aggregate storage, 512 reservation entries, independent 1 MiB serialized metadata, 256 MiB cumulative reconstruction/copy work, 3 s live and 30 s offline deadlines, and original C=262144/L=65536/P=65536/D=524288/F=32768 for the recovery line. The complete K1–K8 thresholds in the product/evaluation contracts are architecture constraints.

Sources: `README.md`; `HANDOVER.md`; `docs/developers/v0.4-acceptance-kpis.md`; `docs/developers/v0.4-execution-roadmap.md`; `docs/developers/v0.4-completion-plan.md`; `package.json`.

## Components and boundaries

- **Personal node / app backend:** owns raw text, true embeddings, root and personal scoped keys, chosen disclosures and channel plaintext. It performs local embedding and exact user-visible retry/notice handling. It must not export those secrets to relays or evaluation artifacts.
- **Core:** provides versioned deterministic primitives and schemas. It does not make eligibility, legal, release, or protocol-acceptance decisions.
- **Relay:** sees scoped identifiers, fingerprints, similarity, ciphertext and network/routing metadata. It must not require raw text, true embeddings, root/personal/role-private keys or channel plaintext. Existing public-projection matching and experimental transport are not accepted privacy architectures.
- **Policy/witness/issuer roles:** hold separate role-private state and keys. Issuer loss cannot require a permanently connected issuer; role separation cannot be removed to simplify quorum dependencies.
- **Relay-to-relay and forwarding:** authenticated, bounded and explicitly scoped. The inherited experimental two-hop HPKE path is not K6-qualified and must not be represented as approved observer privacy.
- **Desktop local API:** loopback-only with Host/Origin/Bearer controls. The UI cannot turn these controls into a substitute for protocol authentication or expose the service on a non-loopback interface.
- **OS service/package:** optional relay enablement installs/removes a user-level OS service with explicit effects. Personal and relay stores/identities/lifecycles remain separate on the same device.
- **Eval:** measures frozen candidates but is outside production trust and cannot approve its own output.

Forbidden edges include relay/hosted-provider access to personal plaintext or true embeddings; production adoption of unreviewed recovery/matching/mixing designs; unbounded schemas/frames/deadlines; silent non-loopback binding; automatic dialing of unverified peer hints; and merging private roles to obtain a pass.

## Interfaces and data contracts

Every production inbound/outbound path requires mapped authentication, canonical signature verification, bounded schema/frame/deadline enforcement, and key-storage enforcement with negative tests. Protocol objects carry explicit versions, scoped identities, operation identifiers, expiry/cutoff and exact retry semantics. Unknown/ambiguous state fails closed before mutation.

Retries reproduce the original operation and durable outcome; they do not create a second allocation, spend, consent, withdrawal, or notification. Permanent denials remain denied, conflicts preserve evidence, and uncertain outcomes are never displayed as acknowledged success. Reconnecting nodes obtain current authenticated policy before authorizing.

Search results and relay-signed scores are not independent match proofs unless a reviewed protocol establishes them. Receipt-scoped checks require prior receipts and cannot become inventory enumeration. Error/refusal behavior distinguishes capacity, stale/conflict/terminal state, unsupported group, invalid input and temporary unavailability without leaking private local data.

Compatibility and migrations preserve accepted rights, original evidence, scoped-key separation and durable retry identity. Model/config/protocol changes require new frozen candidate identity and affected requalification.

## Data ownership and lifecycle

Canonical personal records and root/scoped private keys remain in encrypted user-controlled stores. Role-private issuer/wallet/witness/policy state remains with the authorized role. Relays retain only the minimum scoped protocol state, ciphertext, fingerprints and metadata necessary for accepted obligations. Pairwise plaintext is available only to consenting peers.

Retention is not inferred from stale documentation: each store/record/log/cache/receipt/tombstone/backup needs an explicit purpose, owner, duration/event, deletion mechanism and legal/deployment review. Withdrawal, expiry, compaction, correction and erasure behavior must preserve mandatory safety evidence while avoiding claims that a tombstone equals complete physical erasure. Backups, temporary replacement peaks and previously funded obligations count against limits.

No delivery artifact contains raw user content, private keys, true embeddings, channel plaintext or unredacted personal/network data. Sanitized aggregates and protected evidence references are sufficient.

## Architecture invariants

| ID | Invariant | Rationale | Enforcement | Evaluations |
|---|---|---|---|---|
| ARCH-001 | Trust and data flows enforce personal/role-private plaintext and keys; relays/observers receive only declared scoped data; declared K5/K6 adversaries are explicit | Prevent false confidentiality and observer-privacy claims | Versioned data-flow/threat-model review plus negative production-path audit and privacy games | EVL-001, EVL-003, EVL-011, EVL-013, EVL-015 |
| ARCH-002 | Personal, relay, issuer, wallet, policy and witness roles/keys/stores remain separate; loss of quorum refuses rather than accepts | Contain compromise and preserve volunteer trust | Authenticated role boundaries, independent stores, 4-of-5/one-Byzantine fault review | EVL-003, EVL-005, EVL-007, EVL-014, EVL-015 |
| ARCH-003 | Every persisted/transmitted data class has explicit owner, purpose, retention/deletion and evidence treatment | Avoid unsupported retention and erasure claims | Reviewed data register, lifecycle tests and operator guidance | EVL-016, EVL-018, EVL-020 |
| ARCH-004 | Packaged runtime preserves loopback Host/Origin/Bearer controls, separate roles, resource limits and explicit OS service/install effects | Prevent insecure or unaudited deployment drift | Package/platform/accessibility review and negative local-boundary tests | EVL-012, EVL-013, EVL-017 |
| ARCH-005 | Exact durable originals, pins, evidence, rights, denials and retry identity survive; prospective complete physical closure precedes freeze/readiness/accepted intent/promises | Prevent acknowledged loss and unfunded recovery | Durable barriers, exact physical-byte preflight, crash/fault negatives, 100/>64 only after reviewed new path | EVL-002, EVL-003, EVL-004, EVL-010, EVL-016 |
| ARCH-006 | All interfaces authenticate, canonically verify, bound schemas/frames/deadlines, enforce key storage and apply policy freshness before effects | Block malformed, stale, spoofed and unbounded operations | Interface inventory and adversarial negative suite | EVL-001, EVL-005, EVL-006, EVL-015 |
| ARCH-007 | Source, dirty-tree identity, data, model, tokenizer, config, dependencies and packages form one frozen integrated candidate | Prevent composing incompatible gate passes | Candidate manifest, reproducible evidence links and release review | EVL-001, EVL-014, EVL-017 |

## Nonfunctional requirements

K1 latency/success, K2 recovery/storage, K3 update freshness, K4 fairness, K5 quality/privacy, K6 observer AUC, K7 resource and K8 availability thresholds are mandatory, not advisory. Observability uses sanitized counts, denominators, latency distributions, per-role/quorum availability, resource usage and failures without creating a private activity log.

Accessibility requires complete keyboard journeys, visible focus, accessible names and understandable error/notice/consent states. Maintainability requires one coherent state machine per accepted path rather than parallel incompatible recovery/admission/matching implementations. Costs include cold model download/initialization, retries, maintenance, recovery and all physical network edges.

## Failure, recovery and rollback

Expected faults include process death during persistence, lost replies, partitions, stale/corrupt restores, competing writers, exhausted reservations, issuer loss, relay churn, NAT/TLS events and missing quorums. Refusal is mandatory when safety or funding cannot be established. No discarded originals, refunds of failed allocations, relaxed quorum, enlarged cap or hidden workload reduction may fund a pass.

RSO3/RSO4 and stopped campaigns cannot be resumed or tuned. FEAT-001 is blocked pending a future owner decision about a genuinely different model review. Any authorized design requires independent review before implementation; any new 100/>64 campaign requires a complete preflighted reviewed path. Rollback restores a prior identified state without reversing acknowledged safety semantics or discarding conflicting evidence.

## Local development and verification

Documented ordinary commands include `npm ci`, `npm run build`, `npm test`, `npm run eval:quick`, and focused workspace tests; portable recovery noEmit/focused/composed commands are in `HANDOVER.md`. They are informational here, not executed or authorized next actions. Exact commands for new cases remain null until their feature freezes a procedure. Final qualification includes macOS ARM64 and Windows/Linux x64; installer execution and external CI require separate authorization.

Artifact-only validation in this session is limited to JSON parsing, schemas/references, IDs, timestamps, coverage, statuses and placeholder/outcome checks.

## Decisions and enforcement

DEC-001 is resolved **Keep suspension** at 2026-10-25T19:10:50Z. It blocks recovery design review and implementation but permits these artifacts. No ADR is created for an unselected recovery, confidential-computation or mixing design. Future choices must compare established methods, state assumptions and receive independent review. Implementation details may vary only within these invariants and unchanged acceptance limits.

## Assumptions and validation

- A1, repository: current architecture contains useful foundations but failed K5/K6 screens; high confidence; replacement and qualification remain open under EVL-009/011.
- A2, user inventory: desktop loopback controls and OS service effects are implemented but packaged behavior needs final qualification; high confidence; validate with EVL-017 rather than infer installer safety.
- A3, agent recommendation: explicit retention is an architecture invariant as well as a compliance control; high confidence; validate through ARCH-003/CMP-002 and EVL-018.

## Pending decisions

- Software architecture approval: software architecture owner and independent security/protocol reviewers; blocks implementation adoption of new designs and release.
- Future recovery-model review authorization: product owner; currently blocked by DEC-001 Keep suspension.

## Change history

- v1, 2026-10-25: initial release-wide architecture contract with seven invariants, current failure boundaries and unchanged limits; related DEC-001.
