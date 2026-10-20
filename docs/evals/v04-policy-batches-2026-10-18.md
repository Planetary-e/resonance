# Bounded policy batches: application measurement

## Result

**Failed concurrency gate: three of six paired searches succeeded.** All eight
other application checkpoints passed. The process exited 1; the report records
`completed:false`, `scenarioCompleted:true`, and `ConcurrentSearchFailure`.
No timeout, quorum or transport limit was increased.

The bounded observation batches reduced repeated history reads and traffic,
but did not resolve the protected decision's three-second budget including queue
waiting. This is a useful traffic reduction, not evidence of application readiness.

| Measurement | Result |
| --- | --- |
| Three publications | 6.121 / 6.017 / 6.148 s |
| Serial search | 5.932 s |
| Nonempty mailbox release | 8.439 / 8.389 s |
| Empty mailbox recheck | 6.092 / 5.657 s |
| Paired searches, successful | 5.804 / 5.852 / 5.910 s |
| Paired searches, refused | 7.120 / 7.127 / 7.269 s |
| Concurrent accepted spends / consumed tokens | 3 / 6 |
| Complete run TCP stream bytes / connections | 16,155,502 / 925 |
| Complete run WebSocket payload bytes | 11,182,598 |
| Duration / aggregate process CPU | 163.777 s / 37.518263 s |
| Peak application RSS | 1,091,059,712 / 1,119,895,552 bytes |
| Peak fixture-worker RSS | 402,227,200 bytes |

Each nonempty mailbox release consumes one fetch token and zero ACK tokens.
Rechecks do not duplicate notices. All six admission owners reopen, exact retry
and conflicting-spend checks pass, witness quorum loss retains an uncertain token,
and observer quorum loss refuses before another token reservation. Account and
credential field separation checks pass; these are not timing/content privacy.

## Comparison and remaining critical path

Compared with the preceding
[mailbox-maintenance run](v04-mailbox-ack-maintenance-2026-10-18.md), the three
concurrent rounds use 3,542,530 rather than 4,427,091 WebSocket payload bytes
(20.0% fewer) and 5,057,630 rather than 5,979,215 TCP stream bytes (15.4% fewer).
Both use 282 connections; CPU is effectively unchanged at 6.45 seconds.

In the fully retained first-two-trial stage windows, history head RPC count
falls from 700 to 500. Successful head median falls from 180.5 to 83 ms;
witness-policy median falls from 608 to 552 ms. Coordinator-policy median is
unchanged at approximately 277 ms. These are diagnostic samples from one run
per implementation, not a distribution across independent devices.

The first batched trial shows the remaining serialization. Relative to the first
coordinator policy query, its first decision finishes at about 1,709 ms. The
second decision obtains its fourth witness reply at 3,082 ms, then persists its
certificate at 3,240 ms. It never appends the second local spend. The logs report
the decision timeout. Queue-enqueue events are not recorded, so the exact second
enqueue offset cannot be reconstructed. Persisted work after a caller timeout
remains uncertain; it is not reported as an accepted spend or refunded token.

The next change under review is an atomic protected certificate-and-spend delta,
using the same four-copy durable commit. It must preserve both histories,
pending retry, crash recovery, self-witness ordering and capacity checks.

## Reproduction and limits

```sh
npm run eval:v04-real-app -- --protected-admission --concurrent-searches --tls --history-links --peer-delay-ms 25 --out /tmp/resonance-policy-batches-delay25-2026-10-18.json
```

The experiment ran without other local test/build workloads, using Node 24.19.0
on macOS arm64, two actual app processes and the cached FP32 model. It uses
authenticated persistent links, 55 histories on ten volunteer endpoints, and
the calibrated `bounded-byte-fifo-v2` stream-delay fixture with TLS on exposed
peer endpoints. This single-computer simulation does not establish Internet
reachability, independent operators, packet loss/congestion or device energy.
TCP counts include TLS/WebSocket records and handshakes but exclude TCP/IP
headers, acknowledgements, retransmissions and final cleanup.

Wire capture is complete. The diagnostic stage ring discarded 1,206 older rows;
it is not a complete phase trace. The comparison above uses retained windows in
both runs, not whole-run stage totals or third-round cleanup overlap.

Raw evidence: [v04-policy-batches-delay25-2026-10-18.json](v04-policy-batches-delay25-2026-10-18.json),
SHA-256 `c047c7317b86f821e315b6f6070cc741d9adacc8dc32f8cd389f258e8a2869e8`.
