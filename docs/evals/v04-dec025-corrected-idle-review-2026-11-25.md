# DEC-024 corrected idle review — 2026-11-25

## Verdict

**The corrected idle run passes the local steady-state K7 memory and CPU checks.** Together with the passing nominal run, this justifies nominal executions 2 and 3 after adding protected-decision instrumentation. No further idle repetition is currently needed. Production and K1–K8 acceptance remain open.

- Artifact SHA-256: `1a6c48c1a51f8858e7eede9b3d0e30ca1fad56e81a8887b1795778981e913881`.
- Source log SHA-256: `e10716e9e0d2885aca78ba65190a1a1ad392db4ffdfe6255332d7f1599f24daa`.
- Source and seed identities exactly match the accepted nominal artifact.

## Passing local K7 checks

| Check | Evidence | Result |
| --- | --- | --- |
| Idle duration | 1,800.004 s, 361 samples | Meets 30-minute requirement |
| Idle CPU | **0.31947% of one core** | Pass against <=1% |
| CPU attribution | Parent 0.291755 s; five relays 5.458698 s | Fully reported |
| Fixed cardinality | Initial/final 10,000 on every relay | Pass |
| Signed expiry margin | 81,656,194 ms after measurement | Expiry does not explain RSS changes |
| Sustained aggregate RSS | Mean **253.48 MiB**; only initial sample exceeds 1.5 GiB | Passes measured steady-state check |
| Final timed aggregate | **138.875 MiB** | Below 1.5 GiB |
| Startup aggregate peak | **1.593 GiB** | Below measured 2 GiB envelope |
| Per-relay peaks | **293.562–332.156 MiB** | All below 512 MiB |
| Disk | Final = actual; growth 2 B; exact peak 371,333,942 B | Pass within instrumented coverage |
| Relay RSS sampling | 250 ms | Peak resolution preserved |
| Two-phase stop | Complete histories and final reconciliation | Pass |

At ten minutes aggregate RSS is 166,625,280 B and the final timed sample is 145,620,992 B. This supports a startup transient followed by low steady-state RSS rather than sustained memory pressure.

## Measurement boundaries

Initial/final active-cardinality scans and stats are outside the timed CPU window. This avoids per-sample full scans but means startup and final-stats CPU are not part of steady-idle CPU, and final-stats allocation is absent from timed aggregate samples. This is not a complete startup-to-shutdown resource envelope.

Physical power, pre-exec/dynamic-loader RSS, independent-host/reference hardware, async/external disk activity and all deployment requirements remain outside this result.

## Next action

Add harness-only measurement of the actual protected-decision span with focused controls/smoke; do not reuse full mailbox latency or change the three-second budget. Then run nominal executions 2 and 3 using fresh independently generated signed seeds, clean relay directories and fresh process trees, identical workload/limits, and predeclared source/seed identities. Do not reuse mutated nominal/idle state or select favorable seeds/results. Compute run variation and 95% confidence intervals afterward.
