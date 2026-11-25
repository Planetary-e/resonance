# DEC-026 production-qualification status and external evidence gaps — 2026-11-26

## Status

**Production qualification is not achieved.** The client-held discovery candidate has substantial passing local evidence, but mandatory resource, privacy, recovery, independent-network and deployment gates remain open. No K1–K8 or release claim is made.

## Passing local evidence

- Three fresh-seed nominal executions: **3006/3006 good**, p95 maximum 4.715 s and p99 maximum 5.191 s; all exact replay, content, network-coverage and disk reconciliation checks pass.
- Thirty-minute idle: **0.31947% of one core**, stable 10,000 active publications per relay, mean aggregate RSS 253.48 MiB, per-relay peaks below 512 MiB and exact disk reconciliation.
- Three fresh-seed burst8 executions: **3006/3006 good**, with the same operation/latency/network/disk passes.
- Three real protected-admission executions: 15 queue-to-settlement decisions with correct outcomes and durable history; maximum **208.001 ms** against the 3,000 ms deadline, with actual policy/history preparation, four-of-five witness votes and durable spend commitment.
- Live integration, real process-death and ordered-TCP fault controls exist. Ordered TCP proxy evidence is not below-TCP packet impairment evidence.

## Open blockers

| Gate | Current evidence and exact gap |
| --- | --- |
| K1/K7 resource envelope | `processTreeRssPass` fails. Burst aggregate peak reaches 2,141,306,880 B. Attribution supports allocator/RSS retention and GC timing variability, with no demonstrated duplicate retention; variability is unresolved, not fixed. |
| Physical power | No physical idle-power measurement. `sudo -n powermetrics` fails because a password is required. CPU seconds are not watts. |
| Protected admission deployment | Three local process/seed runs pass, but independent-host and impaired-network admission measurements are absent. |
| Packet impairment | Host has no accepted below-TCP loss/delay/retransmission profile. Existing proxy supplies ordered TCP latency and resets only. |
| K2/K3 recovery and authority | FEAT-001 authority/policy/witness recovery remains open. Client-held content does not replace it. |
| K4 eligibility and fairness | Real admission timing passes, but eligibility automation, false inclusion/exclusion, equal-rights fairness and 100-identity quota resistance are unqualified. No independently labeled adversarial corpus exists locally. |
| K5 fingerprint privacy | Existing evidence shows 86–97% reconstruction and 100% known-text identification, not acceptable privacy. A separate confidential matching decision is required. |
| K6 observer privacy | No activity/source-linking AUC. A real independently operated re-encrypting mix, fixed cells, delays and cover traffic require separate authorization and measurement. |
| K8 independent operation | No 14-day pilot with at least five independent operators across at least three networks, including all supported OS families and required quorum dependency graphs. |

Three process/seed executions on one host are not independent deployments, devices, days or operators.

## Required external inputs or decisions

1. A usable physical power-measurement path, currently requiring the host sudo password or an owner-run measurement.
2. Independent hosts/networks and a supported below-TCP impairment environment for admission and end-to-end profiles.
3. An independently labeled admission eligibility/fairness corpus and threat model.
4. Separate R3/K5 and R4/K6 protocol decisions and implementations; current privacy approaches do not qualify.
5. A new owner-authorized authority/recovery model for FEAT-001 and its independent review.
6. A resource decision based on the unresolved RSS variability; no threshold change or forced-GC workaround is inferred.
7. After local qualification, independently operated deployment and the K8 pilot.

Committing or pushing further local evidence does not close these gaps.
