---
contract_id: PRD-CONTRACT
title: Product contract
version: 1
status: active
updated_at: "2026-10-25T19:34:44Z"
owners:
  - role: product_owner
    name: unassigned
approvals:
  - decision_id: null
    status: approved
    scope: complete_v0.4_product_scope
    source: docs/developers/v0.4-acceptance-kpis.md
related_ids: [ARCH-CONTRACT, AI-CONTRACT, CMP-CONTRACT, EVAL-CONTRACT, DEC-001]
---

# Product contract

## Product intent and evidence

Planetary Resonance is a research prototype for decentralized, complementary need/offer matching. It is intended for people and communities that want useful discovery without giving a central operator a permanent record of their text, identity, relationships, or conversations. The current alternative is centrally mediated discovery or manual trusted-network coordination; comparative adoption baselines are unknown.

The complete v0.4 objective is owner-approved, not a reduced beta. It combines useful operations, sustainable recovery and authority lifecycle, fair anonymous admission, confidential matching, observer privacy, sustainable device cost, and independent volunteer operation. The repository implementation is evidence of current behavior, not acceptance: R1/R2 and K1–K8 remain open.

Sources: `README.md`; `HANDOVER.md`; `docs/developers/v0.4-acceptance-kpis.md`; `docs/developers/v0.4-execution-roadmap.md`; `docs/developers/v0.4-completion-plan.md`.

## Users and contexts

- Personal-node users publish needs/offers, search, consent to pairwise relationships, exchange end-to-end encrypted disclosures, withdraw publications, and retain local control of originals and keys.
- Volunteer relay operators provide matching, encrypted asynchronous delivery, replication, and recovery using independently operated devices and networks.
- Community issuers and policy/witness roles administer eligibility and authority without becoming permanently connected services or gaining personal-node secrets.
- Desktop users run macOS ARM64 and Windows/Linux x64 release candidates; final support must be qualified separately on each family. Accessibility review covers keyboard operation, focus, readable status/error/notice text, and assistive-technology labels in the actual desktop interface.
- Sensitive or regulated deployments, minors, professional eligibility decisions, and production use are not approved by this contract. Jurisdictions and operator roles require human review.

The reference load retains 10,000 active publications, uses two simultaneous operations per coordinator, and treats eight-request bursts as a separate overload/fairness screen. Local and impaired-network profiles are qualified separately.

## Release objective and metrics

Release only one frozen integrated candidate that satisfies every K1–K8 target below on the required evidence. Current baseline is **open/unqualified for every gate**. Existing 13 focused/46 composed/noEmit evidence accepts only a finite experimental recovery slice; it is not gate closure. The inherited K5 real-text screen fails reconstruction at 86–97% and known-text identification at 100%; the K6 cooperating-hop screen links 32/32 requests.

| Gate | Binding measurable outcome |
|---|---|
| K1 | >=99.5% successful nominal operations with required quorums; local warm p95 <=6 s; impaired p95 <=8 s and p99 <=10 s; preserve 3 s protected decision and 10 s private-operation budgets; zero duplicate user notifications across retries/restarts. |
| K2 | Zero lost acknowledged operations, conflicting accepted spends, or resurrected withdrawals in >=1,000 fault scenarios; recovery p95 <=5 min after authenticated usable quorum restoration; complete 100 rotation/recovery/compaction cycles, cross the 64-configuration archive boundary, stay within funded storage, and retain every required proof. |
| K3 | 100 correct transitions including same-key witness replacement; connected emergency-update availability p95 <=60 s; no new authorization under revoked policy after cutoff; reconnecting nodes authenticate current policy first; retained rights and conflicting-policy evidence survive. |
| K4 | >=95% eligible requests automatically resolved; false exclusion <=2%; false inclusion <=1% on independently labeled adversarial corpus; one eligibility claim gains no extra quota through 100 identities; equal-rights entitlement-normalized grants differ <=10%; issuance survives issuer loss without a permanently connected issuer. |
| K5 | Recall@5 >=90%, notified-match precision >=80%, false-positive rate <=5% on independent Spanish/English corpus with >=1,000 queries and >=10,000 publications; epoch rotation loses <=5 percentage points; cross-scope reconstruction and known-text attacks each identify <=5% of targets among 100 candidates; no epoch gaps or doubled notices. |
| K6 | No direct operation plaintext at entry and no original source address at destination; each declared correlation attack has AUC <=0.55 separately for busy, sparse, and colluding-relay scenarios, jointly with latency/resource budgets; activity detection and source-operation linking reported separately. |
| K7 | App RSS <=1.5 GiB sustained and <=2 GiB startup; model-free relay <=512 MiB at reference load; idle CPU <=1% of one core; incremental idle power <=1 W client and <=3 W relay; aggregate nominal traffic <=1 MiB per completed operation including failures; disk/network limits and accepted-obligation reserves enforced. |
| K8 | 14-day pilot with >=5 independent operators and >=3 networks; >=99% end-to-end wall-clock availability including missing quorums; each required quorum and conditional success separately reported; reconnection recovery p95 <=5 min; natural shutdowns, correlated outages, NAT, TLS renewal, and all supported OS families included. |

