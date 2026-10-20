# Quiet-period budget calculations

Generated 2026-09-29T14:46:22.545Z; source base fcf31d1a2368123f4228768c577348550106a7df. Input: [192-search traces](private-reply-2026-09-29T14-30-17-612Z.json), SHA-256 `0ab2cb96e7509585b049c2993b7424275b839a26be8eb451f914215658134e5a`.

## Scope

This is an offline calculator, not a new network test or a privacy/energy measurement. All 192 captured small-search traces have a 15495-byte client request and a 11213-byte encrypted reply: 26708 bytes per client exchange. Larger payload buckets cost more.

## Hypothetical scheduled traffic

Assume a continuously connected client sends one exchange every interval, replacing empty slots with real work when available. Decimal MB count upload plus download of application frames only. TCP, TLS, WebSocket framing, discovery, retransmissions, other relay links, and server CPU costs are excluded. Slot counts are not measurements of radio wakeups or energy. The waiting model assumes one operation fits in a slot, uniform arrival within an interval, no backlog, and no extra burst slots; network and mixing time are additional. These are examples, not chosen rates.

| Interval (s) | Exchanges / connected hour | MB / hour | MB / 8 h | MB / 24 h | Mean / p95 slot wait (s) |
|---:|---:|---:|---:|---:|---:|
| 1 | 3600 | 96.149 | 769.19 | 2307.571 | 0.5 / 0.95 |
| 10 | 360 | 9.615 | 76.919 | 230.757 | 5 / 9.5 |
| 60 | 60 | 1.602 | 12.82 | 38.46 | 30 / 57 |
| 300 | 12 | 0.32 | 2.564 | 7.692 | 150 / 285 |

Formula: client payload MB = (request bytes + reply bytes) × connected seconds / interval seconds / 1,000,000. Mean scheduled wait = interval / 2; p95 = 0.95 × interval. A delay longer than the current 30-second private-envelope lifetime would have to occur locally before creating the envelope; pending signed operations may have their own expiry.

## Does waiting find another request?

For illustrative Poisson arrivals at rate λ from other compatible real work, P(at least one other arrival within W) = 1 − exp(−λW). Compatibility includes the relevant route, size, and observation window; whole-network packet counts overstate it. These rates are hypothetical, not inferred from the eight-client experiment. An arrival is not proof of a different person or honest participant, and these probabilities are not anonymity scores. Correlated arrivals, partitions, or adversarial traffic can invalidate the model.

| Wait (s) | Other work: 1/min | Other work: 1/10 min | Other work: 1/hour |
|---:|---:|---:|---:|
| 0.75 | 1.24% | 0.12% | 0.02% |
| 2 | 3.28% | 0.33% | 0.06% |
| 5 | 8.00% | 0.83% | 0.14% |
| 30 | 39.35% | 4.88% | 0.83% |
| 60 | 63.21% | 9.52% | 1.65% |
| 300 | 99.33% | 39.35% | 8.00% |
| 900 | 100.00% | 77.69% | 22.12% |

When no other compatible work arrives, additional waiting supplies no other request to mix with. Even a 15-minute wait has only a 22.12% opportunity under the illustrative one-per-hour assumption. A timer or relay-reported queue size therefore cannot certify safe release.

## Reproduce

```sh
npm run eval:quiet-budgets
```

[Machine-readable calculations](quiet-period-budgets-2026-09-29.json). The production client and relay settings are unchanged.
