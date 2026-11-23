# DEC-023 oracle and outbox review — November 23, 2026

## Verdict

**ACCEPT FOR NOMINAL RE-RUN.** Persisted-state oracle reconstruction, raw index ordering and actual-cardinality outbox rotation are corrected and independently reviewed. No production gate or workload changed, and no production/K/R acceptance follows.

## Corrections

- Each relay initializes its oracle from that relay's current signed state, not the original seed snapshot.
- Incremental operations replay into matching state; reconstruction reads the resulting raw index order rather than an older Hamming snapshot.
- Exact generation, expiry, conflict and withdrawal filtering are preserved through `getActiveExactBytes()`.
- Validation errors identify the failed predicate and actual/expected generation IDs and ordered generation sequences.
- Outbox rotation uses actual retained entries, rotates at 48, and leaves the unchanged 64-entry production cap intact. A 65-operation control verifies safe rotation.
- A tied-query control proves production insertion order is preserved even when zero-query similarity ranking is opposite. Both actual-query candidates differ by 96 bits; reversed result order is rejected.
- Reconstruction, mailbox rotation and validator modules are included in artifact source identity.

## Validation

- Focused validator/outbox/scheduler/reconstruction controls: **19/19 passed**.
- Refreshed-state smoke: **6/6 good operations**, with two exact searches and no validation failures.
- Affected suites: **57/57 passed across nine files**.
- Actual-source noEmit, build and diff checks passed.
- Final independent review accepted a nominal rerun.

The earlier rate-limit refusals, stale-oracle errors, top-set mismatches and outbox-full failures remain preserved in the failed artifacts. No production defect is inferred from the corrected harness failures, and no production qualification is claimed.
