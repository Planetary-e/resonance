# Atomic authorization: application measurement

**Result: failed concurrency gate, three of six paired searches passed.** The
eight other checkpoints completed. Exit status is 1; the report correctly states
`completed:false`, `scenarioCompleted:true`, and `ConcurrentSearchFailure`.
This run measures commit `c0de0d6`, using the new atomic protected certificate/spend
path and the existing bounded policy batches.

| Measurement | Result |
| --- | --- |
| Three publications | 5.822 / 5.916 / 6.004 s |
| Serial search | 5.812 s |
| Nonempty mailbox release | 7.900 / 8.416 s |
| Empty mailbox recheck | 5.924 / 5.743 s |
| Successful paired searches | 5.864 / 5.988 / 5.803 s |
| Refused paired searches | 7.263 / 7.482 / 7.275 s |
| Concurrent accepted spends / consumed tokens | 3 / 6 |
| Concurrent TCP bytes / WebSocket bytes / connections | 5,035,333 / 3,516,546 / 282 |
| Full-run TCP bytes / WebSocket bytes / connections | 16,063,989 / 11,094,628 / 925 |
| Duration / aggregate process CPU | 163.306 s / 36.857064 s |
| Peak application RSS | 1,057,472,512 / 1,100,709,888 bytes |
| Peak fixture-worker RSS | 385,056,768 bytes |

Both nonempty mailbox releases consume one fetch token, no ACK token, and remove
one/two envelopes respectively. Lock/unlock and empty rechecks do not duplicate
notices. Six-owner restart, exact replay, conflicting-spend refusal, witness
quorum loss with uncertain-token retention, and observer quorum loss before a new
token reservation pass. Field-separation checks pass, which is not a content or
timing unlinkability claim.

The remaining decision deadline includes time waiting for the preceding
transaction. The next implementation prepares a fresh per-caller read before its
serialized writer turn, preserving original deadlines and all durable writes
inside that turn; it must separately validate its resource and self-witness bounds.

## Reproduction and limitations

```sh
npm run eval:v04-real-app -- --protected-admission --concurrent-searches --tls --history-links --peer-delay-ms 25 --out /tmp/resonance-authorized-spend-delay25-2026-10-18.json
```

The run used Node 24.19.0 on macOS arm64, two actual application processes, the
cached FP32 model, TLS and 55 durable histories across ten volunteer endpoints.
No other local test or build ran concurrently. The calibrated
`bounded-byte-fifo-v2` fixture adds 25 ms one-way stream delay. This is one
computer, not independent Internet volunteers; packet loss, congestion,
TCP setup latency, bandwidth limits and device energy are not measured.
TCP counts include TLS/WebSocket records and handshakes, excluding TCP/IP
headers, acknowledgements, retransmissions and final cleanup.

Wire capture is complete; the bounded diagnostic ring dropped 1,176 older
stage records, so it is not a complete phase trace. A single run does not establish
repeatability or supported-device resource limits.

Raw evidence: [v04-authorized-spend-delay25-2026-10-18.json](v04-authorized-spend-delay25-2026-10-18.json),
SHA-256 `59121cc5301f95344567e66127762f3a76ae42b84ea979bb56bae9abf1d448e1`.
