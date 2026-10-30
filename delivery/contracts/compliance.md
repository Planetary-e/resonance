---
contract_id: CMP-CONTRACT
title: Compliance contract
version: 1
status: draft
updated_at: "2026-10-25T19:34:44Z"
owners:
  - role: compliance_owner
    name: unassigned
  - role: qualified_legal_reviewer
    name: unassigned
  - role: security_release_owner
    name: unassigned
approvals:
  - decision_id: null
    status: pending
    scope: compliance_and_deployment
  - decision_id: null
    status: pending
    scope: production_release
related_ids: [PRD-010, PRD-011, ARCH-003, ARCH-004, AI-001, CMP-001, CMP-002, CMP-003, CMP-004]
---

# Compliance contract

## Scope and verified context

This is a planning/evidence contract, not a legal opinion or declaration of compliance. Scope covers the research prototype, personal desktop/node, optional volunteer relay, community issuer/policy/witness roles, local model artifacts, packages and evaluation/deployment evidence. Entities, production service providers, target sectors, user ages and jurisdictions are not established. Lawful bases, retention obligations, controller/processor roles, vendor/subprocessor transfers and release approvals remain pending qualified human decisions.

Root source is MIT. The supplied direct inventory reports packaged LICENSE deletion and mixed dependency/model/native notices requiring SBOM and license review. `COMPLIANCE.md` contains stale or categorical legal/privacy statements—including broad open-source exclusions, persistent DID language, non-personal/non-invertible fingerprint claims and fixed retention claims—and must not be treated as verified current law or architecture. No legal compliance is inferred.

Sources: `LICENSE`; `README.md`; `COMPLIANCE.md`; `packages/core/src/model-file-cache.ts`; user-supplied direct inventory, 2026-10-25. No external legal research was performed.

## Data and processing inventory

| Data/processing | Purpose and source | Destination/visibility | Retention/deletion status | Human legal status |
|---|---|---|---|---|
| Raw need/offer/search text and true embeddings | Local matching input from user | Personal node only; never relay/model provider | User-owned; exact local/cache/backup deletion schedule pending | Lawful basis and user rights pending deployment review |
| Root, personal scoped and role-private keys | Sign/authenticate personal, issuer, wallet, policy and witness actions | Authorized personal/role store only | Lifecycle/rotation/revocation/destruction procedure pending | Security and role review pending |
| Channel plaintext and chosen disclosures | Consensual pairwise communication | Consenting peers only; relays carry ciphertext | Peer/channel/backup retention pending | Notice, consent and rights review pending |
| Fingerprints, scoped IDs, match/routing records and ciphertext | Decentralized matching/delivery | Relays and matched protocol roles as declared | Per-record expiry/tombstone/compaction/physical deletion register pending | Personal-data classification and basis pending; do not call non-personal or non-invertible |
| IP/source addresses, timing, size, direction, endpoints and network metadata | Transport, security, relay operation | Entry/destination/observers according to declared flow | Exact memory/log/metric retention pending | Controller/processor roles, basis, notices, transfers pending |
| Eligibility claims, blind credentials, grant/fairness evidence | Automated anonymous admission and audit | Admission roles; linkage minimized | Claim/credential/audit retention pending | Eligibility governance and legal review pending; no AI eligibility decisions |
| Model/tokenizer/ONNX/runtime artifacts | Local embedding | First download from approved artifact source to local cache; no raw-text upload | Bounded atomic cache and upgrade/deletion procedure pending | License, notices, vendor terms/transfers pending |
| Evaluation and operational evidence | Qualification, security, incident and release audit | Authorized reviewers; sanitized `delivery/results` metadata only | Evidence retention and correction/deletion linkage pending | Review and approval pending |

International transfers, subprocessors and vendor data-use terms are unknown, not absent. Actual deployments require a per-operator inventory identifying destinations and jurisdictions.

## Obligation and control register

| ID | Obligation/open question | Source/applicability | Control | Implementation owner | Evidence | Approver/status |
|---|---|---|---|---|---|---|
| CMP-001 | Reviewed deployment guidance must replace reliance on stale/categorical legal and privacy statements | `COMPLIANCE.md`; applicability unresolved by jurisdiction/role | Redline/guide reviewed against actual data flows, K5/K6 failures, consent/notice and non-goals | Compliance owner + documentation owner | EVL-018, EVL-020 | Qualified legal/privacy reviewer; pending |
| CMP-002 | Operator data, retention, incident and vendor registers require actual roles, purposes, locations, transfers, deletion and response procedures | Data inventory; deployment-specific applicability | Versioned register and operator runbook covering requests, incidents, vendors and evidence exceptions | Each operator + privacy/security owner | EVL-014, EVL-018 | Operator/legal/privacy/security owners; pending |
| CMP-003 | Complete SBOM, root/package licenses and dependency/model/native notices must be present and reviewed | Root MIT; packaged LICENSE deletion and mixed notices inventory | Frozen SBOM, license/notice manifest, package-content negative check and model BOM | Release engineering + AI/runtime owners | EVL-017, EVL-019 | Supply-chain/legal reviewers; pending |
| CMP-004 | Vendor, security and production-release baseline requires mapped interface/key controls, independent review and explicit approvals | Acceptance KPIs; architecture threat model | Security/vendor review, negative audit, frozen candidate, release checklist and named sign-offs | Security/release owners | EVL-015, EVL-017, EVL-018 | Security owner + product owner + required specialists; pending |

