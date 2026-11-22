# DEC-023 scaling-correction review — November 23, 2026

## Verdict

**ACCEPT FOR NOMINAL RE-RUN.** Incremental persistence and direct exact-generation lookup address the measured write/search amplification while preserving history, conflicts, withdrawal, dedup and result identity. This is focused correctness evidence only, not production qualification.

## Corrections

- First save atomically writes base publication/matching snapshots and creates a new incremental log; later saves append exact operations and dedup evidence rather than rewriting bases. Unpersisted operations, including conflict history, are retained.
- `complete.json` defines the committed prefix. Missing marker uses only the complete base; older marker ignores later records; malformed/missing/out-of-order records refuse rather than becoming accepted partial history.
- Atomic replacement uses temporary write, fsync, rename and parent-directory fsync. Server acknowledgment follows save.
- Search directly resolves exact publication/generation with expiry and current-sequence conflict checks instead of reconstructing active records and rescanning history for every match.
- Fresh TCP behavior, workload, deadlines, quotas and production rate limits are unchanged.
- Search harness now requires exactly one result, distinct publication identity and exact expected generation ID.

## Validation

- Focused store/matching/live/process/mailbox suites: **46/46 passed**.
- Actual-source TypeScript noEmit and `npm run build` passed.
- Diff checks passed.
- Independent review accepted a fresh nominal measurement.

Crash coverage for torn log markers remains a separate qualification requirement; this review does not infer full process-death closure.

## Existing resource failures remain open

The previous nominal run failed success, latency and memory targets. The independent 30-minute idle artifact reports 1.8307% CPU and 2,396,602,368 B aggregate peak RSS, failing idle CPU and startup memory. Fresh nominal and idle measurements are required; no improvement is claimed from focused tests alone.
