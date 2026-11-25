# DEC-024 corrected nominal review — 2026-11-25

## Verdict

**The corrected run passes the measurable single-run local K1 checks and the measured K7 startup, per-relay memory, network and disk checks. Full qualification remains incomplete.** Independent review verified the artifact, log, seed and source identities and supports one fresh 30-minute idle run on the same state.

- Artifact SHA-256: `971f21d56967881bf41208e4c9e0784e1170cfce48c2a929ab0d738f8c77987f`.
- Source log SHA-256: `eeddfe3b00682f7bcccc388f3e66de32ee46661c60e10121bdda1ac52804d5e2`.
- Seed artifact SHA-256: `5ab386945fb70e75f11c9d8c37251d6626109c636adaa9b3885057217606f71e`.
- Candidate: `1ba1fc2` on `feature/client-held-discovery`.

## Local K1 results

| Check | Evidence | Result |
| --- | --- | --- |
| Submitted/good | 1002/1002; zero refused, uncertain, inconclusive or deadline-exceeded | Pass |
| Success fraction | 100% | Pass against >=99.5% |
| Local warm p95 | 2,988.052 ms | Pass against <=6 s |
| p99 | 3,302.801 ms | Pass against <=10 s |
| Maximum good latency | 4,854.151 ms | Within 10 s private-operation budget |
| Publish/search/mailbox | 334/334 each | All complete |
| Exact replay | Five duplicate ACKs after 57.806 s real capacity wait | Passes this probe |
| Content | 4/4 | Pass |

Pacing is fully accounted: 334 publishes and 1,670 relay reservations. Aggregate capacity wait of 1,931,916 ms is excluded from operation latency but included in the 40.150-minute elapsed workload; maximum individual wait is 58.745 s. No offered work is hidden or reclassified.

The three-second protected-decision span is **not independently established**. Full-operation p95 values do not isolate that decision, and mailbox p95 is 3,193.268 ms. Exact replay does not prove zero duplicate notifications across every retry and restart scenario.

## Local K7 results

| Check | Evidence | Result |
| --- | --- | --- |
| Aggregate peak RSS | 2,004,402,176 B = 1.867 GiB | Below measured 2 GiB startup envelope |
| Post-load ready aggregate | 1,723,301,888 B = 1.605 GiB | Below 2 GiB |
| Maximum relay peak | 391,528,448 B = 373.391 MiB | Pass against 512 MiB |
| Final aggregate RSS | 1,151,008,768 B = 1.072 GiB | Below 1.5 GiB, not sustained evidence |
| Network per good operation | 96,134.528 B | Pass against 1 MiB |
| Network coverage | All mismatches zero | Pass |
| Disk reconciliation | Final = actual 371,333,423 B | Pass |
| Disk peak bounds | Lower = upper = 391,345,035 B | Exact within instrumented event model |

RSS measurement begins at module entry; pre-exec and dynamic-loader peaks remain unavailable. Final RSS does not replace 30-minute fixed-cardinality sustained measurement. Idle CPU and physical power remain unresolved.

## Remaining requirements and next action

Three executions per profile with variation/confidence analysis, explicit protected-decision timing, complete retry/restart duplicate evidence, fresh idle memory/cardinality/CPU, physical power, impaired-network and burst/fairness profiles, independent-host evidence and all K2–K8 requirements remain open. Repeated histories on one host are not independent deployment samples.

Run one fresh 30-minute idle artifact on this nominal state with the same source/seed identity, final-cardinality proof, RSS/disk accounting and two-phase stop. No production or K/R acceptance is implied.