No CMP item is marked satisfied. Their status is a control-planning status, not a legal applicability conclusion.

## Vendors, intellectual property, and licenses

Root MIT licensing does not establish packaged-license completeness. Review all JavaScript/TypeScript, Rust/Tauri, native ONNX/backend, platform/WebView and redistributed artifacts; produce an SBOM with versions, hashes, licenses, notices and package inclusion. Verify the packaged root LICENSE cannot be dropped and required third-party/model notices ship in every package.

Model source/vendor terms, artifact revisions, cache/download behavior and any transfer/telemetry terms need review. No hosted LLM is in scope and no inference text is sent to a model provider. New vendors/providers/subprocessors require data-flow, terms, transfer and security review before use. Generated-output ownership is not currently material because there is no generative AI; revisit if scope changes.

## Privacy, security, and AI controls

Local-first storage and scoped identities are risk-reduction design choices, not proof of anonymity or legal compliance. Raw text, true embeddings, root/role keys and channel plaintext remain personal/role private; relays see declared derived data and metadata. K5 reconstruction/known-text and K6 linkage failures must appear in user/operator claims until replaced and requalified.

Consent is explicit for pairwise relationships and disclosures. Deployment consent/notice, eligibility communication, withdrawal/erasure semantics, retention, incident handling, age/sector restrictions and human oversight require qualified review. Matching does not make automated eligibility or professional decisions. Security controls include canonical authentication, bounded interfaces, private key storage, local Host/Origin/Bearer controls, independent privacy/security review and frozen model/dependency provenance.

## Evidence and audit trail

Current evidence is repository documentation and historical evaluation reports; onboarding creates definitions only and no RUN records. Future evidence lives in `delivery/results/RUN-*.json` with sanitized aggregates and protected references, plus reviewed operator registers, SBOM/notices, approvals and release manifests outside public artifacts when sensitivity requires it.

Record reviewer, date, scope, candidate identity, decision and expiry/review trigger. Review on deployment/jurisdiction/data-flow/model/vendor/package/security changes and at a cadence set by the compliance owner. Correction/deletion/request handling must link operational records and evidence without pretending immutable safety evidence can silently disappear; qualified humans decide exceptions and retention.

## Human review and release gates

- Qualified legal/privacy reviewers decide jurisdiction-specific obligations, lawful basis, roles, notices/consent, retention/rights and vendor transfers (CMP-001/CMP-002).
- Supply-chain/legal reviewers approve SBOM, package LICENSE and dependency/model/native notice completeness (CMP-003).
- Security/privacy owners approve production data flows, interface/key controls, threat model, incidents and vendor baseline (CMP-004).
- Product owner alone approves production release and any KPI/trust/resource/scope change. Architecture and AI approvals remain separately pending.

Session-local artifact generation is allowed. Recovery design/implementation remains suspended under DEC-001. No production deployment, sensitive-data pilot, installer, external system, or release is authorized. All CMP gates and K1–K8 block production release.

## Assumptions and validation

- A1, user inventory: `COMPLIANCE.md` is not a reliable statement of current obligations or privacy properties; high confidence because it conflicts with current scoped identities and failed privacy screens; EVL-020 checks documentation consistency and EVL-018 obtains human review.
- A2, repository/user inventory: local-only processing reduces some transfers but does not eliminate relay/network/vendor processing; high confidence; deployment-specific EVL-018 validates actual obligations.
- A3, agent recommendation: each independent operator needs its own register and approvals rather than one global project legal conclusion; high confidence as a control design, not legal advice; validate with qualified reviewers.

## Pending decisions

- CMP-001/CMP-002 legal, privacy, deployment, retention, controller/processor, jurisdiction, lawful-basis and vendor-transfer decisions: qualified human owners; block production guidance/deployment/release.
- CMP-003 SBOM/license/notice acceptance: supply-chain and legal owners; blocks packaged release.
- CMP-004 security/vendor/release baseline and production-release approval: security and product owners; blocks release.

## Change history

- v1, 2026-10-25: initial four-control compliance planning register; explicitly rejects inferred legal compliance and records stale guidance/package-notice risks. No external legal research or approval claimed.
