# Protected allocation-authority experiment

Parent blocker **B-HISTORY-LIFECYCLE**, contributing to K2/K4. This applies the
existing reviewed four-of-five checkpoint protocol to the allocation authority's
signed plans and claim assignments. It is not a new protocol alternative and does
not reset cumulative effort or prior alternatives. Base: `eb8a3f2`.

## Predeclared hypothesis and acceptance

A new protected authority journal can retain each immutable signed allocation
and claim reservation before releasing it, survive interruption with the same
signed result, and refuse conflicting periods or reassignment. A shared storage
implementation must preserve existing issuer byte formats and role isolation.

Minimum meaningful improvement: actual volunteer-backed plan and assignment
commits, with three-copy refusal/four-copy completion and separate-process
interruption at local intent, retained quorum and owner apply. Reopening must
resume the exact retained signature, never silently create missing committed
files or leak pending-only records through offline reexport. Existing local
authority and protected issuer regressions must still pass.

The authority semantic parser authenticates canonical signed records and their
allocation/claim/quota linkage. Protected genesis is empty v2. Each successor is
unchanged or appends exactly one plan or one assignment; retained records cannot
be removed, reordered or replaced. Existing limits remain 64 plans, 2,048
assignments and bounded encrypted storage, with refusal at capacity. Only new
protected journals are supported; no automatic conversion or unreviewed restore.

Tests must cover invalid signatures, historical expiry, duplicate/conflicting
periods, reassignment, wrong allocation binding, capacity and wrong authority,
role and owner format. Distinct history owner and allocation signing keys are
permitted and independently pinned. The static empty-genesis descriptor binds
`context.policyDigest`; it is not a claim of live policy freshness.

Resources: one computer, five real local volunteer services, existing Ed25519
signatures and finite maintenance deadlines. Root supplies integration and
interruption evidence; two Sol tasks implement semantic helpers and storage/API;
Astra defines and reviews their boundary. No eligibility source, new trust model,
permanent server, production activation, merge or installer is introduced.

Any reproducible safety failure or structural counterexample invokes the agreed
stop policy. Compile/test plumbing corrections do not alter this acceptance.
Complete owner-loss restoration, capacity reclamation and independent eligibility
qualification remain separate necessary work, not claimed by this experiment.

## Prospective effort and evidence

- Astra design: 16:07:05–16:08:04 UTC, 59 seconds.
- Luna authority inventory: 16:06:09–16:06:46 UTC, 37 seconds.
- Sol semantic/legacy implementation: 16:10:31–16:16:14 UTC, 343 seconds.
- Sol protected storage/API: 16:12:17–16:23:37 UTC, 680 seconds.
- Astra review/next-phase design: 16:20:32–16:23:03 UTC, 151 seconds.
- Sol CI diagnosis/test separation: 16:19:51–16:24:29 UTC, 278 seconds.
- Astra CI test review: 16:25:11–16:25:24 UTC, 13 seconds.
- Coordinator: 16:11:32–16:27:48 UTC, 976 seconds; includes integration,
  documentation and related CI review, with no idle-only interval counted.
- Other implementation/review intervals will be recorded at handoff; unknown
  historical effort is not invented. Idle waiting does not count as active effort.
- TypeScript builds. The final one-worker composed regression passes **234 tests
  across 27 files in 244.10 seconds**, including legacy authority, full protected
  issuer/recovery regressions, role enrollment and the new authority suites.
  Eleven real-volunteer tests include ten distinct SIGKILL cases. The separate
  affected desktop suites pass all 12 tests. Exact-candidate CI remains pending.

The bounded protected-commit objective is met and independently reviewed. No
whole KPI is complete: continue authenticated authority owner-loss restoration,
then operator interruption coverage, with sustainable retention and independent
eligibility/availability requirements still open.

## Review and CI findings

Review tightened the new authority's encryption-domain separation and copied-key
cleanup. It also required a synchronous currentness check immediately before
durable intent, after asynchronous state verification; a focused regression now
exercises that boundary. Public named wrapper types preserve portable TypeScript
declarations without exporting the internal storage engine. These corrections
do not change issuer persisted bytes or admit an alternative protocol.

At the preceding `eb8a3f2` commit, Windows desktop CI timed out in the inventory
test (5 seconds) and conflict-observer activation test (15 seconds). Local phase
profiling reproduced no hang: inventory fixture preparation took 366 ms and its
assertions 12 ms; activation preparation/protocol calls were likewise bounded.
The exact slow Windows stage remains unknown. Genuine durable fixture creation
now has separate 15/30-second hooks, while inventory/activation bodies retain
their 5/15-second limits and production operation deadlines remain unchanged.
The conflict setup now requires the exact equivocation error. All 12 affected
tests pass locally in 19.69 seconds; this is not proof of a production timing fix.

The same preceding run's Windows ownership job also hit its **15-minute job
limit**. The job API records 16:13:24–16:28:28 UTC, and its check-run annotation
explicitly reports the limit. The protected-history step started at 16:15:34;
that step timestamp must not be mistaken for job startup. All 27 issuer recovery
SIGKILL cases passed in 226.441 seconds before the overall job was cancelled.

To retain growing coverage within the existing bounds, 20 issuer/allocation
suites move to a separate `admission-durability` job on the same three operating
systems, with one worker and the same 15-minute limit. Other ownership checks
remain in place. The complete test-path multiset is preserved; no test or
production timeout is increased and no installer is built. The new layout
requires its own remote result.

## K8 dependency matrix

| Operation | Authority dependency |
| --- | --- |
| New allocation or assignment | Signing key holder and this authority history's usable quorum |
| Authority recovery | Independently retained keys, authenticated ancestry and usable history quorum; authority-specific restoration is not yet implemented |
| Cached signed-record reexport | Retained applied authority record; no live quorum needed for reexport alone |
| Issuance using an existing assignment | No newly introduced authority-online dependency |
| Redemption of issued tokens | No newly introduced authority dependency |

Physical placement determines correlation: histories on shared volunteers do not
constitute independent cohorts. The earlier 55-history fixture did not measure
this new deployment. Link this matrix to the composed availability evidence and
include actual placement, owners, routes and schedules before K8 qualification.
