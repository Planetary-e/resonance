# DEC-025 burst diagnostic correction review — 2026-11-25

## Verdict

**ACCEPT FOR ONE FRESH FULL BURST DIAGNOSTIC.** This is not a three-run qualification campaign or production/K/R acceptance.

## Reviewed corrections

- Uncertain relay state clears only after exact-current lookup, production-order `LeasedIndexStore` replay and active exact-byte equality. Original refused/uncertain outcomes remain unchanged.
- `acceptReconciled()` replaces an existing publication without moving its map position. After every relay reconciliation cycle, the harness reconstructs the complete oracle once from the persisted incremental log and records `order_reconstructed`.
- `replaceWith()` preserves unresolved uncertainty. New publications use persisted reconstruction rather than an invented map position.
- A deterministic tied-fingerprint control proves A-lost-ACK/B-acknowledged/A-reconciled remains **A,B** immediately and after restart, rejects **B,A**, and leaves the original ACK outcome failed.
- Bounded event-loop/GC/RPC/persistence telemetry records contention windows without forcing GC. Canonical signed operations are shared across fixture states only after exact signed-byte comparison.

Independent follow-up found the earlier append-on-reconcile ordering defect resolved and the remaining uncertainty, telemetry and canonical-sharing behavior sound.

## Evidence

- Focused oracle/search/uncertainty/runtime tests reproduced locally: **14/14 passed**.
- Implementer affected composed regression: **76/76 passed across 15 files**, including live/process-death, persistence, network-fault and disk tests.
- Actual-source noEmit, build and diff checks passed.
- A prior 24-operation full-cardinality diagnostic had 24/24 good operations, parent ready contribution 33,062,912 B and post-load aggregate 1,669,758,976 B. This is not full-scale evidence.

Run one fresh full burst diagnostic to evaluate ordering, timeout behavior, startup allocation and telemetry at full scale. Do not start a three-run campaign unless this diagnostic supports it.
