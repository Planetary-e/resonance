# Mailbox acknowledgement maintenance under calibrated delay — October 18, 2026

## Result

This is a point-in-time real-application measurement of owner-signed acknowledgement of already accepted mailbox messages as prepaid maintenance. The measured ACKs consumed no admission tokens: the two `mailboxMaintenance` records report one token consumed alongside each fetch and zero acknowledgement spends. The first maintenance removed one envelope; the second removed two. After lock/unlock and another mailbox check, the application reported no duplicate matches. The eight application checkpoints recorded in the raw result completed.

All four saved-request releases returned HTTP 200 within the unchanged ten-second deadline:

| Mailbox step | Release time | Admission accounting |
| --- | ---: | --- |
| First nonempty mailbox release (one envelope) | 8.320 s | 1 fetch token, 0 ACK tokens |
| Empty recheck | 5.947 s | 1 fetch token, 0 ACK tokens |
| Second nonempty mailbox release (two envelopes) | 8.375 s | 1 fetch token, 0 ACK tokens |
| Empty recheck after lock/unlock | 6.112 s | 1 fetch token, 0 ACK tokens |

The separate concurrent-search screen failed: only 3 of 6 submitted searches succeeded at concurrency 2. All six tokens were consumed, including the three failed attempts; the measurement exited with status 1. Therefore this is not an all-pass run, and the concurrency failure remains part of the result even though the eight application checkpoints completed.

The raw JSON retains the historical top-level `completed: true`. In that evaluator version, this means the run reached its end and emitted the report; it does not mean every gate passed. New evaluator output uses `completed` to mean all gates pass and reports `scenarioCompleted` separately, so those fields must not be conflated when comparing versions.

## Traffic and resources

The run used the bounded-byte-FIFO-v2 fixture with simulated 25 ms one-way delay on all exposed peer endpoints. It recorded 13,207,443 WebSocket payload bytes and 18,264,688 TCP stream bytes across 925 connections. TCP counts include TLS and WebSocket records and handshakes as described in the raw result; they exclude TCP/IP headers, acknowledgements, retransmissions, and final cleanup.

The 163.894-second run used 37.669 CPU seconds. Peak RSS was 1,077,788,672 bytes for Alice and 1,046,069,248 bytes for Bob. Process peaks are not simultaneous total memory; CPU time is not energy.

The wire capture is complete (`capture.complete: true`). The bounded timing-stage sample is not a complete phase trace: 1,981 timing stages were dropped. Do not treat the retained stage rows as a complete account of internal phases.

## Scope and limitations

The application processes, volunteers, and endpoints ran on one computer using loopback and an isolated test CA. The fixture used five admission-history volunteers, five policy observers, five witnesses, and one coordinator, for 55 persistent history services across ten volunteer endpoints. This does not establish independent operators, Internet reachability, or real volunteer overlap. The 25 ms fixture delays ordered byte streams; it does not model TCP setup, packet loss, retransmission, congestion, or a bandwidth cap. The evaluation does not measure device energy.

The preceding zero-delay and calibrated-delay retained-history measurements are documented in [History links over TLS](v04-history-links-2026-10-18.md). The exact raw result, including its historical `completed: true`, is preserved unchanged in [the raw JSON](v04-mailbox-ack-maintenance-delay25-2026-10-18.json).
