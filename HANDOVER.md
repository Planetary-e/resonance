# Resonance handover — October 24, 2026

Start here when transferring this repository to another engineering system. This
is a research prototype. v0.4 is incomplete: **R1/R2 and every K1–K8 gate remain
OPEN**. Local passing tests do not establish independent acceptance or a release.

## Current state and first action

The experimental sustainable-recovery path is opt-in. It is not selected by the
CLI, configured production verifier or live service. The corrected finite slice
has now completed independent critical review. The reviewer initially rejected
three reachable schedules; minimal same-design corrections and distinguishing
regressions were added, and the follow-up review returned **ACCEPT finite
experimental slice** for all five original correction areas. This does not accept
R1/R2 or any K1–K8 gate.

**Active status: RSO3 and RSO4 rejected; recovery implementation suspended.**
RSO3 diagnostic bootstrap used 9,959,445 bytes and first reserveInstall 9,335,006;
returning preparation refused physical C at 270,204 > 262,144. The owner-requested
RSO4 architecture then underwent two design revisions and independent reviews. Its
final crash-correct model requires C=299,703 B against 262,144, 37,559 B over.
Even removing all deltas and signed ranges leaves 268,471 B, 6,327 B over. Pending
generations are required to preserve four-copy availability during compaction;
manifests/ranges/delegation cannot simply be discarded. Independent review confirms
**REJECTION** in [the RSO4 specification](docs/developers/v0.4-rso4-recovery-architecture.md).
No production implementation or threshold change followed. Do not tune these designs
or run a stopped campaign. R1/R2 and K1–K8 remain open; no acceptance or release
follows. The accepted finite correction slice remains identified by
[review-followup-candidate-hashes.json](docs/handover/2026-10-24/review-followup-candidate-hashes.json).
The [implementation receipt](docs/evals/v04-sustainable-recovery-implementation-2026-10-23.md)
records that prior acceptance separately from the failed work candidate, all three
measurements, instrumentation limitations and the required owner decision.

## What is demonstrated, and what is still missing

| Evidence | Scope and limit |
| --- | --- |
| 13/13 focused tests PASS, 70.87 s total | Exact accepted follow-up candidate; local. |
| 46/46 composed tests PASS, 80.68 s total | Post-review affected composition: 13 focused + 33 existing funding tests, one worker. |
| Portable actual-source core/relay/node noEmit PASS | Follow-up source, 671 selected inputs, exit 0. |
| Independent follow-up review | All three new findings and all five original correction areas accepted for the finite experimental schedules only. |
| Real signed/durable two-transfer path | Cut → disjoint successor → returning owners, current-policy service, original retry/conflict/split uncertainty/late original certificate/denial; physical runtime reopen at authority availableBytes=0. Not all five members exercised a return. |
| Same original caps | C=262144, L/P=65536, D=524288 (32 slots), F=32768; finite fixture only, not lifetime/KPI qualification. Ambiguous extended state images refuse before modification when the complete slot cannot fit F. |

The accepted areas are durable same-view NEW_VIEW identity and lock preservation;
complete pre-freeze funding closure with staged agreement fenced; issuer-plus-set
retry cutoff; protected endpoint selection with certified-lock floors; and exact
complete-slot torn-image retention or pre-modification refusal when F is insufficient.

Still unimplemented or unqualified:

- End-to-end cumulative copy/decoder work instrumentation under 256 MiB.
- Full automatic interrupted policy/owner-intent resume and committed-floor catch-up.
- Actual process-death/barrier matrix and complete failure-byte cases.
- Private issuer/wallet recovery and CLI/configured-verifier integration.
- Maximum-envelope 3 s live / 30 s offline deadline evidence.
- A complete bounded/preflighted, independently reviewed new 100-transition and
  >64-configuration path. NEVER rerun the old stopped frozen100 campaign.
- R3/K5 confidential publication AND query matching; R4/K6 observer privacy with
  sparse traffic/colluding edges. These remain future work after the active R1/R2 line.
- R5 integration and full K1–K8 qualification; R6/K8 independently operated
  deployment: at least 5 operators, 3 networks, 14 days, plus final platform tests.

The prior same-view regression really failed: two incompatible four-signature
PREPARE certificates, with three honest members signing both. The old returning
closure also failed at 255346+14138=269484 > C262144. Those are historical rejected
candidate results, preserved alongside current passing evidence; neither is a
new failure of the corrected candidate. The original implementation receipt retains
the detailed chronology and source limits.

The inherited public projection/fingerprint path **does not satisfy K5
confidentiality**: the [real-text fingerprint screen](docs/evals/scoped-fingerprint-real-2026-10-18.md)
failed linking/privacy gates. The inherited transport **does not satisfy K6
observer privacy**: the [cooperating-hop screen](docs/evals/private-adversaries-2026-10-18.md)
linked all 32 modeled requests. These are demonstrated failures within those
fixtures, not Internet-wide attack estimates; existing code must not be presented
as confidential matching or qualified observer protection.

## Invariants and acceptance

Read [the acceptance contract](docs/developers/v0.4-acceptance-kpis.md) before changing
behavior. Keep volunteer-only operation; five pinned members / quorum four /
at most one Byzantine; original trust pins, exact original evidence and rights,
uncertain operations, retries and permanent denials; role separation and private
issuer/wallet state. Never discard originals, refund failed allocations, relax
quorum or silently enlarge a fixture to make a pass.

