# Working on Resonance

## Portable resume entry — October 24, 2026

Read [HANDOVER](HANDOVER.md), then the [single active checkpoint](docs/developers/v0.4-completion-plan.md).
The corrected finite recovery slice passed independent follow-up review, but the
subsequent aggregate work candidate, `RSO2`, commitment-preflight, and binary-signed
v2 are STOPPED. A diagnostic-only run measured 15,054,300 bytes for preparation plus
bootstrap (3.190× cap) and confirmed representation churn dominates. Implementation
remains SUSPENDED. The immutable-binary bootstrap passed, but reserveInstall later
reached 6,234,194 bytes (32.1% over cap), so the lifecycle candidate is REJECTED.
Do not run a stopped campaign, infer a new threshold, or tune replay further. A new
attempt needs an owner decision and a targeted reserveInstall structural review or
continued suspension. On October 25 that review returned REVISE, followed by a
bounded GO for fresh-arena RSO3 per-proof DEKs and recipient HPKE capsules. The
implementation passed 14 focused tests and actual-source noEmit, but the original-cap
lifecycle stopped during bootstrap at 4,718,545 / 4,718,592 bytes with mandatory
writes outstanding. The owner-approved single-pass validated-pair correction also
passed focused gates but failed bootstrap at 4,718,166 bytes with writes outstanding.
Both RSO3 candidates are REJECTED before reserveInstall; the reviewer explicitly
closes another optimization round. A later exact-replay correction passed focused
gates, but diagnostic bootstrap reached 9,959,445 bytes and first reserveInstall
9,335,006; returning preparation then failed physical C at 270,204 > 262,144 before
the second installation. Independent gate reassessment recommends a fundamentally
different recovery-storage architecture, NOT revised thresholds from this incomplete
envelope. Requirements are compact scope/key-version delegation rather than proofs×
recipients×transitions, shared immutable proof ciphertext, reference/availability
transfer for retained proofs, predecessor-independent role-private recovery and full
physical closure. The subsequent RSO4 design-only review is also REJECTED: its
crash-correct complete physical model requires 299,703 B against C=262,144, and
removing all deltas and signed ranges still requires 268,471 B. Pending generations,
manifests and delegation cannot be removed without breaking four-copy availability
or authentication. See `docs/developers/v0.4-rso4-recovery-architecture.md`.
Do not tune RSO3/RSO4 or infer a new threshold. Implementation remains SUSPENDED;
another attempt needs a genuinely different model and owner-authorized independent
review. Preserve technical invariants, acceptance and stop rules below. No R1/R2/K1–K8
closure is claimed.

Model/vendor routing below records prior operating preferences. A destination
system may use equivalent competent roles and tools; no Codex/Astra dependency
is required for review or continuation. Default to one executor, with an independent
reviewer for protocol-critical acceptance. Preserve all dirty/untracked work.

## Binding project priority — October 23, 2026

The owner explicitly prioritized three outcomes: (1) sustainable recovery and
authority lifecycle within the accepted limits (K2/K3); (2) viable publication,
query and observer privacy (K5/K6); (3) one exact integrated candidate qualified
against K1–K8. Everything else is auxiliary and may proceed only when it removes
a named necessary blocker on that path. A helper pass is not product completion.

Do not continue serial replay/cache/copy optimizations or fingerprint parameter
tuning on a stopped design without a reviewed protocol/viability decision.
Compare established methods before adding custom machinery. Keep historical
counterexamples, cumulative effort and stop conditions; a reassessment does not
reset them. Preserve the full scope and existing trust/resource thresholds unless
the owner explicitly approves a concrete change. Consult the current assessment
in `docs/developers/v0.4-architecture-reassessment-2026-10-23.md` and the binding
execution priorities in `docs/developers/v0.4-acceptance-kpis.md`.

The owner subsequently authorized execution of the derived replacement roadmap:
`docs/developers/v0.4-execution-roadmap.md`. Use its R1–R6 order and one active
checkpoint. R1's executable recovery decision is the first deliverable; the old
reassessment-only restriction is superseded for that bounded work. Stopped legacy
campaigns, trust/resource limits and cumulative histories remain unchanged.

## Resume with bounded context

Confirm the checkout, branch, dirty files and any running commands first. Read the
active execution checkpoint in `docs/developers/v0.4-completion-plan.md` and the
relevant acceptance/stop rule in `docs/developers/v0.4-acceptance-kpis.md`. Read
historical reports only to answer a specific unresolved question. Preserve
unrelated work and never infer that a local test qualifies the full product.

## One active deliverable

Keep one implementation deliverable in progress by default. Before changing code,
record its parent blocker/KPI, concrete observable result, relevant invariant,
acceptance evidence, exclusions and resource checkpoint in the existing experiment
record. Choose the smallest coherent change that removes a necessary blocker.
Do not repeatedly finish helper components without checking the remaining path to
the complete KPI. A component pass is not a KPI pass.

Classify discovered work before expanding the deliverable:

- A reachable safety/correctness problem receives the minimum distinguishing
  reproduction and the existing stop-policy assessment.
