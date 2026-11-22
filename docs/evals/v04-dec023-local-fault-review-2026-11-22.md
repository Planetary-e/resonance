# DEC-023 local process-death and network-fault review — November 22, 2026

## Verdict

**ACCEPT LOCAL FAULT EVIDENCE.** Actual forked-process SIGKILL and ordered loopback TCP fault evidence is substantive and reviewed. This is not production, packet-impairment, physical-resource, independent-deployment or K/R acceptance.

Authorization is `delivery/decisions/DEC-023.md`. Sanitized evidence is `delivery/results/client-held-local-fault-qualification.json`.

## Process-death coverage

Forked relay/local-store processes use authenticated, digest-bound parent IPC crash controls confined to test fixtures. Actual SIGKILL is verified on the child processes. No test control enters production routing.

Nine tests exercise publication, refresh, withdrawal and repair; mailbox deposit and sync; recipient inbox/ACK and relay ACK reply loss; one/two queued-copy loss and authenticated repair; and online content request/poll/response/receipt. Reopen and exact retry preserve operations without another allocation/spend/inbox/notification, uncertain-as-success or stale resurrection.

Most selected barriers kill after durable commit and before reply; this is meaningful evidence, not coverage of every possible mid-write crash.

## Evidence-count correction

The implementation narrative initially reported 14 exits. Independent review found 15 scheduled in the current suite. The parent run log `/tmp/client-held-process-network.log`, SHA-256 `f8af441810a2b0a16e525d52b236b64f1657923331b40eb2ad7c7816373c87b5`, records all 15:

```text
4 publication/refresh/withdrawal/repair
1 mailbox deposit
3 recipient/relay ACK
1 mailbox sync
2 queued-copy loss
4 online content
```

The sanitized receipt preserves each PID/barrier and explicitly marks the earlier 14-exit narrative incorrect. Independent follow-up accepted the reconciliation.

## Loopback network evidence

The ordered, backpressured TCP proxy injects 5 ms forwarding latency and connection resets, preserves byte-stream order and reports connections, resets, bytes and call timings. It explicitly provides no packet loss, reordering, duplication or below-TCP retransmission evidence.

Two tests pass:

- Lookup exact retry: 4 connections, 1 induced failure, 3 successful calls; cold 50.6335 ms, new-connection 44.13075 ms, interrupted 21.442542 ms, exact retry 27.24725 ms.
- Warm content poll reset: 5 connections, 1 induced failure, 4 successful calls; request 48.980209 ms, response 45.328292 ms; exact poll retry and original delivery succeeded.

These are local macOS loopback measurements, not the accepted packet-impaired profile.

## Validation and remaining gates

Focused process 9/9, network 2/2, final live 7/7 and composed affected 51/51 tests passed. Actual-source noEmit, build and diff checks passed. Independent source review found no new protocol-safety defect and accepted the local evidence after count reconciliation.

Still open: below-TCP 1% independent packet loss and delay variation; external network, full cold/warm operation matrices, physical power/RSS qualification, independent deployment/K8, K5/K6, FEAT-001 and production/K/R acceptance. No such acceptance is inferred.
