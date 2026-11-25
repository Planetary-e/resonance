# DEC-025 protected-admission campaign review — 2026-11-26

## Verdict

**ACCEPT for the bounded protected-admission measurement.** All three artifacts verify against their hashes and all source hashes match the worktree. Each run uses a distinct policy authority/history identity and valid signed policy, quorum and durable stores.

- Five real queue-to-settlement decisions per run, plus invalid token rejection before queue entry with no fabricated duration.
- Accepted 2, replay 2 and rejected 2 per run, with correct `double_spend` handling and no errors.
- Queue order is consistently `queued → preparation_started → preparation_ready → exclusive_started → settled → drained`.
- Span includes preparation/exclusive waits, policy/history reads, four-of-five witness votes, coordinator certificate work and durable authorized-spend commitment.
- History advances sequence 1→3, spends 0→2 and certificates 1→3 in every run.
- `expectedOutcomes`, `deadlinePass`, `historyPass` and overall `pass` are true in every run.

Timing:

- Run p95/max: **197.098, 208.001 and 199.238 ms**.
- Three-run mean: **201.445778 ms**.
- Student-t95 interval: **[187.095674, 215.795881] ms**.
- Maximum: **208.000708 ms**, well below the unchanged 3,000 ms deadline.

Artifact hashes: run1 `5e22775b91eff446629dbe297b418ecac65d22175f068bd3728fa80523c5b918`, run2 `47e1497f141e13bebb8980c8b4b7326d0dc66c1c5abfac0289a05d83ab7d4b0a`, run3 `784391269aaa9afcdaea07d40ce5af626ef92ec7e3907598c7641630806f86d6`.

## Next production-qualification step

Move beyond in-process timing to independent-host and impaired-network admission measurements. These are three independent process/seed executions on one host, not independent deployments.

The unresolved `processTreeRssPass` failure and allocator/RSS variability remain. K4 eligibility automation, false inclusion/exclusion and Sybil/quota fairness, privacy, independent operators, deployment and other K1–K8 requirements remain open. No production or K/R acceptance is implied.
