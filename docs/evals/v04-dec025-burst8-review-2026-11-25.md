# DEC-025 burst8 review — 2026-11-25

## Verdict: REVISE

The burst8 evaluation fails overall. Independent review verified artifact, log, source and distinct seed identities. No hidden validation, exact-retry, disk-reconciliation or network-coverage defect was found. Production and K/R acceptance remain open.

| Field | Evidence | Result |
| --- | --- | --- |
| Operation count | 3 × 1,002 | Pass |
| Execution count | Three process/fresh-seed executions on one host | Mechanical pass only |
| Success | **2835/3006 = 94.311%** | **Fail**, target >=99.5% |
| p95 | Max 4,944.786 ms; t95 [2,474.127, 5,849.098] ms | Pass under existing 6 s rule |
| p99 | Max 5,644.532 ms; t95 [1,889.023, 7,021.717] ms | Pass under existing 10 s rule |
| Network | 99,998.65 B/good | Pass against 1 MiB |
| Per-relay RSS | Maximum 422,346,752 B = 402.8 MiB | Pass against 512 MiB |
| `processTreeRssPass` | Maximum 2,389,311,488 B = 2.225 GiB | **Fail** against existing 1.5 GiB field |
| Network coverage | Zero mismatches | Pass |
| Content | 4/4 in every run | Pass |
| Refusal/deadline-free | Run1 refusals, uncertainty, inconclusive results and deadline exceedances | **Fail** |
| Overall burst8 | — | **Fail** |

Runs2 and3 also exceed the separate measured 2 GiB startup envelope. All disks reconcile and all exact retries succeed.

## Run1 operation failure

Run1 has 831 good, 2 refused publishes, 1 uncertain mailbox, 165 inconclusive searches and 3 deadline-exceeded operations. Sequence 378 publish times out on relays 0, 1 and 2; sequence 381 times out on all five. Those outcomes invalidate every fixture oracle. Subsequent searches correctly become `validation_inconclusive_pending_reconciliation` rather than being promoted to good. `validationFailures` is empty, so no generation ordering or identity error is established.

The evidence supports transport timeout/oracle invalidation, not a demonstrated semantic search defect. Burst-related resource contention is a hypothesis requiring direct instrumentation. Deposit-network p95 is 4,926.797 ms and maximum 7,692.462 ms.

## Startup memory

The >2 GiB outcomes are primarily post-load startup phenomena:

- Run1 ready-relay peaks total 1,733,738,496 B; parent post-load contribution is 52,969,472 B. Aggregate peak rises another 206,913,536 B during the run.
- Run2 ready-relay peaks total 1,944,256,512 B; parent contribution is 400,670,720 B. Aggregate peak equals post-load ready at 2,344,927,232 B.
- Run3 ready-relay peaks total 1,956,773,888 B; parent contribution is 410,058,752 B. Aggregate peak is 2,389,311,488 B.

Runs2 and3 therefore exceed the limit before coordinator traffic begins. Both parent and relay contributions vary; GC/allocation timing is unmeasured. No clean concurrency-only or external-host explanation is inferred.

## Next correction block

1. Reconcile uncertain relay state using exact-current lookup/replay evidence while preserving original refused/uncertain outcomes. Do not clear inconclusive counts without exact generation and production-order proof.
2. Record relay event-loop delay, queue occupancy, RPC phases and synchronous persistence/compaction spans around timeout bursts; address demonstrated blocking without changing burst size, deadlines, quotas or rate limits.
3. Attribute parent/relay startup allocation and GC timing; reduce avoidable fixture/state duplication only after identifying it.

Complete this diagnostic/correction block before another burst campaign. Protected-admission evaluation follows it. Artifact hashes: run1 `7146847ef4b6c68fc8f129dbef9915da3df63c87fced2c2b8d6e9090b03226bf`, run2 `083959f34379f936a483cf92ca62fcda5bb90f3fbd7a56609e014e15d306f7b6`, run3 `0dff2c5d25f224efac0b0c2345c7e06841f0aded3205af4271ef665aebfffbe0`.
