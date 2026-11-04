# DEC-011 independent revised-work-budget review — October 31, 2026

**Status: evaluation only, not approval.** No implementation, deployment, cap change, production decision, economic-affordability verdict or K/R acceptance is made. The evidence supports rejecting RSO5 under the original caps and evaluating narrowly bounded research alternatives. It does not support a production budget revision now.

## 1. Evidence basis and distinctions

The calculations use three different measurements that must not be conflated:

- **Maximum single operation:** 17,741,154 B (`local-C-recovery:3`) against the original per-operation cap of 4,718,592 B.
- **Complete two-transition lifecycle:** 677,973,227 B against the original cumulative cap of 268,435,456 B, from `docs/evals/v04-rso5-cost-analysis-2026-10-26.md`.
- **DEC-011 sustained window:** 24,600,514,019 B of work and 3,413,095,379 WebSocket frame B over 1,800.081799042 s, with 36,504 retries, from `docs/evals/v04-dec11-full-warmup-baseline-2026-10-31.md` and `delivery/results/econ-dec11-baseline-baseline.json`.

Work bytes, frame bytes, CPU time, energy and money are different quantities. No conversion between them is assumed. The lifecycle average below is also distinct from the sustained maximum-envelope rate.

## 2. Per-operation budget scenarios

The measured maximum operation is:

```text
17,741,154 / 4,718,592 = 3.759840647× the original cap (approximately 3.760×)
```

| Scenario | Calculation | Per-operation budget | Interpretation |
| --- | --- | ---: | --- |
| Original cap | unchanged | 4,718,592 B | RSO5 fails: measured maximum exceeds the cap by 13,022,562 B. |
| +10% over measured maximum | 17,741,154 × 1.10 = 19,515,269.4 | **19,515,269 B** | Rounded down to whole bytes; only 10% headroom over one measured maximum. |
| +25% over measured maximum | 17,741,154 × 1.25 = 22,176,442.5 | **22,176,443 B** | Rounded up to whole bytes; only 25% headroom. |
| +50% over measured maximum | 17,741,154 × 1.50 = 26,611,731 | **26,611,731 B** | Exact +50% scenario; not a lifetime or production margin. |

The original-cap excess is **13,022,562 B**. A +50% scenario fits the observed maximum but does not establish that future maxima, other scenarios or history growth will fit.

## 3. Complete two-transition cumulative scenarios

The complete lifecycle work is:

```text
677,973,227 / 268,435,456 = 2.525647085× the original cumulative cap (approximately 2.526×)
```

| Scenario | Calculation | Cumulative budget | Interpretation |
| --- | --- | ---: | --- |
| Original cap | unchanged | 268,435,456 B | RSO5 fails by 409,537,771 B. |
| +10% over measured lifecycle | 677,973,227 × 1.10 = 745,770,549.7 | **745,770,550 B** | Rounded up; fits this trace with 10% margin. |
| +25% over measured lifecycle | 677,973,227 × 1.25 = 847,466,533.75 | **847,466,534 B** | Rounded up; fits this trace with 25% margin. |
| +50% over measured lifecycle | 677,973,227 × 1.50 = 1,016,959,840.5 | **1,016,959,841 B** | Rounded up; fits this trace with 50% margin, not a permanent bound. |

These are scenario envelopes fitted to observed evidence, not proof that any particular production arrival pattern is affordable or safe.

## 4. Sustained-rate constraint

Using the exact DEC-011 elapsed time:

```text
Work rate  = 24,600,514,019 / 1,800.081799042 = 13,666,331.181 work B/s
Frame rate =  3,413,095,379 / 1,800.081799042 =  1,896,077.934 frame B/s
Retry rate =             36,504 / 1,800.081799042 =         20.279078 retries/s
```

The exact work and frame rates are therefore approximately **13,666,331 B/s** and **1,896,078 frame B/s**. A +50% sustained-work envelope is:

```text
24,600,514,019 × 1.50 = 36,900,771,028.5 ≈ 36,900,771,029 B per 30 minutes
```

The scenario-fit cumulative budget of 1,016,959,841 B supports only:

```text
1,016,959,841 / 24,600,514,019 = 0.041338967 = 4.1338967% of the measured sustained work rate
36,504 × 0.041338967 = 1,509.038 retries per 30 minutes (approximately 1,509)
```

Thus a hard arrival limit of **no more than 4.13% of the measured sustained rate**, or roughly **1,509 retries per 30 minutes**, is the arithmetic constraint before any uncertainty, history-growth, failed-attempt or tail margin. It is not a recommendation to operate at that boundary. The measured sustained workload performs 36,504 retries, so this budget supports only about one twenty-fourth of that intensity.

