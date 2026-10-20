# Separate-process collection-window-mixing experiment

Run: 2026-10-18T04:26:40.628Z; Node v24.19.0; darwin/arm64. Source base: d975c31a7017fb038ea7bca840e248e117540295. Experiment and queue changes are in the same commit as this report.

## Method and limits

8 logical clients each send one equal-size search per trial. The clients share the parent process; baseline entry, treatment entry, and destination each run in their own child process. Both conditions use the default client scheduler. Both entries independently mix requests and replies. Baseline collection windows are 750 ms; candidate windows are 500 ms. Mode order alternates across 3 trials per workload/network profile. Burst actions are scheduled 20 ms apart; sparse actions 1,000 ms apart.

The simulated network profile delays each outgoing application frame by 20–60 ms, using seeded per-process pseudo-random streams. The zero-delay profile is ordinary loopback. This models frame latency and reordering between independent short connections, not TCP packet loss, bandwidth, geographic paths, or TLS record sizes. Relays share a physical machine and host clock; traces use epoch timestamps with a 2 ms cross-process clock tolerance. Per-IP discovery/search limits are raised to 10,000/minute because virtual clients share an address.

The observer pairs timestamps by rank, without IDs, payloads, or sizes. Ground truth is kept only by the scorer. Forward accuracy compares entry ingress to destination ingress; reply accuracy compares destination reply send to client receipt. Transit latency includes queueing, cryptography, signing, and the simulated link. Full completion latency includes discovery. All requests must finish and have complete traces; failed trials stop the run. Crypto randomness is enabled, so exact measurements vary.

Random-pairing reference for 8 requests per trial: 12.5%; actual collection windows may contain fewer requests. Every request here uses one destination and one size bucket; batches split across destinations or sizes are not measured. Scores are a limited diagnostic, not independent statistical samples or an Internet anonymity guarantee. A stronger observer can use sizes, destinations, discovery, and repeated traffic. Colluding relays can still link the forwarded ciphertext and request ID.

## Results

| Network | Workload | Entry | Forward matches | Reply matches | Transit p50 / p95 ms | Return p50 / p95 ms | Completion p95 ms |
|---|---|---|---:|---:|---:|---:|---:|
| loopback | burst-20ms | request-and-reply-mix-750ms | 0/24 (0.0%) | 1/24 (4.2%) | 726.5 / 817.6 | 757 / 765.6 | 2063 |
| loopback | burst-20ms | request-and-reply-mix-500ms | 3/24 (12.5%) | 3/24 (12.5%) | 393.3 / 549.1 | 506.8 / 512.6 | 1525.9 |
| loopback | sparse-1000ms | request-and-reply-mix-750ms | 24/24 (100.0%) | 24/24 (100.0%) | 766 / 767.3 | 754.9 / 755.6 | 2069.3 |
| loopback | sparse-1000ms | request-and-reply-mix-500ms | 24/24 (100.0%) | 24/24 (100.0%) | 516.3 / 518 | 504.4 / 505.7 | 1579.1 |
| frame-delay-20-60ms | burst-20ms | request-and-reply-mix-750ms | 2/24 (8.3%) | 1/24 (4.2%) | 705.6 / 836.5 | 779.1 / 833.2 | 2293.3 |
| frame-delay-20-60ms | burst-20ms | request-and-reply-mix-500ms | 3/24 (12.5%) | 0/24 (0.0%) | 484.2 / 592.9 | 555.8 / 577.2 | 1914.7 |
| frame-delay-20-60ms | sparse-1000ms | request-and-reply-mix-750ms | 24/24 (100.0%) | 24/24 (100.0%) | 806.8 / 832.8 | 844.3 / 866.7 | 2504.1 |
| frame-delay-20-60ms | sparse-1000ms | request-and-reply-mix-500ms | 24/24 (100.0%) | 24/24 (100.0%) | 558.9 / 581.2 | 582.3 / 604.4 | 2008.6 |

## Interpretation

Compare baseline and treatment under the same workload and network profile. Mixing may reorder a busy batch; it does not create other users in a quiet window. This changes both collection windows; it does not isolate request versus reply effects. Admission policy/witness fan-out and the real application are evaluated separately. This experiment provides no cover traffic and no defense against colluding relay operators. Do not treat a low score for one attack as proof of anonymity.

## Reproduce

```sh
npm run eval:private-mix -- --clients 8 --trials 3 --window-comparison --candidate-window 500
```

[Machine-readable traces](private-windows-500-2026-10-18.json). No production records, encrypted payloads, or private keys are retained.
