# DEC-023 failed local quantitative baseline — November 22, 2026

## Verdict

**LOCAL PRODUCTION QUALIFICATION FAILED.** One 10,000-publication nominal run and one 30-minute fixed-cardinality idle run do not meet the unchanged K1/K7 targets. These are real implementation/resource failures, not a harness-only issue. No production, K/R or deployment acceptance follows.

Authorization is `delivery/decisions/DEC-023.md`. Raw sanitized artifacts are `delivery/results/client-held-local-resource-nominal-run-1.json` and `delivery/results/client-held-local-resource-idle-1800s.json`.

## Nominal workload

The harness used five real relay listeners, 10,000 retained publications per relay, fixed derivation/fingerprint fixtures, actual WSS connections, and 1,002 submitted operations assigned round-robin across publish/search/mailbox, plus four separate content operations and one exact retry.

Outcomes:

- Submitted: 1,002
- Good: 455 (45.41%)
- Uncertain/timeouts: 538
- Refused: 0
- Retries: 1
- Deadline-exceeded: 9
- Overall p95: 9,315.823 ms against 6,000 ms
- Overall p99: 9,915.522 ms against 10,000 ms
- All 334 searches timed out
- Publish p95: 9,354.585 ms
- Mailbox p95: 4,831.385 ms against the 3,000 ms protected-decision budget

The result is not independently qualified: only one of the required three independent executions exists.

## Resource findings

Full-state persistence and lookup scaling are real defects:

- Leased-index/matching/Hamming stores serialized complete publication/index state on every accepted refresh, producing approximately 15.1 GB written per relay and 448–456 renames.
- Live search scanned the Hamming index, reconstructed active records and repeatedly resolved generation/history for each match. All 334 searches timed out.
- Direct RPC used fresh TCP per operation, adding real handshake/teardown cost without explaining uniform search failure.
- Per-relay peak RSS reached 629–683 MB, above the unchanged 512 MiB relay target. Aggregate peak RSS reached 2.899 GB, above the 2 GiB startup allowance; final aggregate was 2.490 GB, above the 1.5 GiB sustained allowance.
- The host had only 309,985,280 B free at start, making memory pressure credible.
- Disk sampled peak was 497,073,833 B; final was 335,566,327 B.
- Network traffic was 167,691 B per good operation, below 1 MiB. Production rate limits did not cause the failure.

Search result validation also needs strengthening: the harness checked only array shape, not expected count, distinct publications or exact generation IDs. This does not cause the timeouts but must be fixed before any passing result is trusted.

## Thirty-minute idle result

The fixed 10,000-publication/replica idle run achieved 1,804.081 seconds with 361 five-second samples.

- CPU: 33.027618 seconds, or **1.8307% of one core**, above the 1% target.
- Mean aggregate RSS: 949,714,309 B, below the 1.5 GiB sustained application target.
- Peak aggregate RSS: 2,396,602,368 B, above the 2 GiB startup target.
- Peak per-relay RSS: 447,021,056–502,169,600 B, each below 512 MiB.
- Disk peak/final: 335,566,327 B.
- No physical power samples were collected; CPU time is not watts.

## Decision and next action

Stop further nominal runs until the implementation is corrected and independently reviewed. Replace full-publication/index serialization with bounded incremental persistence, remove repeated active-record/history reconstruction during search, strengthen exact search validation, and rerun focused correctness before considering another quantitative run. Fresh-TCP cost remains in the workload and must not be hidden.

Below-TCP packet impairment, physical power, independent deployment, K5/K6, FEAT-001 and full production/K/R qualification remain open. No smaller workload, changed deadline, higher quota or weaker gate may be used to reverse this failure.