For clarity, +50% sustained work is **36,900,771,029 B per 30 minutes**, not a cumulative-lifetime allowance. The corresponding +50% frame and retry quantities, if needed for separate analysis, are 5,119,643,068.5 frame B and 54,756 retries per 30 minutes; they are not evidence that those rates are affordable.

## 5. Average-equivalent events are not a lifetime forecast

Using the supplied current average of **84,746,653.375 B** (677,973,227 / 8):

| Budget basis | Calculation | Average-equivalent events |
| --- | --- | ---: |
| Original cumulative cap | 268,435,456 / 84,746,653.375 | **3.167505** |
| 1.5× the original cumulative cap | 402,653,184 / 84,746,653.375 | **4.751258** |
| 1.5× the measured complete lifecycle, equal to the scenario-fit budget | 1,016,959,841 / 84,746,653.375 | **12.000000** |

The **12.000** value uses 1.5× the measured lifecycle, not 1.5× the original cap. Average-equivalent counts conceal the measured per-operation maximum and sustained peak. They are not lifetime forecasts, arrival-rate evidence or proof of affordability.

## 6. Options and honest evaluation

| Option | Evaluation |
| --- | --- |
| **A. Retain original caps and reject RSO5** | **Supported for unchanged requirements.** The maximum operation is 3.760× its cap and complete lifecycle work is 2.526× its cumulative cap. Current RSO5 does not meet the original work budgets. |
| **B. Scenario-fit research budget: per-operation 26,611,731 B and cumulative 1,016,959,841 B** | **Defensible only for a separately reviewed, explicitly bounded research scenario.** It fits the measured maxima with +50% headroom, but requires a hard arrival limit no greater than 4.13% of the measured sustained rate (about 1,509 retries per 30 minutes) and additional uncertainty/history margins. It is not production evidence, not an affordability result and not a silent cap change. |
| **C. Full-sustained envelope: cumulative 36,900,771,029 B per 30 minutes** | **An arithmetic envelope, not a defensible production budget on current evidence.** It accommodates 150% of one sustained measurement but supplies no physical power, physical-network, labor, growth or tail evidence and does not establish affordability. It must not be presented as enough forever. |

No option establishes production approval, energy use, physical-network cost, labor cost, K7/K8 compliance or economic affordability. Option B is the only plausible revision for further research, and only with its scenario and arrival constraints made explicit. **No budget revision is defensible for production approval now.**

## 7. Independent evidence required before owner approval

Before any revised production budget or affordability decision, require all of the following:

1. **Independent reproduction and identity review:** verify exact source/artifact hashes, all failed and superseded attempts, mandatory per-operation and complete-lifecycle maxima, per-role totals, and complete failure history. Do not fit caps to averages or discard failures.
2. **Representative maxima and uncertainty:** repeat maximum-envelope and mixed-scenario measurements on production-representative hardware and configurations. Include proof/history/configuration growth, failed-attempt work, tail distributions and an explicit uncertainty margin. A +50% observation margin alone is not a lifetime bound.
3. **Calibrated physical power and thermals:** measure matched idle and sustained power on the named physical device using an authorized calibrated instrument, including absolute and incremental energy, thermal/throttling state and instrument uncertainty. Power is currently blocked with no samples; CPU/work bytes are not watts.
4. **Complete physical networking:** measure every relevant edge and direction, including handshake/control frames, TCP/IP, TLS, discovery, retries and failures on production-representative networks. Loopback is not Internet, Wi-Fi or last-mile evidence; current application frame totals are incomplete physical-network totals.
5. **Disk, memory and durability costs:** obtain per-process physical read/write counters, fsync count/latency and tails, storage-wear indicators and sustained process-tree memory on production-representative devices. Logical arena bytes and logical process-held copies are not physical-I/O or device-durability proof.
6. **Operational evidence and actual arrivals:** measure natural churn, recruitment/enrollment/catch-up, repair tails, labor and correlated incidents under the separately authorized operator/network pilot. Establish actual recovery arrival rates and prove the <=4.13% scenario limit rather than assuming it.
7. **Owner inputs and safety gates:** obtain accounting period, prices, budget, value and risk tolerances; independently assess labor/hardware/network costs and affordability. Separately evaluate privacy, safety, four-copy availability, retry behavior, R1/R2 and K1–K8. Timing compliance does not accept any of these gates.

## 8. Recommendation

**Retain the original caps and reject current RSO5 for any production decision now.** For continued research only, an independent reviewer may assess Option B as a scenario-specific, arrival-limited budget with per-operation 26,611,731 B and cumulative 1,016,959,841 B, subject to <=4.13% of measured sustained intensity and further uncertainty analysis. Option C is not a defensible production budget; it is only 150% of one measured 30-minute envelope. No revision should be approved until the required independent physical, operational, uncertainty and owner-input evidence exists.

Power remains blocked, loopback is not Internet evidence, history growth makes forecasts uncertain, and no K/R acceptance follows.
