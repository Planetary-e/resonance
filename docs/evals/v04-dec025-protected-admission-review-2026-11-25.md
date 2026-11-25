# DEC-025 protected-admission review — 2026-11-25

## Verdict

**ACCEPT FOR A THREE-EXECUTION PROTECTED-ADMISSION CAMPAIGN.** Independent review confirms genuine measurement without changing admission semantics.

Observer callbacks are optional and exception-isolated. `queued`, preparation, exclusive, settled and drained events use real queue transitions and monotonic `performance.now()` timestamps. Queue-to-settlement includes both waits, policy/history reads, witness votes, coordinator certificate work and durable spend commitment. Draining is reported separately.

Five timed decisions have p95/max **252.781 ms**, below the unchanged 3,000 ms deadline. Exact duplicates return `replay`; conflicting reuse rejects `double_spend`; invalid tokens reject before queue entry with no fabricated duration. History advances sequence 1→3, spends 0→2 and certificates 1→3. No additional spend occurs for replay or rejection.

Artifact: `delivery/results/protected-admission-measurement.json`, SHA-256 `b5d6fd890622959f8213251d69afe85869139fe4cb511aaa2a82f9052362f2a2`.

Focused/integration suites: **16/16 passed**; actual-source noEmit, build and diff checks passed. This is one bounded in-process batch, not K1/K4 or production acceptance. Run three fresh-state executions and compute variation/confidence intervals. The existing `processTreeRssPass` failure, allocator variability, independent-host/impaired-network work and other K1–K8 gates remain open.
