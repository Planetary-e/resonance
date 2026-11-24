# DEC-023 fresh nominal resource review — 2026-11-24

## Verdict

**Local K1 qualification fails. K7 shows substantial memory improvement, but remains incomplete.** Do not repeat nominal runs 2–3 on the unchanged candidate. Run one fresh 1,800-second idle measurement on the same full-scale candidate/root, then address the offered-load and latency failures before further nominal qualification.

This is not production acceptance or acceptance of K1–K8.

## Evidence integrity

Independent review verified:

- Artifact SHA-256: `c316ff1584e02c36eaab33a8ff79b8e102ac853377fd2df7663e6f44fc8c0914`.
- Source log SHA-256: `37a0559285b840b19944e1100c324da19fee445940b23163909bd35054231956`.
- Candidate: `feature/client-held-discovery` at `2bcd87730f7c33bd05d6d5406dacb8d49e32d2b2`.
- Every recorded production/harness source hash matches the worktree; both seed-data hashes match the retained full-scale root.
- The seed artifact records 10,000 accepted/active publications and five materialized replicas.
- Log operations, elapsed time, network bytes, profile and run number match the artifact.

The source hashes identify the exact candidate more precisely than HEAD alone. The log is a matching run summary, not independent raw telemetry.

## Operation and K1 findings

| Check | Result | Assessment |
| --- | ---: | --- |
| Submitted operations | 1,002 | Single-run size passes; three executions absent |
| Overall success | 861/1002 = **85.928%** | **Fail**, target >=99.5% |
| Local warm p95 | **6,809.722 ms** | **Fail**, target <=6,000 ms |
| Conditional-good p99 | **8,529.057 ms** | Passes <=10,000 ms numeric check |
| Private-operation deadline | 1 mailbox deadline exceeded | **Fail** |
| Publish | 194/334 good; 140 production rate-limit refusals | **Fail**; refusals remain failures |
| Search | 334/334 good; no validation failures | Passes this local probe only |
| Mailbox | 333/334 good; p95 7,712.570 ms | **Fail** |
| Exact replay | Five duplicate ACKs after 51.746 s capacity wait | Passes this probe only |
| Online content | 4/4 good | Passes this local probe only |

The run lasted 24.293 minutes, offering approximately 13.75 publishes/minute/relay against the unchanged 10/minute/source-IP limit. Repetition without changing this workload or implementation predictably repeats refusals. Latency percentiles are conditional on good operations; refused and incomplete operations cannot be removed from the success denominator. The artifact does not separately identify the protected-decision span, so it cannot establish the three-second protected-decision requirement.

## K7 findings

| Check | Result | Assessment |
| --- | ---: | --- |
| Maximum per-relay peak RSS | **495,058,944 B = 472.125 MiB** | Passes <=512 MiB |
| Aggregate peak RSS | **1,832,353,792 B = 1.707 GiB** | Below 2 GiB measured startup envelope |
| Post-load ready aggregate | **1,714,864,128 B = 1.597 GiB** | Below 2 GiB |
| Final aggregate RSS | **1,590,362,112 B = 1.481 GiB** | Below 1.5 GiB by about 19.3 MiB, but not sustained evidence |
| Network per good operation | **111,869.275 B** | Passes <=1 MiB including recorded failures |
| Network coverage | All mismatches zero | Pass |
| Fresh idle CPU | Not measured | Unresolved |
| Incremental physical power | Not measured | Unresolved |

Startup RSS begins at module entry and uses ready peaks; pre-exec measurement is unavailable. The final aggregate is encouraging but does not satisfy the required 30-minute fixed-cardinality sustained-memory check. The harness summary's peak-based `processTreeRssPass` would remain false because 1.707 GiB exceeds its 1.5 GiB peak comparison; this is distinct from the sustained-memory definition.

Against the prior artifact, good operations rose from 807 to 861, aggregate peak fell from 3.194 GB to 1.832 GB, and maximum relay peak fell from about 752 MB to 495 MB. Overall p95 regressed from 5.603 s to 6.810 s. The prior run's publishes were duplicates while the fresh run performs accepted refreshes and maintenance, so this is not an apples-to-apples causal latency experiment.

## Next action and unresolved gates

Run exactly one fresh 30-minute idle artifact using the same candidate and full-scale root, without concurrent host work. It can resolve sustained RSS and idle CPU after material memory changes, but cannot rescue failed K1 or supply physical power evidence. Do not run further nominal repetitions until the source-IP offered-load mismatch and operation latency are addressed.

All external blockers remain: independent-host qualification, below-TCP impaired-network profiles, physical power, complete retry/restart duplicate evidence, and the independent K2–K8 fault, lifecycle, corpus, privacy and volunteer-deployment requirements.
