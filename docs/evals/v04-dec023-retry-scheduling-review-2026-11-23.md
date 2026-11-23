# DEC-023 exact-retry scheduling review — November 23, 2026

## Verdict

**ACCEPT FOR NOMINAL RE-RUN.** The harness-only retry scheduler now accounts for all coordinators, each relay's independent fixed window, unknown first requests and the production strict reset boundary. No production behavior or gate changed.

## Corrections

- Attempts are aggregated across both coordinators within each relay/source-IP bucket.
- Each relay window is handled independently; all five are awaited.
- Unknown window starts use a conservative quiet window after the last possible attempt instead of inferring capacity from the client timeline.
- Capacity waits are recorded separately from primary latency and do not pace or reduce the offered workload.
- Exact replay still targets a fully acknowledged original and retains every relay's result/reason.
- The scheduler is included in artifact source identity.
- When possible attempts exist at exactly window expiry, the harness waits 1 ms; zero is returned only after the production strict `>` boundary. Tests cover exact 60,000/60,001 and missing-first 110,000/110,001 boundaries.

## Validation

Focused scheduler/validator/partial-success/uncertainty controls: **14/14 passed**. Development smoke had 6/6 good operations, exact replay returned duplicate on all five relays, and the conservative shared-window wait completed with zero retry failures. Actual-source noEmit, build and diff checks passed.

The earlier `exact_retry_capacity_unavailable` artifact remains preserved. No production or K/R acceptance follows from harness acceptance.
