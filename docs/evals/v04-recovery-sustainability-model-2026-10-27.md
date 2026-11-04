# Resonance recovery sustainability model — October 27, 2026

**Scope:** arithmetic analysis only. No implementation, campaign, cap change or R1/R2/K acceptance. Measured work, rejected forecasts, probabilistic availability and economic sustainability are separate measures.

## 1. Decision summary

The evidence supports declaring the current recovery architecture nonviable under the existing work limits before any monetary tipping analysis:

- The only complete measured baseline is **677,973,227 B** for four nodes and two transitions, against cumulative comparison **268,435,456 B**.
- The largest operation is **17,741,154 B** against `W=4,718,592 B`; 28 operations exceed it.
- RSO6 and the CometBFT sidecar are rejected designs, not lower viable budgets.
- No evidence establishes a theoretical minimum for every architecture or proves recovery impossible under every design.

Under independence, one quorum already fails the 99% availability target at 10% disappearance: its availability is **91.854%**, and at 20% disappearance it is **73.728%**. The single-quorum 99% tipping point is **3.268211%** disappearance. These probabilistic failures occur much earlier than the deterministic quorum loss guaranteed when more than 20% of a five-member cohort is permanently unavailable. None of these figures is an economic threshold.

## 2. Lowest defensible budget

The final RSO5 artifact (`delivery/results/rso5-operation-work.json`) records complete inventory and 272 operations totaling **677,973,227 B**. Sensitivity averages are:

```
per node             = 677,973,227 / 4     = 169,493,306.75 B
per node-transition  = 677,973,227 / (4*2) =  84,746,653.375 B
```

These describe this particular trace, including bootstrap, agreement, recovery, retries and policy/observer work. They are **not marginal replacement costs or a linear lifetime model**. Total excess over the cumulative comparison is **409,537,771 B**; measured work is **2.52565×** the comparison.

Rejected alternatives do not establish a lower viable budget:

| Candidate | Figure | Interpretation |
|---|---:|---|
| RSO5 measured | 677,973,227 B | Complete measured current-design baseline, not acceptance. |
| RSO6 | 311,198,374 B | Optimistic/incomplete; omits 71 records and index work; cold reserve exceeds W. |
| CometBFT displayed | 428,484,946 B | Invalid execution model importing all 102 RSO phases. |
| CometBFT mechanical substitution | 262,681,555 B | Mechanical 12-cut/12-non-cut substitution before other corrections; not validated or evidence of fit. |

The cumulative limit is a reconstruction/copy-work limit for a defined measurement scope, not a documented monthly allowance or automatic reset. Per-participant resets are forbidden. If every future transition cost exactly the measured average and the entire budget were unused:

```
268,435,456 / 84,746,653.375 = 3.1675 average-equivalent transitions/node
```

This is not a sustainable lifetime, guaranteed replacement count or 100-transition fit. History growth reduces future allowance. An owner-defined accounting window and arrival rates would be needed to discuss months of service.

## 3. Availability as nodes disappear

Each cohort has five members and requires four. Let `s` be independent per-node availability and `d=1-s` disappearance probability. Cohort availability is:

```
Q(s) = s^5 + 5*s^4*(1-s) = s^4*(5-4s)
Q(1-d) = 1 - 10*d^2 + 20*d^3 - 15*d^4 + 4*d^5
```

For `m` independent required quorums, joint availability is `Q(s)^m`. Independence is optimistic for shared homes, power, ISPs, geography or administrative control. Shared members/dependencies also invalidate simple multiplication.

| Required quorums m | d=10% | d=20% | d=50% |
|---:|---:|---:|---:|
| 1 | 0.9185400000 | 0.7372800000 | 0.1875000000 |
| 2 | 0.8437157316 | 0.5435817984 | 0.0351562500 |
| 3 | 0.7749866481 | 0.4007719883 | 0.0065917969 |
| 4 | 0.7118562357 | 0.2954811716 | 0.0012359619 |
| 5 | 0.6538684268 | 0.2178523582 | 0.0002317429 |

At 10% independent disappearance, one quorum already fails the 99% target at **91.854%** availability. At 20%, one quorum is available **73.728%** of the time; at 50%, only **18.75%**. More required quorums further reduce joint availability.

