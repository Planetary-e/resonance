# Observer connection reuse: application measurement

**Failed concurrency gate: five of six paired searches passed.** All eight other
checkpoints pass. The process exits 1 with `completed:false`,
`scenarioCompleted:true` and `ConcurrentSearchFailure`. This is the reviewed
connection-pool change on top of `fd64455`; it is not a passing latency result.

| Measurement | Result |
| --- | --- |
| Three publications | 5.869 / 5.409 / 5.953 s |
| Serial search | 5.374 s |
| Nonempty mailbox release | 7.899 / 7.955 s |
| Empty mailbox recheck | 5.872 / 5.690 s |
| Paired round one | HTTP 200 in 5.844 / 6.985 s |
| Paired round two | HTTP 200 in 5.895 s; HTTP 503 in 7.066 s |
| Paired round three | HTTP 200 in 5.768 / 6.952 s |
| Concurrent accepted spends / consumed tokens | 5 / 6 |
| Concurrent TCP bytes / WebSocket bytes / connections | 4,741,389 / 3,585,969 / 210 |
| Full-run TCP bytes / WebSocket bytes / connections | 15,395,952 / 11,146,578 / 782 |
| Duration / aggregate process CPU | 163.488 s / 36.613077 s |
| Peak application RSS | 1,083,539,456 / 1,065,943,040 bytes |
| Peak fixture-worker RSS | 466,632,704 bytes |

The same account's publications retain separate keys and identifiers. Both apps
receive match notices without duplication after lock/unlock. All six protected
owners reopen, exact retry succeeds and conflicting reuse remains refused.
Witness quorum loss retains the uncertain token; observer quorum loss refuses
before another reservation. Captured fields omit root account identifiers,
plaintext item text and spent tokens; this is field separation, not resistance
to timing or content correlation.

Compared with [fresh preparation](v04-prepared-admission-2026-10-18.md), concurrent
connections fall 25.5% and TCP bytes fall 7.3%. No deadline, quorum or raw listener
cap was increased. The second durable append's fourth reply arrives about
3,026 ms after the first coordinator policy request in the failed pair, versus
2,950 and 2,897 ms in successful pairs. These are retained trace intervals,
not exact queue-admission times. Whole API timings include embedding and routing
and are not the protected decision's three-second budget.

The failed call does not prove that its spend was absent from durable history:
the accepted-spend counter records acknowledged acceptance. An uncertain token
must remain consumed. The next bounded investigation concerns repeated history
collection waves among already-queued readers; it has no measured result yet.

## Reproduction and limits

```sh
npm run eval:v04-real-app -- --protected-admission --concurrent-searches --tls --history-links --peer-delay-ms 25 --out /tmp/resonance-policy-reuse-delay25-2026-10-18.json
```

Node 24.19.0, macOS arm64, two actual application processes and the cached FP32
model. All peer paths use TLS, with 55 durable histories across ten volunteer
endpoints. No local test or build ran during the measurement. The calibrated
`bounded-byte-fifo-v2` fixture adds 25 ms one-way stream delay; it does not model
packet loss, congestion, bandwidth limits or TCP setup latency. Independent
operators, public Internet behavior and device energy remain unmeasured.

TCP totals include TLS/WebSocket records and handshakes, excluding TCP/IP headers,
acknowledgements, retransmissions and final cleanup. Frame capture is complete;
the bounded stage ring retains 2,048 events and dropped 1,176 older events, with
zero active stages at completion. Pair windows remain available, but missing
member identifiers and queue-intake spans prevent exact causal attribution.
One run does not establish repeatability or supported-device resource bounds.

Raw evidence: [v04-policy-reuse-delay25-2026-10-18.json](v04-policy-reuse-delay25-2026-10-18.json),
SHA-256 `16b87f0835c9786f4bcf4dc670c76b0732eaf05f5f632cb3513287607636f9af`.
