# DEC-025 burst4 diagnostic review — 2026-11-25

## Verdict: REVISE

The corrected diagnostic demonstrates major improvement, but two deadline overruns and the peak aggregate-memory field block qualification. Artifact, log, source and seed identities verify correctly.

| Check | Evidence | Result |
| --- | --- | --- |
| Success | 1000/1002 = **99.8004%** | Above 99.5% |
| Refusal/deadline-free | Two mailbox `deadlineExceeded` | **Fail** |
| p95 / p99 | 4,740.483 / 5,124.556 ms | Pass 6 s / 10 s |
| Publish/search | 334/334 each; no validation failures | Pass |
| Mailbox | 332/334 good | **Fail** |
| Exact retry/content | Zero retry failures; 4/4 content | Pass |
| Network | 96,317.2 B/good; zero mismatches | Pass |
| Per-relay peak | 364,986,368 B = 348.03 MiB | Pass |
| Aggregate peak | 1,882,046,464 B = 1.752 GiB | Below measured 2 GiB startup envelope |
| `processTreeRssPass` | Peak exceeds 1.5 GiB | **Fail under existing summary** |
| Disk | Final = actual 380,795,905 B | Pass |

Artifact SHA-256: `5d1fad92232a5753de1322d9536b5047ed2e0dc48e534b8afd3d94a2b8dcd780`; log `f0dfe1bb25c058ccb7f59fbd9f22ee495a85589c1e32696911633c302aba94a2`; seed `4b386ead86a44bcee6f7ec3accd7ec92d00f7170fc312ecd13d5c13a4d506f95`.

## Remaining evidence gap

The two overruns have no attached per-operation contention evidence. `errorClasses` is empty because work completed after the ten-second budget rather than throwing a named transport error. Parent load GC totals about 4.64 seconds and relay event-loop delays are around 22 ms, but these do not establish a ten-second causal window.

`depositNetworkMs` is the strongest aggregate phase signal: p95 4,673.986 ms and maximum 9,948.583 ms. Other phases could push the total beyond ten seconds, but aggregate data cannot identify the two sequences. External host interference is not inferred.

## Next action

Make a telemetry-only correction: attach phase timings, relay/phase occupancy, GC/event-loop windows and persistence spans to every `deadline_exceeded` operation, including successful-but-late work. Preserve sequence identity, workload, deadlines, quotas and scheduler behavior. Then run one fresh full diagnostic before any three-run campaign or production resource correction.
