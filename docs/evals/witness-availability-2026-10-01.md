# Four-of-five witness availability and cost

Generated 2026-10-01T05:31:10.468Z; base commit `116b279c627ba8357b4638674e590c63715fca59`. The worktree includes this evaluation and the listener-port fix; exact source hashes and individual traces are in the [JSON report](witness-availability-2026-10-01.json).

## Scope and assumptions

The cost experiment runs five real relay processes, signed votes flushed to encrypted storage, and the production quorum gate on one computer. It measures only the witness-authorization phase: no token issuance, Blind RSA redemption, publication, client mixing, discovery, or private-route exchange is included. Synthetic random spend digests stand in for already-verified tokens. This is not an Internet pilot or an end-to-end app certification.

Host: Apple M3 Pro, darwin/arm64, Node v24.19.0. Each condition has 12 sequential attempts, except lost replies and their recovery (at most four); no warm-up samples are discarded. p95 is a small-sample descriptive percentile, not a service-level guarantee. Histories start empty and remain small; this does not measure near-capacity snapshot rewrites or sustained concurrent load.

Offline means the witness listener is stopped; its process remains available for instrumentation and retains vote state. Delayed replies inject seeded 80–160 ms application-frame delay after the durable vote, not a kernel network model. Two lost replies persist all five votes but suppress two replies until the production three-second timeout; the next condition retries those exact claims after recovery. Cached retries reopen the coordinator history before attempting the identical operations with all five listeners stopped.

Socket bytes count coordinator-side reads plus writes on successful WebSocket upgrades, once per link. They include HTTP upgrade and WebSocket framing on cleartext loopback; they exclude TCP/IP headers, failed connection attempts, retransmissions, TLS, and other application traffic. CPU milliseconds sum the coordinator and five relay processes, including instrumentation and incidental background work. They are not elapsed latency, energy, battery use, or radio wakeups.

## Measured quorum phase

| Condition | Accepted / attempts | Success p50 / p95 ms | Refusal p50 / p95 ms | Mean socket bytes | Mean CPU ms |
|---|---:|---:|---:|---:|---:|
| all-online | 12/12 | 50.61 / 86.89 | — / — | 6926.00 | 81.40 |
| one-offline | 12/12 | 46.30 / 50.75 | — / — | 6025.50 | 61.05 |
| two-offline | 0/12 | — / — | 1.90 / 2.34 | 0.00 | 2.96 |
| delayed-replies | 12/12 | 191.48 / 228.18 | — / — | 6913.50 | 95.08 |
| one-offline-delayed | 12/12 | 198.65 / 217.14 | — / — | 6013.00 | 62.94 |
| two-lost-replies | 0/4 | — / — | 3001.61 / 3004.01 | 6374.50 | 103.00 |
| same-claims-after-recovery | 4/4 | 37.60 / 58.37 | — / — | 6963.50 | 83.14 |
| cached-retry-all-offline | 12/12 | 10.07 / 11.09 | — / — | 0.00 | 12.63 |

Refusals remain in their own latency column and in the attempt denominator. A fast refusal does not mean useful availability. Cached acceptance applies only to a previously certified exact request, while the policy remains valid; it does not authorize new work.

## Synthetic volunteer availability

These are hypothetical schedules, not measured user behavior. The independent model has five separate on/off chains with six-hour mean online sessions and an offline mean chosen to give each stated online fraction. It samples exact Markov transitions every five minutes, warms up for seven days, then models 90 days with seed 20261001. Requests are uniformly sampled every five minutes; an extra hour prevents censoring retries at the end. Available witnesses are assumed to respond within the three-second gate deadline. Conflicts, malicious votes, storage failures, and policy expiry are excluded.

The 15/60-minute columns are explicit same-operation retry scenarios, not a new automatic retry feature. They model the gate alone and assume the claim and policy stay valid; application request expiry can prevent such long retries. Every attempt still needs four responses together: the coordinator does not retain partial certificates between attempts. Latency/loss costs above are separate from this uptime model. There is one seeded trace per scenario, with no confidence intervals or inference about the volunteer population.

| Hypothetical scenario | Immediate | Within 15 min | Within 60 min | Accepted 60-min-window wait p95 |
|---|---:|---:|---:|---:|
| independent-0.5 | 20.18% | 22.77% | 29.51% | 50.00 min |
| independent-0.75 | 63.95% | 69.45% | 80.54% | 45.00 min |
| independent-0.9 | 91.57% | 95.61% | 99.15% | 10.00 min |
| independent-0.95 | 97.32% | 99.29% | 99.99% | 0.00 min |
| one-unavailable-others-90-percent | 67.18% | 76.18% | 90.24% | 45.00 min |
| shared-eight-hour-schedule | 33.33% | 34.38% | 37.50% | 35.00 min |
| staggered-eight-hour-schedules | 0.00% | 0.00% | 0.00% | — min |

Analytically, five independent witnesses each online with probability p give P(at least four) = p⁴(5−4p): 18.75% at p=0.5, 63.28% at 0.75, 91.85% at 0.9, and 97.74% at 0.95. With one witness permanently absent or withholding replies, availability is p⁴ for the other four: 65.61% at p=0.9. These exact independent probabilities are also retained in JSON; finite simulated traces need not equal them.

The shared schedule gives all witnesses the same eight online hours per day. The staggered schedule starts eight-hour sessions at 00:00, 05:00, 10:00, 15:00, and 20:00: some witnesses are always online, but never four together. Temporal diversity alone therefore cannot sustain a fixed four-of-five quorum.

## Decision

Keep four-of-five admission experimental and opt-in. The local safety behavior is correct in these conditions, but ordinary intermittent desktops do not establish sufficient availability. Do not lower the threshold or introduce permanently operated relays to hide this problem. Within the volunteer-only requirement, a pilot needs volunteers with measured overlapping availability; that remains unproven here.

Before enabling this by default: specify safe witness replacement and membership governance, including old/new-set overlap and retained spend history; measure real volunteer overlap and network delay; then measure device energy and near-capacity/concurrent costs. Partial-certificate retention may be worth a separate design review, but it changes which non-overlapping online periods can complete a request and is not implemented or assumed here. No production retry or membership behavior changes in this evaluation.

## Reproduce

```sh
npm run eval:witness-availability -- --trials 12 --seed 20261001
```

This starts only temporary loopback listeners and removes its encrypted test histories on completion. It creates no installer or release. Timing/CPU values vary with host load; seeds reproduce the schedule model and injected-delay sequences, not cryptographic randomness or OS scheduling.
