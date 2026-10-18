# Protected application under simulated stream delay

Status: **mailbox workflow fails the existing ten-second delivery limit**.

The real two-process application uses cached FP32 Nomic embeddings, private
two-relay routes, blind credentials, five witnesses, five policy observers and
55 durable history services. All exposed peer endpoints use verified test TLS.
No production freshness, decision or delivery deadline was increased.

## Measurement

The fixture adds 25 ms in each direction to accepted byte-stream chunks. Ordered
transforms preserve backpressure; already waiting chunks do not each incur a
fresh full delay. TCP_NODELAY avoids measuring the proxy's Nagle buffering as
the intended delay. A real WSS echo calibration measures **55.190792 ms** added
median round-trip time, within the declared 49–65 ms screen. It covers ten
sequential alternating 200/5,000-byte echoes per condition.

This does not model TCP setup delay, packet loss, retransmission, congestion,
bandwidth or independently operated computers. TLS trust is isolated to child
processes using the repository's public test CA. No system trust store changes.

## Changes and unchanged guarantees

- A protected writer first attempts an authenticated append to a current
  replica. An unsuccessful attempt performs bounded head/ancestry repair and
  obtains a new append receipt. A head read is never write evidence. Explicit
  prefix-reclamation maintenance retains its existing order.
- Two policy observations can run together with different challenges and their
  own four current history receipts. Capacity stays at eight total exchanges.
  A queued policy advance is an exclusive FIFO barrier, and waiting consumes
  the original signed and monotonic deadline. Recovery/close fences active work.
- The private policy query and its admitted request share discovery within that
  one operation. New operations perform discovery again. Signed descriptor and
  transport-key expiry are rechecked before credential reservation and sending.
  No permission or freshness result is reused across requests.

## Result

The updated zero-delay control, `v04-protected-app-latency-control-2026-10-18.json`,
passes all nine checkpoints and 6/6 paired searches. It counts 4,783 connections
and 33,857,228 stream bytes. Mailbox releases take at most 7,721 ms. This is one
control run, not a statistical latency comparison. Its phase window retains
the newest 2,048 records and reports 2,491 discarded older records; aggregate
transport counters are complete.

`v04-protected-app-delay25-2026-10-18.json` records three completed checkpoints:
initialization/issuance, three publications, and search. Publication API times
are 6,911, 6,922 and 7,030 ms; search takes 6,866 ms. The first mailbox release
returns HTTP 503 after 10,026 ms. Fetch and durable acknowledgement remain
separate admitted operations; this failure does not establish loss of accepted
records. The full scenario is incomplete.

The run counts 1,646 connections and 11,893,454 TCP stream bytes through failure,
including TLS records and setup. It excludes IP/TCP packet headers, ACKs,
retransmissions, local UI HTTP and final cleanup. Phase timings contain numeric
durations and bounded event names, no request text or credentials. This run
retains all 1,545 phase events. Future longer runs explicitly report truncation
of the 2,048-event window. Launcher process CPU/RSS is not included in application
or evaluation-worker resource measurements.

The next experiment uses existing authenticated infrastructure history links
to avoid repeatedly opening TLS connections. It must retain per-request signed
challenges, capacity, cancellation, durable receipts and failure semantics.

## Validation

- History append/repair: 65 tests in five files, including lost reply, fork,
  newer head, freeze, rejoin and explicit prefix reclamation.
- Policy concurrency and network fixture: 63 tests in five files, including
  independent challenges, advance barriers, expiry, cancellation and delay.
- Private route reuse and caller deadlines: 20 tests in four files, including
  route expiry before credential reservation and fresh discovery next time.
- TypeScript project and standalone fixture checks passed.
- CI's IPv4/IPv6 same-port binary-frame injection failure was reproduced and
  corrected by matching both local address and port. All ten client integration
  cases pass locally. This does not change the failed historical CI result.

Reproduce with `npm run eval:v04-real-app -- --tls --protected-admission
--peer-delay-ms 25 --out /absolute/path/report.json` from the repository root.
Calibration: `npx tsx scripts/eval-peer-delay.ts --out /absolute/path/calibration.json`.
