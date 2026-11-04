---
contract_id: AI-CONTRACT
title: AI architecture contract
version: 1
status: draft
updated_at: "2026-10-25T19:34:44Z"
owners:
  - role: ai_architecture_owner
    name: unassigned
  - role: privacy_reviewer
    name: unassigned
approvals:
  - decision_id: null
    status: pending
    scope: ai_architecture_and_privacy_behavior
related_ids: [PRD-005, PRD-006, PRD-007, ARCH-001, CMP-003, CMP-004]
---

# AI architecture contract

## AI use cases and non-use cases

AI is limited to local natural-language embedding for complementary need/offer matching. The current implementation uses `nomic-ai/nomic-embed-text-v1`, producing normalized 768-dimensional vectors through Transformers.js/ONNX on the user's device. Deterministic text preparation/rewrite behavior, 512-bit LSH and Hamming comparison are separate from model inference and must remain identifiable in evaluation.

Non-use cases: no hosted LLM, generative assistant, autonomous agent, remote inference, or AI eligibility/admission decision is in approved scope. Deterministic protocol rules and humans make authorization, consent, denial, recovery, compliance and release decisions. The model does not establish truth, legal status, user identity, entitlement, or consent. Failed K5/K6 screens prohibit representing current embeddings/fingerprints or experimental transport as confidential/observer-private.

Sources: `README.md`; `packages/core/src/types.ts`; `packages/core/src/embedding.ts`; `packages/core/src/lsh.ts`; `packages/core/src/model-file-cache.ts`; `docs/developers/v0.4-acceptance-kpis.md`; `HANDOVER.md`.

## Models, providers, and routing

The model bill of materials must identify model/revision, config, tokenizer and tokenizer config, ONNX weights and external data, Transformers.js/ONNX runtime and native backends, license/notices, expected dimensions and file hashes. The model downloads on first use into a bounded local cache and is reused thereafter; cold download/initialization is measured separately and included in lifecycle resource reporting. Cache redirects, unrelated hosts, path traversal, partial files and over-capacity content must fail safely.

No provider substitution, hosted fallback, silent revision update, telemetry route or raw-text upload is permitted. A model/runtime/cache change creates a new frozen candidate, repeats quality/privacy/resource checks and requires AI architecture and supply-chain review. Rollback uses a previously identified complete local artifact set rather than mixing revisions.

## Context and knowledge

Only user-initiated local need/offer/search text is supplied to local embedding. There is no retrieval-augmented generation, external knowledge base, prompt context or model-generated factual citation. Raw text and true embeddings remain personal-node private; relays receive only protocol-approved derived artifacts, currently fingerprints with scoped IDs and metadata.

Evaluation corpora have provenance, independent relevance labels and development/holdout separation. Real personal content is excluded unless explicit consent and reviewed handling exist. Evaluation records retain hashes, aggregate metrics and sanitized examples only; they never become a secondary corpus of private user content.

## Tools and permissions

The embedding runtime has no product tools and no authority to write protocol state, access relays autonomously, install software, choose providers or make network requests beyond the explicitly approved first-model artifact download. It receives bounded text and returns a fixed-dimension finite vector. Invalid dimensions, NaN/Infinity, unsupported model/config, unsafe URL/cache path and resource-limit violations fail before publication.

AI controls:

| ID | Control | Enforcement | Evaluations |
|---|---|---|---|
| AI-001 | Complete model BOM and cache provenance pin every model/tokenizer/ONNX/runtime artifact, license/notice, hash and cold/warm cache transition | Reviewed manifest; bounded same-host cache; fail partial/unsafe/unrelated downloads; no silent latest revision | EVL-017, EVL-019 |
| AI-002 | AI is local embedding only; deterministic logic handles protocol/admission; no unreviewed model, provider, hosted route or autonomous decision | Static/data-flow review and provider/cache negatives; explicit human approval for changes | EVL-006, EVL-008, EVL-015, EVL-019 |
| AI-003 | Failed K5/K6 privacy screens block confidential/observer-private claims; both K5 attacks and each K6 scenario must pass independently | Release-claim linter/review plus frozen adversarial games; no averaging or fixture extrapolation | EVL-009, EVL-010, EVL-011, EVL-020 |
| AI-004 | Inference has bounded input, concurrency, memory, startup/idle CPU/power, initialization and network lifecycle; cold costs are visible | Process-tree measurements, cache/timeout/cancellation negatives and K7 joint qualification | EVL-008, EVL-012, EVL-013, EVL-019 |