A separate deterministic fact: **if more than 20% of a five-member cohort is permanently unavailable, more than one member is gone and quorum is necessarily lost**. This permanent-outage guarantee is distinct from the probabilistic model, which fails the 99% target much earlier.

For the 99% target, the disappearance rate `d99` solving `Q(1-d)^m=0.99` is:

| m | d99 |
|---:|---:|
| 1 | 3.268211% |
| 2 | 2.291063% |
| 3 | 1.863358% |
| 4 | 1.609932% |
| 5 | 1.437650% |

Above these rates, the independent model predicts less than 99% joint availability. These probabilistic tipping points are not economic thresholds or safe operating targets.

## 4. Failure and repair approximation

Under a simple stationary independent birth-death approximation, with failure rate `λ` and repair/replacement rate `μ`:

```
p = λ/(λ+μ), s = μ/(λ+μ)
```

For greater than 99% joint availability, `Q(s)^m > 0.99`, so the boundary requires approximately:

| m | Required μ/λ |
|---:|---:|
| 1 | 29.60 |
| 2 | 42.65 |
| 3 | 52.67 |
| 4 | 61.11 |
| 5 | 68.56 |

For example, five independent required quorums need repair roughly 68.56 times as fast as failure in this approximation. It is not a real-world guarantee: correlated outages, recruitment lead time, enrollment, data transfer, catch-up and recovery-time tails can invalidate the model. Real decisions need distributions and tails, not just means.

## 5. Operational and economic tipping points

### Work/capacity tipping

For `R` replacements in a defined scope and complete work `C` per replacement, the tipping condition is:

```
R*C > available recovery-work capacity
```

Equivalent physical network, energy, operator-time and storage limits must also hold; these different units cannot be added without prices.

Using the measured average solely as an illustration gives **3.1675 average-equivalent replacements** from an unused original cumulative budget. Bootstrap, lifecycle work, retries and history growth reduce that allowance. The current design reaches its work-limit tipping point before an economic optimum can be inferred.

### Monetary cost

Work bytes are not joules, physical network bytes, labor hours or currency. No monetary cost can be calculated from the measured work alone. For `R` replacements over a defined economic period:

```
C_total = R*(E*p_e + N*p_n + H*p_h + hardware)
```

Where `E` is measured energy per replacement, `p_e` its price, `N` actual network traffic on every required edge/direction, `p_n` its price, `H` operator/developer labor hours, `p_h` labor price, and `hardware` is amortized/incremental hardware cost.

A monetary tipping point occurs when this total plus ordinary operating costs exceeds the operator/community budget or value. Those inputs are owner/product decisions, not protocol constants.

Required empirical inputs:

1. Energy per cold, returning, new-view and local-loss recovery on named hardware.
2. Actual network traffic, including consensus, retries, evidence, discovery and failures.
3. Labor for detection, recruitment, enrollment, replacement, verification and incidents.
4. Hardware amortization, storage endurance, failure rates and replacement lead times.
5. Failure/repair distributions and correlations across homes, power, networks and operators.
6. Exact cumulative accounting scope and any owner-approved reset semantics.
7. Marginal work as a function of retained history, proofs, configurations and successor distance.

No currency, energy factor or volunteer hourly rate is invented here.

## 6. Recommendation

1. **Accept the current recovery architecture as nonviable under unchanged work limits.** Complete measured evidence establishes this without an economic model.
2. Do not treat RSO6 or either CometBFT cumulative figure as a viable lower budget.
3. Do not generalize rejection into impossibility for every future architecture; a different candidate needs complete protocol-derived accounting.
4. Keep availability and economics separate. The 3.268211% single-quorum probabilistic tipping point is not an economic threshold or safe operating target.
5. Before an owner budget/product-trust decision, define the cumulative accounting window and measure marginal history growth, physical network, energy, labor, hardware, failure/repair tails and correlations. New monetary or volunteer assumptions need explicit owner decisions.
6. Preserve five/quorum-four/at-most-one-Byzantine, original safety, privacy, four-copy, prospective-funding and evidence requirements while gathering those inputs.

**Conclusion:** current-design recovery is unsustainable under existing work limits. No lower viable budget, sustainable lifetime, 100-transition fit or economically optimal disappearance threshold is established.