K1/K2/K3/K4/K5/K6/K7/K8 respectively realize PRD-001 through PRD-008. Threshold-straddling confidence intervals are inconclusive, not passes. Missing completion is infinite latency; zero completions makes bytes/completion infinite.

## User journeys

1. **Publish/search/match:** a user writes text locally; the device creates a scoped publication/query and the service returns useful complementary results without exposing raw text or true embeddings. Matches produce exactly one user-visible notice per logical event, including across retries, epochs, and restarts.
2. **Consent/disclose/close:** matched users explicitly consent to a fresh pairwise relationship, exchange signed sequenced end-to-end encrypted disclosures, and close the channel. Relays handle ciphertext and routing metadata only.
3. **Withdraw/retry/recover:** exact retries preserve the original operation identity and outcome. Permanent denials remain denied; uncertain outcomes remain distinguishable from success. Restart and quorum recovery never discard originals, duplicate notices, lose acknowledgements, conflict spends, or resurrect withdrawals.
4. **Authority/admission:** policy and witness transitions preserve rights and evidence; revoked policies cannot authorize after cutoff. Eligible users receive fair automated anonymous admission; issuer loss does not strand the community.
5. **Volunteer operation:** an operator configures bounded resources and a local relay role independently of the personal role. Desktop relay enable/disable has explicit OS service effects; installation and removal require release-package validation.

## Requirements