## State and memory

Persistent AI state is the local model/cache and user-owned original text/embeddings where the personal store retains them. The relay does not receive true embeddings. Cache lifecycle includes bounded capacity, atomic completion, deletion and upgrade behavior; retention is explicit under ARCH-003/CMP-002. Sessions do not personalize a hosted profile because no hosted provider exists.

Logs identify model/revision/config and aggregate initialization/runtime metrics without raw text, true embeddings or sensitive query content. Reconstructability means reproducing the exact model artifact set and deterministic pipeline from the frozen manifest, not retaining private prompts.

## Prompts and structured outputs

There are no LLM prompts or generated structured decisions. Any deterministic rewrite/preprocessing rules are versioned source/configuration, included in candidate identity and evaluated for bilingual quality and privacy. Model output is a 768-element finite numeric vector; downstream deterministic transformations validate shape and numerical bounds. No autonomous repair may alter user text semantics or protocol records without explicit reviewed behavior.

## Autonomy, limits, and escalation

Inference runs only for an explicit local publication/search/preparation operation. It cannot loop, invoke tools, purchase, deploy, admit users, accept matches or consent. Input length, worker count, queueing, concurrency, cancellation, memory and deadlines are bounded by the candidate configuration. Cold download requires the approved model source and cache policy; failure produces an honest local error/retry state rather than hosted fallback.

Resource limits and K1/K7 joint targets are release-blocking. Stop on unexpected provider/network access, model identity drift, non-finite output, unbounded growth or resource-limit breach. Human approval is required for any new provider, model class, AI use case or eligibility automation based on inferred semantics.

## Evaluation and observability

EVL-008 measures independent bilingual Recall@5, notified precision and false positives; EVL-009 separately measures cross-scope reconstruction and known-text attacks among 100 candidates; EVL-010 measures epoch quality loss, gaps and duplicate notices; EVL-019 verifies provenance/cache/inference bounds. EVL-011 independently evaluates observer behavior and cannot be averaged with K5.

Record exact model/data/config/runtime identities, per-language counts/denominators, variance, cold/warm initialization and resource costs. Existing 86–97% reconstruction and 100% known-text identification are failures, not quality scores. No LLM judge or model self-assessment is used.

## Threat model and abuse controls

Threats include model/cache supply-chain replacement, malicious URL/redirect/path content, partial/corrupt artifacts, sensitive text exfiltration, fingerprint inversion/linkage, malicious input resource exhaustion, unauthorized provider fallback and misleading documentation. Prompt injection and tool exfiltration are not applicable to the current non-generative no-tool model; adding an LLM or tools triggers a new architecture and threat review.

Controls are local-only inference, fixed artifact manifests, bounded atomic cache, schema/numeric validation, explicit network expectations, role/data-flow negatives, independent adversarial privacy evaluation, and claim consistency review. K5/K6 acceptance is limited to declared tested observers and never a universal anonymity proof.

## Assumptions and validation

- A1, repository: local embedding is the only product AI use; high confidence; EVL-015/019 verify no hidden hosted or eligibility path before release.
- A2, user inventory: first-download cache and local Transformers.js/ONNX runtime are intended behavior; high confidence; EVL-019 validates provenance, bounds and lifecycle on the frozen candidate.
- A3, agent recommendation: deterministic rewrite/preprocessing belongs in model candidate identity even though it is not AI; high confidence; validate via EVL-008/019 to prevent unexplained quality drift.

## Pending decisions

- AI architecture/privacy approval remains pending the AI architecture owner and independent privacy reviewer; blocks confidential/observer-private claims and release.
- Any new model, hosted provider, AI eligibility use, generative capability or tool permission requires explicit owner and specialist review and is outside current scope.

## Change history

- v1, 2026-10-25: initial local-only AI contract with four controls, current K5/K6 failures and no hosted/eligibility AI claims.
