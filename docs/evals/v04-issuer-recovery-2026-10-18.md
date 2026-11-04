# Issuer recovery operator experiment

Parent blocker: **B-HISTORY-LIFECYCLE**, contributing to K2 and K4. This extends the
existing frozen-history protocol and reviewed issuer restoration API at `c74faeb`;
it is not a new architectural alternative and does not reset historical counters.
No complete KPI is claimed by this experiment.

## Predeclared hypothesis and acceptance

An explicitly approved, durably journaled recovery can survive process death and
resume the same selected issuer history without losing acknowledged decisions,
clearing policy fences, refunding quota or issuing a second signature for a retained
batch. Available owner evidence includes both applied and pending images; it must
be completed and fenced before remote freeze. Unavailable owner state is an explicit
operator declaration, never inferred from a failed read.

The minimum meaningful improvement over the API-only baseline is an actual Node
operator workflow that completes recovery after every declared interruption, or
refuses while preserving all evidence when the state cannot safely be resumed.
No safety exception or deadline increase is an acceptable substitute.

Predeclared process-death boundaries:

- Before and after source-fence publication.
- Before and after recovery-journal publication.
- Before and after component-creation intent and registration.
- After frozen proposal, agreement selection, confirmation and provisioning.
- After restored owner, writer and archive publication.

Use five actual local volunteer services, signed allocations and blind issuance,
original enrollment and independently retained keys. Kill a separate Node process
at named persistence boundaries; preserve interrupted artifacts and verify the
same obligations afterward. Include exact completed/prepared replies, unresolved
reservation, newer policy floor, retirement, missing registered files, stale review,
wrong genesis, three-copy refusal and later remote history during pristine resumption.
Existing semantic and two-recovery tests remain part of the composed regression.

Resources: one local computer; bounded fixtures and one-worker regression runs;
no native installers or production traffic. Per-network maintenance attempts keep
their existing finite deadlines. The experiment's local fault cases are not the
1,000-scenario K2 qualification, 100 lifecycle cycles, reference hardware or K8 pilot.
Any reproducible safety violation or structural counterexample triggers the agreed
stop policy; ordinary compile/test plumbing corrections do not redefine the target.

## Prospective effort (UTC)

- Coordinator: 15:51:43–16:11:32 (1,189 seconds, implementation, review, tests and documentation; no idle-only interval counted).
- Astra architecture: 15:51:37–15:52:44 (67 seconds).
- Luna API inventory: 15:51:39–15:52:12 (33 seconds).
- Sol storage/source/resumption: 15:53:21–16:06:36 (795 seconds).
- Sol recovery orchestration/commands: 15:53:41–16:05:23 (702 seconds).
- Luna CI inventory: 15:54:36–15:55:27 (51 seconds).
- Astra implementation review: 16:02:00–16:05:48 (228 seconds), recovered from
  its prospectively reported interval. A separate harness review was reported
  approximately 15:56:29–15:56:45 (about 16 seconds); keep that estimate separate
  from exact recorded totals.

These intervals do not reconstruct unknown historical work or reset the cumulative
blocker budget. Idle waiting is excluded from active effort accounting.

## Results

The Node workflow, source fencing and reviewed restoration resumption are
implemented. `npm run build` passes. The one-worker composed regression passes
**195 tests across 20 files in 217.92 seconds**, including all 27 real SIGKILL
boundaries and actual CLI recovery through two generations. The three new suites
are included in the macOS/Windows/Linux ownership CI job; this candidate's remote
result remains to be observed.

Review found three implementation defects before integration: fresh destination
approval used lexical rather than canonical paths; source approval omitted source
paths; and deferred fencing/resumption lost the managed storage authority context.
These were corrected with path-retarget, source-selection and escaped-authority
regressions, and reviewed again. No accepted-operation loss or structural protocol
counterexample was demonstrated. None is hidden by redefining the experiment.

The preceding `c74faeb` Windows CI timed out in an existing current-head test whose
five-second body included durable fixture setup. `13f7ba9` moves setup to a bounded
hook and preserves the original 150 ms operation deadline, five-second body timeout
and one-second elapsed assertion. Its ownership and desktop jobs pass on all three
OS families; the general Linux suite was still running at this checkpoint. This
isolates setup from the assertion; it does not prove a production timing defect
was fixed. The separate older intermittent observation-challenge failure remains
causally unresolved.

The experiment meets its bounded operator-recovery acceptance. It does not close
K2 or K4, provide the 1,000-scenario/100-cycle qualification, protect allocation
authority owner loss, eliminate ambiguous signing or establish volunteer Internet
availability. Continue the independently actionable allocation-authority journal
protection under the same parent blocker.