| ID | Requirement | User outcome | Priority | Acceptance summary | Source | Evaluations |
|---|---|---|---|---|---|---|
| PRD-001 | Useful private operations (K1) | Reliable timely publish/search/mailbox service | P0 | Full K1 thresholds and retry-notice invariant | acceptance KPIs | EVL-001, EVL-002, EVL-011 |
| PRD-002 | Durable bounded recovery (K2) | No acknowledged loss or unsafe recovery | P0 | Full K2 fault, RTO, 100-cycle, >64 and storage targets | acceptance KPIs | EVL-002, EVL-003, EVL-004, EVL-016 |
| PRD-003 | Authority and witness lifecycle (K3) | Current policy without losing valid rights | P0 | Full K3 transitions, freshness and revocation targets | acceptance KPIs | EVL-004, EVL-005, EVL-015 |
| PRD-004 | Fair automated anonymous admission (K4) | Eligible access without identity farming or unfair grants | P0 | Full K4 automation, error, Sybil, fairness and issuer-loss targets | acceptance KPIs | EVL-006, EVL-007 |
| PRD-005 | Confidential useful fingerprints and epochs (K5) | Bilingual matching without practical fingerprint linkage | P0 | Full K5 quality, attack and epoch targets; inherited failures block claims | acceptance KPIs; real-text screen | EVL-008, EVL-009, EVL-010, EVL-019 |
| PRD-006 | Observer privacy (K6) | Activity and source resist declared observers | P0 | Full K6 direct-observation and per-scenario AUC targets; inherited failure blocks claims | acceptance KPIs; private-adversaries screen | EVL-001, EVL-011, EVL-015 |
| PRD-007 | Sustainable device cost (K7) | Volunteer devices remain usable and bounded | P0 | Full K7 process-tree memory, CPU, power, all-edge traffic and reserve targets | acceptance KPIs | EVL-012, EVL-013, EVL-019 |
| PRD-008 | Independent volunteer operation (K8) | Communities can operate without a central fleet | P0 | Full 14-day independent pilot and availability targets | acceptance KPIs | EVL-014 |
| PRD-009 | Consent, E2E relationships, exact retries and notices | Users control disclosure and see one unambiguous outcome | P0 | Exact retry identity; zero duplicate notices; persistent denial/uncertainty; explicit consent; peer-only channel plaintext | README; acceptance KPIs | EVL-001, EVL-002, EVL-006, EVL-010, EVL-015, EVL-016 |
| PRD-010 | Local data ownership, scoped identities and explicit retention | Personal/role secrets stay local; operators know retention/deletion behavior | P0 | No raw text, true embeddings, root/role keys or channel plaintext at relays; no stable cross-activity identity; documented retention, deletion and incident handling approved for deployment | README; COMPLIANCE inventory | EVL-015, EVL-016, EVL-018, EVL-020 |
| PRD-011 | Integrated platform, supply-chain, compliance and release assurance | One auditable candidate with honest claims and deployable packages | P0 | Frozen identity; supported OS/accessibility/package/service checks; complete SBOM/notices; human legal/security/release approvals | roadmap; acceptance KPIs; user inventory | EVL-015, EVL-017, EVL-018, EVL-019, EVL-020 |

## Scope and non-goals

In scope: R1–R6; core/node/relay/app/eval packages; local embedding and deterministic matching; confidential publication and query replacement; observer-private transport; lifecycle, admission, desktop/service packaging, operational guidance, evidence, and independent release qualification.

Non-goals: declaring current K gates passed; tuning or rerunning rejected RSO3/RSO4 or stopped campaigns; changing trust/resource/KPI limits without owner approval; hosted LLM inference; autonomous or AI-based eligibility decisions; qualifying experimental two-hop HPKE by assumption; mobile clients (planned for v0.5); production deployment, installer execution, release approval, or inferred legal compliance.

## Release acceptance

FEAT-011 is the sole integrated release decision. It requires the same frozen source/data/model/configuration/dependency candidate to pass all K1–K8 evaluations with independent protocol/security review, required human legal/deployment/privacy/retention and supply-chain reviews, supported-platform evidence, and explicit product-owner production-release approval. No evidence result IDs exist at onboarding. Product-scope approval does not approve architecture, AI behavior, compliance, production, or any individual K gate.

## Assumptions and validation

- A1, repository: the complete v0.4 scope and R1–R6 order remain intended; high confidence; revalidate only through an owner-recorded scope decision. Current roadmap status labels are interpreted through `HANDOVER.md` and the active checkpoint.
- A2, repository: raw text/true embeddings/root and role keys/channel plaintext are personal/role private, while relays receive fingerprints, scoped IDs, metadata and ciphertext; high confidence; verify with negative production data-flow audit EVL-015.
- A3, user inventory: packaged LICENSE deletion and mixed dependency/model/native notices are unresolved release risks; high confidence as an inventory finding, not a legal conclusion; validate in EVL-017 and human review EVL-018.
- A4, agent recommendation: accessibility and supply-chain evidence belong in the integrated release rather than a helper-only milestone; validate through EVL-017 and FEAT-011.

## Pending decisions

- Architecture, AI architecture, compliance, and production-release approvals remain pending with their respective human owners; they block adoption/release, not this artifact-generation session.
- A future owner decision is required to authorize a genuinely different recovery-model design review or keep suspension. DEC-001 currently resolves to keep suspension; no new DEC is opened.

## Change history

- v1, 2026-10-25: initial complete owner-scope contract generated from repository evidence and the supplied direct inventory; related DEC-001. No thresholds or release status changed.
