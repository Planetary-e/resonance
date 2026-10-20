# Prepared admission: application measurement

**Failed concurrency gate: three of six paired searches passed.** All eight
other checkpoints pass. The process exits 1 with `completed:false`,
`scenarioCompleted:true` and `ConcurrentSearchFailure`. This measures the
reviewed preparation implementation on top of `c0de0d6`; it does not establish
that preparation resolves the application latency requirement.

| Measurement | Result |
| --- | --- |
| Three publications | 5.896 / 5.869 / 6.014 s |
| Serial search | 5.839 s |
| Nonempty mailbox release | 8.403 / 8.226 s |
| Empty mailbox recheck | 6.007 / 5.788 s |
| Successful paired searches | 5.761 / 5.882 / 6.025 s |
| Refused paired searches | 6.970 / 6.991 / 7.346 s |
| Concurrent accepted spends / consumed tokens | 3 / 6 |
| Concurrent TCP bytes / WebSocket bytes / connections | 5,113,879 / 3,594,715 / 282 |
| Full-run TCP bytes / WebSocket bytes / connections | 16,211,101 / 11,210,129 / 930 |
| Duration / aggregate process CPU | 163.513 s / 36.689347 s |
| Peak application RSS | 1,019,445,248 / 1,134,280,704 bytes |
| Peak fixture-worker RSS | 397,049,856 bytes |

Each nonempty mailbox release uses one fetch token and no ACK token. Match
notices remain deduplicated after lock/unlock. All six protected owners reopen;
exact retry succeeds and a conflicting spend remains refused. Witness quorum
loss retains the uncertain token without refund; observer quorum loss refuses
before another token reservation. Captured fields contain no root account
identifier, plaintext item text or spent token; this is field separation, not
proof against timing or content correlation.

Fresh policy preparation passes focused concurrency, lifetime and conflict
checks, but actual paired admission still reaches the original decision deadline.
The next transport investigation concerns repeated observer TLS/WebSocket setup.
Connection reuse must preserve fresh queries, owner lifetimes, resource bounds,
cancellation and room for the coordinator's own witness before adoption.

## Reproduction and limits

```sh
npm run eval:v04-real-app -- --protected-admission --concurrent-searches --tls --history-links --peer-delay-ms 25 --out /tmp/resonance-prepared-admission-delay25-2026-10-18.json
```

Node 24.19.0, macOS arm64, two actual application processes, cached FP32 model,
TLS and 55 durable histories across ten volunteer endpoints. No local test or
build ran during this measurement. The calibrated `bounded-byte-fifo-v2` fixture
adds 25 ms one-way stream delay; packet loss, congestion, bandwidth limits,
TCP setup latency, independent operators and device energy remain unmeasured.
TCP totals include TLS/WebSocket records and handshakes, excluding TCP/IP
headers, acknowledgements, retransmissions and final cleanup.

Frame capture is complete. The bounded stage ring dropped 1,206 older records;
it is not a complete per-operation trace. One run does not establish repeatability
or supported-device resource bounds.

Raw evidence: [v04-prepared-admission-delay25-2026-10-18.json](v04-prepared-admission-delay25-2026-10-18.json),
SHA-256 `61a31e86ec5a79ab44c44c929bd1b811fa86c11deac3be9a72bcc12b4ff7ba0d`.