Preserve 2 GiB aggregate storage, 512 reservation entries, independent 1 MiB
serialized metadata, 256 MiB cumulative reconstruction/copy work, 3 s live and
30 s offline limits. Funding must cover complete prospective physical completion
before freeze, accepted intent, readiness or an external completion promise.
Safety counterexamples and resource/alternative/effort stops retain their original
scope. Owner authorization already covers the same-design corrections and handover;
it does not accept the candidate or authorize a release.

## Transfer, identity and evidence

Local branch: `feature/v0.4-private-transport`; HEAD:
`c81d2ac55f083c62127d9ea663a3f2d30b078ffb`. The working tree contains substantial
inherited dirty/untracked work. **Transfer the full matching working tree**, including
untracked source dependencies and lock/config files. A fresh checkout of HEAD or
GitHub is insufficient. No claim is made that all local code is committed or pushed;
remote parity was not checked. Preserve unrelated changes; do not reset or clean.

The 931-path [source manifest](docs/handover/2026-10-24/source-identity.json) covers
current source/tests/scripts/configs including inherited dependencies. Its SHA256
is `973d85aab5fbd0961f0964a21e6e27c536c12e3ce5aa59a74ff4ceae11fc393e`.
It excludes documentation, generated output, dependencies and runtime data and is
an identity inventory, not a source archive. The eight candidate hashes still match.
[Local Git status](docs/handover/2026-10-24/local-git-status.txt) is the read-only
pre-handover observation, not a list of this documentation pass's changes.

[Portable evidence](docs/handover/2026-10-24/README.md) contains selected small textual
logs, original candidate manifests and correction patch, with exact hashes.
No secrets, user data, fresh encrypted runtime fixtures or thousands of historical
files were copied. Historical `/tmp` paths in receipts are external provenance:
unless explicitly copied/indexed, their availability after transfer is unknown.
A missing encrypted fixture cannot be claimed as a portable reopenable artifact.

## Setup and verification commands

Run from repository root. Recorded environment: Node **24.19.0**, Vitest **4.1.11**;
package engines require Node >=24. Preserve `package-lock.json`. On a new machine,
`npm ci` installs the locked dependencies and may require network/native build
prerequisites; it was not run during handover. Existing `node_modules` is local
installation state, not portable evidence. Consult [contributing](docs/developers/contributing.html)
for ordinary development setup; there is no approved CLI switch for this experiment.

```sh
# Actual core/relay/node source; no emit, no stale dist aliasing.
./node_modules/.bin/tsc -p docs/handover/2026-10-24/source-tsconfig.json --noEmit
# Focused corrected candidate; execute when a code change/review concern warrants it.
./node_modules/.bin/vitest run --maxWorkers=1 packages/relay/src/__tests__/sustainable-recovery-manifest.test.ts packages/relay/src/__tests__/sustainable-recovery-runtime.integration.test.ts packages/relay/src/__tests__/sustainable-recovery-equivocation.integration.test.ts
# Affected composition adds the two existing funding suites (33 tests).
./node_modules/.bin/vitest run --maxWorkers=1 packages/relay/src/__tests__/sustainable-recovery-manifest.test.ts packages/relay/src/__tests__/sustainable-recovery-runtime.integration.test.ts packages/relay/src/__tests__/sustainable-recovery-equivocation.integration.test.ts packages/core/src/__tests__/storage-reservations.test.ts packages/core/src/__tests__/local-encrypted-state-funding.test.ts
```

The relative source overlay preserves the intended compiler options of the historical
absolute `/tmp` overlay, but does not reproduce its demonstrated file selection.
The historical overlay returned no `files` in `tsc --showConfig`; the portable
overlay selects 671 source files, including the four new recovery runtimes. The
parent ran this portable noEmit command during documentation verification: **PASS,
exit 0**, with unchanged source identity. See [validation](docs/handover/2026-10-24/portable-typecheck-validation.json)
and [selected configuration](docs/handover/2026-10-24/portable-source-showconfig.json).
This confirms the current exact source, not the historical overlay's selection.
No app test or build was run in this documentation pass. Routine validation is macOS;
final explicit supported-platform qualification includes Windows/Linux. Full
`npm test`, app builds, installers and legacy campaigns are not implied next actions.

## Navigation and effort

Read next: [active checkpoint](docs/developers/v0.4-completion-plan.md),
[execution roadmap](docs/developers/v0.4-execution-roadmap.md),
[developer index](docs/developers/README.md),
[implementation receipt](docs/evals/v04-sustainable-recovery-implementation-2026-10-23.md).
The large [historical checkpoint archive](docs/handover/2026-10-24/completion-plan-before-handover.md)
is reference material; reading it is not required to resume.

Prior charged executor effort: 49+36=85 minutes, prior independent review 3m49s;
new failed-review effort and older/parent effort are unknown, not zero. Previous
shared-account observation 0%→1% is coarse and not per-model billing. This handover
uses one GPT-6.1 Sol executor with a 15-active-minute ceiling; no new quota
measurement, code execution campaign, network request or Git mutation is claimed.
Platform-specific model names in prior records describe prior routing preferences;
the receiving system can use a competent independent reviewer with equivalent scope.