- A necessary prerequisite is recorded against the same blocker and budget.
- Optional polish or an unrelated improvement stays outside the active block.

Separate implementation with known acceptance, qualification of an implemented
candidate, and unresolved protocol/feasibility decisions. Do not build more
wrappers to avoid a missing protocol decision. Freeze experiments before running
them; do not broaden samples or relax targets after observing failure.

## Prior model preferences and delegation

The owner approved Sol-led daily execution on October 20. GPT-6.1 Sol at medium
owns the complete ordinary deliverable: diagnosis, bounded planning, implementation,
tests, documentation, integration and CI. Do not retain those routine activities in
an Astra coordinator or divide them into tiny implementation-only delegations.
Use GPT-6 Astra for bounded architecture decisions and independent reviews of
protocol-critical safety, concurrency and recovery changes. Its technical review
role does not require continuous Astra orchestration. GPT-6 Luna may perform
bounded mechanical work when substantial enough to justify delegation.

Default to one executing agent. A deterministic command or short file lookup does
not justify an agent. Delegate a complete coherent task with an observable result;
avoid duplicating the diagnosis before delegation and reconstructing it afterward.
Use concurrent implementers only for genuinely independent changes with fixed
contracts and nonoverlapping files.

Delegate using a compact brief with file ownership, contract, acceptance and
exclusions. Start a fresh scoped context for a new deliverable instead of carrying
the entire project conversation; reuse an agent within that deliverable. Ask for
changed files, test evidence and actionable findings, not a narrated history.
Avoid reviewer chains and duplicated exploration. Review integrated results before
acceptance; another review needs a material change or unresolved concern.

### Prior model and effort selection

Use these initial routing defaults, subject to evidence from accepted work:

| Work | Model | Effort |
| --- | --- | --- |
| Daily diagnosis, planning, implementation, tests, documentation and CI | GPT-6.1 Sol | medium |
| Bounded architecture decision | GPT-6 Astra | medium |
| Protocol-critical review and unresolved safety reasoning | GPT-6 Astra | high |
| Concurrency, crash recovery and state migrations | GPT-6.1 Sol | high |
| Mechanical edits, inventories and literal evidence extraction | GPT-6 Luna | low |
| Bounded classification requiring some interpretation | GPT-6 Luna | medium |

Prefer a direct command to an agent for deterministic checks. Luna extraction
must include the exact supporting evidence; it cannot alone approve a protocol
invariant or establish a subtle CI failure cause. Route by task risk rather than
running every task through every model.

Reserve extra-high for a bounded difficult question with a stated unresolved
issue and checkable outcome. Do not default to max/ultra. Escalate against a
specific failure or uncertainty, preserving the existing stopping conditions.
More effort is not a substitute for missing evidence or an undecided contract.

Set model and effort explicitly for new delegated contexts. A fresh bounded
brief avoids inheriting the full parent history and settings. These instructions
do not change the active parent chat's runtime model or effort; distinguish
recommended settings from settings actually applied.

For the next three coherent deliverables, record actual model/effort, first-pass
acceptance, material review findings, rework rounds and available usage with the
existing block receipt. Evaluate total cost through acceptance, including review
and corrections. This is an initial operational check, not proof of equivalent
quality or a precise savings percentage; do not duplicate implementation solely
to benchmark models or weaken the existing acceptance tests.

## Evidence without repeated work

Select tests from the changed invariants and dependency paths. Run focused tests
during implementation, then one affected-path composed regression after review
fixes. Rerun only for a relevant code/configuration/fixture change, failure or new
concern. Record the exact candidate (including dirty-tree identity when relevant),
command, environment and result; a HEAD SHA alone cannot identify uncommitted code.
Keep safety, process-death and cross-platform checks required by the acceptance
contract. Run performance/energy qualification without concurrent host workloads.

Return compact tool output; inspect complete logs only around a failure. Prefer
status notifications or a bounded completion check over repeated CI polling.
Commit coherent reviewed changes and push a stable candidate once, allowing its
CI to finish. Do not trigger installers or merge without existing authorization.
Routine CI and installer builds use macOS only. Windows/Linux compatibility is
reserved for the final explicit `all_platforms` manual run; do not re-enable
three-platform development matrices without the owner requesting it.

## Cost and stopping

Record the available account quota at block entry and exit, and before materially
expanding delegated work. The account counter is shared and may be coarse; report
its observed delta, not invented per-agent costs or guaranteed savings. Count
active delegated effort toward the existing blocker limit; exclude idle time.
Keep earlier alternatives and unknown historical effort visible. A new agent,
document or subtask never resets a budget. Do not introduce a new spending
authorization or replace the agreed KPI/stop rules with process metrics.

If quota increases without new implementation evidence or resolved uncertainty,
stop opening more work and reassess the current block. Use existing trusted tools
to verify a reported quota restriction; do not infer ordinary usage availability
from the optional credit balance. Report complete KPIs and actual stop conditions
clearly; do not end autonomous development merely on a component milestone.
