# Actual application with persistent history links

Status: **the zero-delay scenario passes; the calibrated 25 ms scenario still
fails mailbox delivery at the existing ten-second limit**. This is local
application evidence, not Internet or release certification.

## Topology and guarantees

Two desktop backend processes use the cached FP32 embedding model, private
two-hop requests, blind credentials, five witnesses and five policy observers.
Five policy volunteers each retain five histories; five admission volunteers
each retain six histories. There are still 55 durable histories, now served
through 55 authenticated persistent owner links and 22 exposed TLS endpoints.
Each collection remains below its eight-history limit. Every RPC still checks
its own signed request and response. There is no direct history fallback.

Small history payloads use `relay_history_v2` inline framing, removing two
header-acknowledgement round trips per exchange. Larger payloads retain bounded
chunking. Four member RPCs may be active in each fresh head collection; a settled
task makes room for the fifth candidate when needed. Two independent policy
observations fit the existing eight-operation router. Challenges, four distinct
current receipts, update exclusion, cancellation and deadlines remain enforced.
An external transport that ignores cancellation can still cause capacity refusal.
Both ends of an infrastructure link must use v2; stored histories are unchanged.

All volunteer and owner services share one evaluation process on this computer.
Policy and witness RPCs still open fresh TLS connections. Six role restarts reopen
their stores with the same live transport pins; these are not volunteer process
restarts or a measurement of separate operators, NAT, power or Internet failures.
Quorum-loss faults close selected enrolled services, preserving other histories.

## Corrected latency calibration

The earlier two-transform delay fixture incorrectly added waits to later
fragments. A 56-byte burst of eight chunks delivered only two after its intended
40 ms delay. Its small sequential WSS echo calibration missed that defect.
Earlier failed reports are preserved, but cannot establish behavior under a
uniform 25 ms delay.

The corrected FIFO timestamps each admitted chunk and shares a 1 MiB byte window
with its readable output. Writable has a separate 64 KiB margin and one held
chunk; chunks over 1 MiB are refused. Backpressure beyond the finite window can
still limit throughput. Order, consumer stalls, pending callbacks and timer
cancellation are tested. No production transport budget changed.

The expanded real WSS calibration adds 25 ms per direction and passes the same
49–65 ms additional median round-trip screen in all three scenarios (ten samples
per condition):

| Scenario | Added median round trip |
| --- | ---: |
| Sequential 200/5,000-byte echoes | 52.43 ms |
| Eight 256-byte frames in a burst | 53.54 ms |
| One 256 KiB frame | 56.58 ms |

Raw evidence: [calibration](v04-peer-delay-v2-calibration-2026-10-18.json).
This delays already accepted byte streams, including TLS records. It does not
simulate TCP setup, packet loss, congestion, sustained bandwidth or independent
networks. Test CA trust is isolated to child processes; no OS trust store changes.

## Application results

| Measurement | Zero-delay control | 25 ms one-way delay |
| --- | ---: | ---: |
| Completed checkpoints | 9/9 | 3/9 |
| Paired searches | 6/6 | Not reached |
| Publication API times | 4,131 / 4,185 / 3,866 ms | 6,206 / 6,039 / 6,176 ms |
| First search | 3,597 ms | 5,986 ms |
| Mailbox releases | 7,326 / 3,708 / 7,379 / 3,636 ms | First release fails at 10,036 ms |
| TCP stream bytes | 20,192,028 | 7,625,581 through failure |
| Connections | 1,009 | 367 through failure |

Raw evidence: [control](v04-history-links-control-2026-10-18.json) and
[delayed failure](v04-history-links-delay25-2026-10-18.json).
Do not compare partial failed-run totals with complete-run totals as efficiency.

The complete control verifies decrypted match notices, restart-safe notification
deduplication, six protected owner reopens, retained double-spend refusal and both
witness and observer history quorum loss. Paired searches take 3,633–4,848 ms.
Its 20.19 MB and 1,009 connections compare with 33.86 MB and 4,783 connections in
the earlier complete fresh-connection control: 40.4% fewer stream bytes and 78.9%
fewer connections in these individual local runs. The comparison includes the
consolidated volunteer topology and is not a statistical performance claim.

The corrected delayed run still fails the combined mailbox fetch and durable
acknowledgement. Each is a separate admitted operation with a separate policy
query. The shared saved-request delivery limit is unchanged. The HTTP failure
does not establish loss of accepted records; the remaining scenario did not run.

The complete control takes 155.058 seconds, including rate-limit cooldowns, uses
35.973407 CPU seconds across worker and apps, and records app peak RSS of
1,054,507,008 / 1,047,789,568 bytes. Worker peak RSS is 387,874,816 bytes. The TLS
launcher is excluded. Stream counters include TLS handshakes/records and
WebSocket framing, excluding TCP/IP headers, ACKs/retransmits, local API HTTP and
final cleanup. The phase window retains 2,048 records and reports 2,491 dropped
older events; aggregate transport counters remain complete.

## Verification

- Inline framing/router/bridge/operator group: 65 tests in four files pass.
- Current-head and policy observation group: 58 tests in three files pass,
  including two fresh quorums through a real eight-slot router with a hung member.
- TLS paths: four tests pass, including the 120-case certificate matrix.
- Network fixture: nine tests pass; the original burst defect was reproduced.
- Outbound observer CLI: all four cases pass locally. The maintenance regression
  now delays two replicas by 3,500 ms, forcing quorum to wait beyond three seconds.
  Its bounded diagnostics include member index, method, action and duration only.
- Project and standalone script TypeScript checks pass.

CI at `3992b28` passed 2,662 Linux tests in 306 files and all 44 quick metrics,
plus five of six platform jobs. Windows ownership failed a cold observer advance.
The generic error does not distinguish synchronous storage stalls from transport
delay. The current changes require another CI run; local success is not a Windows
fix certification. No installers, merge or release were produced.

Reproduce from the repository root:

```sh
npm run eval:v04-real-app -- --protected-admission --concurrent-searches --tls --history-links --out /absolute/path/control.json
npm run eval:v04-real-app -- --protected-admission --concurrent-searches --tls --history-links --peer-delay-ms 25 --out /absolute/path/delayed.json
node --import tsx scripts/eval-peer-delay.ts --out /absolute/path/calibration.json
```
