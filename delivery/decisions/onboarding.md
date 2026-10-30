# Onboarding record

## Repository and external evidence

- **Current checkout:** the user selected `/Users/marcos/Documents/Codex/2026-09-15/i-x20/resonance-v04`, branch `feature/v0.4-private-transport`, HEAD `c81d2ac55f083c62127d9ea663a3f2d30b078ffb`. The worktree has substantial existing modified and untracked work; all of it must be preserved. Sources: direct `git status` and `git worktree list`, 2026-10-25.
- **Project stage:** existing research prototype, not a production network and not a greenfield application. Source: `README.md` and `HANDOVER.md`.
- **Binding current status:** R1/R2 and K1–K8 are open. RSO3 and RSO4 are rejected and recovery implementation is suspended. Any further attempt requires a genuinely different, owner-authorized, independently reviewed model. Sources: `AGENTS.md`, `HANDOVER.md`, and `docs/developers/v0.4-completion-plan.md`.
- **Accepted product scope:** the owner approved the complete v0.4 acceptance scope and rejected a reduced beta. K1–K8 thresholds and stop rules remain binding. Source: `docs/developers/v0.4-acceptance-kpis.md`.
- **Current execution order:** R1–R6 remains the authorized replacement roadmap, but its older status labels are not current. R3/K5 and R4/K6 remain future work; R5 integrates one candidate; R6 requires independent qualification. Source: `docs/developers/v0.4-execution-roadmap.md`, interpreted through the current checkpoint.
- **Documentation discrepancy:** roadmap lines still say R1 is ACTIVE and R2 independent review is pending, while the current handover/checkpoint records finite-slice review acceptance followed by RSO3/RSO4 rejection and suspension. Preserve the discrepancy; do not silently rewrite project intent.
- **Limited positive evidence:** 13/13 focused and 46/46 composed tests, portable actual-source noEmit, and independent acceptance of a finite experimental slice. These do not close R1/R2 or any K1–K8 gate. Source: `HANDOVER.md` and the active checkpoint.
- **Known privacy failures:** the inherited fingerprint and transport paths fail the documented K5/K6 screens. Do not present existing code as confidential matching or qualified observer protection. Sources: `README.md` and `HANDOVER.md`.
- **Runtime/tooling:** Node >=24, npm workspaces, TypeScript, Vitest, and existing build/test/evaluation commands are documented in `package.json` and `HANDOVER.md`.
- **Running work check:** no Resonance test/build process was identified. One unrelated Node process belonged to `/Users/marcos/Development/imitationoflife/defender`; no process was stopped or changed. Source: read-only process/cwd inspection, 2026-10-25.
- **Product architecture and compliance inventory:** complete. The product is a research prototype for decentralized complementary need/offer matching across core/node/relay/app/eval. Local `nomic-ai/nomic-embed-text-v1` produces 768-dimensional embeddings through Transformers.js/ONNX with a first-download cache; deterministic rewrite/512-bit LSH/Hamming follows. There is no hosted LLM or AI eligibility decision. Experimental two-hop HPKE is not qualified. Sources: `README.md`, `packages/core/src/types.ts`, `packages/core/src/embedding.ts`, `packages/core/src/lsh.ts`, `packages/core/src/model-file-cache.ts`, and the owner-supplied inventory.
- **Privacy/data boundaries:** raw text, true embeddings, root and role-private keys and channel plaintext stay personal/role private. Relays see fingerprints, scoped IDs, network metadata and ciphertext. Desktop local APIs use loopback Host/Origin/Bearer controls; optional relay mode has OS service/installer effects. Sources: `README.md`, `packages/app/src/server/local-http-boundary.ts`, `packages/app/src/server/api.ts`, and the owner-supplied inventory.
- **Supply chain and compliance:** root source is MIT, but packaged LICENSE deletion and mixed dependency/model/native notices require SBOM/review. `COMPLIANCE.md` contains stale/categorical legal/privacy statements. Jurisdictions, lawful bases, retention, controller/processor roles, vendor transfers and release approvals remain pending; no legal compliance is inferred. Sources: `LICENSE`, `COMPLIANCE.md`, and the owner-supplied inventory.
- Confidence is high for the direct repository facts above. No external factual or legal research has been performed.

## User answers and delegations

- **2026-10-25:** the user requested execution for Planetary Resonance in this same Kimi session and selected `resonance-v04` after the available worktrees were enumerated. This authorizes session-local onboarding artifacts in that worktree, not global instruction changes, production actions, or a stopped campaign.
- **2026-10-25:** the user confirmed this is a worktree; the original checkout is `/Users/marcos/Development/Planetary/resonance`. Use only the selected worktree for generated artifacts.
- No delegation has been given to alter acceptance thresholds, trust/resource assumptions, protocol design, legal/release gates, or existing project instructions.

## Agent recommendations and assumptions

- Treat `HANDOVER.md` plus `docs/developers/v0.4-completion-plan.md` as the current operational status authority, with `docs/developers/v0.4-acceptance-kpis.md` as the approved acceptance contract. This follows the root `AGENTS.md`; it does not erase older roadmap text.
- Scope onboarding to the complete owner-approved v0.4 scope rather than inventing a new reduced release. Rationale: documented owner decision and current R1–R6 roadmap.
- Keep implementation paused at the existing recovery gate unless the owner explicitly authorizes a genuinely different model review. Local contract/evaluation generation is allowed; no stopped campaign, threshold change, or production adoption is allowed.

## Owner decisions

- **2026-10-25T19:10:50Z — DEC-001 resolved:** the owner selected **Keep suspension**. Onboarding and evaluation/contract generation may finish, but no genuinely different design review, recovery implementation, stopped campaign, threshold change, or production action is authorized.
- **2026-10-25T19:45:30Z — onboarding complete:** generated and structurally checked the complete artifact set, selected FEAT-001 as `blocked` by explicit owner override, and finished `paused`. Exact next action: awaiting a new owner decision whether to authorize a genuinely different recovery-model design review or keep suspension.

## Pending questions

- None for the initial contract-generation pass. Architecture, AI/privacy, compliance, and release approval fields remain pending where the repository does not document an applicable approval; this is not a request to infer them.
