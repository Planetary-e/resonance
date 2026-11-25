# DEC-024 resource correction review — 2026-11-25

## Verdict

**ACCEPT FOR ONE FULL NOMINAL RUN FOLLOWED BY ONE FRESH 30-MINUTE IDLE RUN.** Independent follow-up review resolved the prior RSS/disk-measurement blockers. This accepts the correction candidate for measurement, not production or K1–K8 acceptance.

## Corrections accepted

- A shared pre-submission scheduler paces both coordinators across all five relay/source buckets within the unchanged 10 publishes/minute/source-IP limit. Capacity waiting is reported separately, excluded from per-operation latency, and included in total elapsed time. Every scheduled operation remains submitted and accounted.
- Exact replay retains independent actual-submission accounting and conservative quiet-window capacity handling.
- `LeasedIndexStore.byGeneration` uses maintained generation state instead of scanning all 10,000 publications on mailbox preflight, deposit and ACK. Historical/current generations survive refresh, conflict, replay, expiry and withdrawal paths. Per-acceptance fsync and compaction behavior are unchanged.
- Idle artifacts record initial/final active cardinality, stability and signed seed expiry relative to the measurement window, with parent/per-relay CPU attribution.
- RSS qualification sampling remains 250 ms in both nominal and idle modes.
- Event-based disk accounting replaces recursive periodic walks. Parent and relay histories cover exercised synchronous creation, writes, append, truncate, rename, copy, link and deletion paths, including temporary atomic-replacement peaks. Same-timestamp cross-process peaks are bounded rather than assigned a false total order. Seed, nominal and idle require computed final bytes to equal a real final directory walk.

Production persistence, workload, quotas, deadlines, rate limits and ordinary maintenance remain unchanged.

## Verification

Reproduced on the candidate:

- **71/71 tests passed across 13 files**, including live composition, process death, network faults, exact replay, scheduler and disk-accounting controls.
- Actual-source TypeScript noEmit, `npm run build` and `/opt/homebrew/bin/git diff --check` passed.
- Development smoke: **6/6 good**, exact replay acknowledged, no refusals/uncertainties/deadline overruns, and stable idle cardinality.
- Smoke disk accounting reconciled exactly for seed, nominal and idle; RSS interval was 250 ms.
- A two-operation development control at 10,000 publications reduced mailbox p50 from 3,196.7 ms to 150.0 ms. This is not a qualified percentile.

## Measurement boundaries

Disk accounting covers synchronous instrumented parent/relay paths. Async APIs, streams, uninstrumented descriptors and external-process changes are excluded; final reconciliation detects but does not attribute uncovered divergence. Values are logical file bytes, not allocated blocks or directory metadata. Cross-process same-timestamp ordering is bounded.

The next evidence is one full nominal run, then one fresh 30-minute idle run on the same candidate/state. Physical power, packet impairment, independent deployment, privacy and K2–K8 gates remain open.
