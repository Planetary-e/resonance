# DEC-025 three-run nominal review — 2026-11-25

## Verdict

**The three fresh-seed nominal executions pass local K1 success/latency and measured startup, per-relay, network and disk checks. The complete existing nominal evaluation still fails `processTreeRssPass`.** No further nominal executions are justified. Next is the required burst8 profile, followed by protected-admission evaluation.

Independent review verified source identities, per-run seed identities, run2/run3 log hashes and all outcomes. These are independent process/seed executions on one macOS host, not independent deployments, devices, days or operators.

## Three-run evidence

| Check | Evidence | Result |
| --- | --- | --- |
| Operation count | 3 × 1,002 = 3,006 | Pass |
| Execution count | Three process/fresh-seed executions | Mechanically passes existing field |
| Overall success | **3006/3006 = 100%** | Pass against >=99.5% |
| Refusal/uncertainty/deadline outcomes | All zero | Pass |
| p95 runs | 2,988.052 / 3,731.120 / 3,343.809 ms | Maximum below 6,000 ms |
| p95 Student-t95 interval | **[2,431.108, 4,277.546] ms** | Does not straddle 6,000 ms |
| p99 runs | 3,302.801 / 4,304.270 / 3,992.643 ms | Maximum below 10,000 ms |
| p99 Student-t95 interval | **[2,593.453, 5,139.690] ms** | Does not straddle 10,000 ms |
| Network | 288,977,934 B = **96,133.7106 B/good** | Pass against 1 MiB |
| Maximum per-relay peak | **391,528,448 B = 373.391 MiB** | Pass against 512 MiB |
| Maximum aggregate peak | **2,004,402,176 B = 1.867 GiB** | Below measured 2 GiB startup envelope |
| `processTreeRssPass` | Peak exceeds 1.5 GiB | **Fail under existing summary logic** |
| Content | 4/4 in every run | Pass |
| Disk reconciliation | Final = actual in every run | Pass |

The aggregate peak is below the 2 GiB startup envelope and does not contradict the separate 30-minute sustained-memory pass. The failing field is the harness's peak-based application-RSS comparison. It is preserved rather than rewritten after observing the result.

Artifact identities:

- Run 1: `971f21d56967881bf41208e4c9e0784e1170cfce48c2a929ab0d738f8c77987f`.
- Run 2: `2c45eb96b0c8a7fbbad9bd356b30e1b25377afeafca6af9fd1bc4bf9b1564128`; log `5ddbd872820619b381974d27408e2e07b2c12dd1f4739f14de08161bf2cef2de`.
- Run 3: `98b4a87663deb34fec48f70db3e3331fcaeda2281a260a468bb7b071edd4ce10`; log `09bc0aa06d546d4064862431c17c6de6515e8212c4d309d789aa437a1dae0158`.
- Current run3 seed artifact: `54cebb709f838d5215ed24ba2b37186ca2fd588589f5f6d223851d30c6668391`.

## Remaining qualification and next action

Burst8 and its three executions, protected admission, impaired networking, complete retry/restart duplicate evidence, physical power, pre-exec resources, reference/independent-host evidence and all K2–K8 requirements remain open.

Run burst8 with fresh independent signed seeds, clean relay state, fresh process trees and unchanged workload/rate limits. Then evaluate the real protected `withDecision` admission path, not the digest-only fixture. No production or K/R acceptance is implied.
