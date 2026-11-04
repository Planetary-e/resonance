# Actual protected application over TLS — October 18, 2026

Two real Node application processes use the cached Nomic FP32 model, five policy observers, five admission witnesses, one coordinator and 55 retained histories. All nine application checks pass, including six paired searches (3,794–4,968 ms), encrypted mailbox delivery/deduplication, six-owner reopening, double-spend rejection and witness/observer quorum loss. No production deadline or rate limit was increased.

## Reproduction

```sh
npm run eval:v04-real-app -- --tls --protected-admission --concurrent-searches --out /tmp/resonance-protected-tls.json
```

The evaluator restarts itself with `NODE_EXTRA_CA_CERTS` pointing only its isolated process tree at the repository test CA. It never installs that CA or disables certificate verification. Entry and destination use direct WSS plus encrypted identity keystores; auxiliary services use TLS proxies with loopback-only cleartext backends. Public fixture credentials must never be deployed.

## Transport measurement

| Endpoint class | Endpoints | Connections | TCP stream bytes, both directions |
| --- | ---: | ---: | ---: |
| entry | 1 | 107 | 1,641,449 |
| destination | 1 | 71 | 1,233,031 |
| witness | 5 | 85 | 518,953 |
| policy-observer | 5 | 635 | 3,753,225 |
| policy-history | 25 | 3,225 | 21,068,937 |
| admission-history | 30 | 1,440 | 10,741,722 |

Total: **38,957,317 bytes and 5,563 connections**, compared with 11,038,271 WebSocket application-payload bytes. Whole-scenario CPU time is 33.687 seconds; elapsed time is 152.001 seconds including ordinary rate-window cooldowns. Application peak RSS is 1,028.4/1,032.0 MiB.

Counters sit before TLS termination and sum each endpoint’s incoming/outgoing TCP stream once. They include TLS handshakes/records and WebSocket upgrades/framing. They exclude TCP/IP headers, ACKs, retransmissions, local HTTP UI APIs, in-process work and final shutdown. Setup, issuer freshness, recovery, deliberate failed operations and discovery are included, so this is not a per-search byte estimate. The later evaluator also records concurrent-search transport deltas; this first report predates that field.

The small payload-only estimate substantially understates cost. Policy-history endpoints account for 21,068,937 bytes; fresh retained-state checks require many short connections. This finding does not justify caching authorization observations or extending their validity. Connection reuse or authenticated reverse-link composition must preserve independent per-request freshness and cancellation before any optimization is accepted.

Two real-socket fixture tests check exact bidirectional counts across reconnects and untrusted-CA refusal before opening a backend. The existing transport matrix separately covers invalid names/dates and certificate replacement.

## Scope

This is real local TLS and application code on one Apple Silicon computer, not independent operators, public-CA deployment, Internet latency, bandwidth saturation or device energy. Individual RSS maxima are not simultaneous total memory. No graphical UX, installer or release is certified. Account-field separation does not prevent timing correlation or content linking.

Raw evidence: [v04-protected-app-tls-2026-10-18.json](v04-protected-app-tls-2026-10-18.json).
