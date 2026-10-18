# Composed volunteer availability: feasibility screen

**Result: the present four-of-five design requires high overlapping volunteer
availability. K8 is not qualified.** This is exact arithmetic under explicit
assumptions, not a measurement of volunteers or a forecast of the service.

Blocker `B-VOLUNTEER-AVAILABILITY`, alternative A1. The question was whether the
accepted 99% end-to-end target follows from ordinary redundancy. A finding that
plausible component availability remains below 99%, or that a common failure
sets a lower ceiling, falsifies that inference. This experiment changes no live
placement, quorum, traffic or trust rule.

## Model and results

Let `p` be the probability that an honest volunteer responds, conditional on no
common outage. Assume independence between the five members. With no permanent
withholder, four-of-five availability is `q = p^4 * (5 - 4p)`. With one permanent
withholder, all four remaining members must respond: `q = p^4`.

For `k` required independent cohorts, joint availability is `q^k`. Histories on
identical members share one event, `q`; storing more histories does not create
more independent cohorts. If the common-outage fraction is `c`, and operation
success conditional on all these requirements is `s`, the modeled service
probability is `(1-c) * q^k * s` (or `(1-c) * q * s` for identical members).

The following deliberately optimistic cases use `c=0`, `s=1`, and assume every
other required owner, witness and route is always available:

| Placement | Individual availability | Modeled joint availability | Expected unavailable minutes in 14 days |
| --- | ---: | ---: | ---: |
| One cohort / identical-member histories | 90% | 91.854% | 1,642.23 |
| Two independent required cohorts | 90% | 84.372% | 3,150.69 |
| One cohort / identical-member histories | 95% | 97.741% | 455.46 |
| Two independent required cohorts | 95% | 95.533% | 900.64 |

These are expected totals from a stationary probability, not predicted lengths
or counts of outages. Real availability can be correlated and nonstationary.
The current test fixture places 55 histories on two sets of five endpoints;
it must not be modeled as 55 independent five-device cohorts. Neither the
independent nor identical-member case calibrates its complete dependency graph.

The subsequent protected allocation-authority work adds the explicit
[operation dependency matrix](v04-protected-allocation-authority-2026-10-18.md#k8-dependency-matrix).
It does not change the retained 55-history fixture or retrospectively qualify
new physical placement; its signing owner and required quorum must be included
when measuring operations that create allocations or assignments.

### Minimum individual availability for the 99% target

| Required physical cohorts | Permanent withholders per cohort | Conditional operation success | Minimum `p` |
| --- | ---: | ---: | ---: |
| One | 0 | 100% | 96.732% |
| Two independent | 0 | 100% | 97.709% |
| One | 1 | 100% | 99.749% |
| Two independent | 1 | 100% | 99.874% |
| One | 0 | 99.5% | 97.706% |
| Two independent | 0 | 99.5% | 98.388% |

All rows assume zero common outages and perfect other dependencies. A withholder
in each of two independent cohorts means two withholders, one in each physical
group; identical-member histories share the same withholder.

At 1% common outage and otherwise perfect operation, 99% is attainable only at
`p=1`. With 99.5% conditional operation success, that same outage fraction caps
the result at **98.505%**, even at `p=1`. More copies within these unchanged
cohorts cannot overcome that ceiling. At the accepted 99% target, the 14-day
unavailable-time budget is 201.6 minutes.

## Engineering decision

The mathematics does not prove that volunteer-only service is impossible. It
does show that counting replicas without their schedules, shared failure domains
and all required roles is insufficient. The next design needs measured volunteer
overlap and safe membership replacement while an old usable quorum still exists.
Co-hosting can reduce independent availability dependencies but concentrates
failures and trust; its apparent arithmetic benefit is not a security decision.

Do not lower four confirmations, erase old histories, count stale receipts as
current responses or introduce a permanent operator service to make the model
pass. See the [bounded architecture decision](../developers/v0.4-feasibility-decision.md).
An independent pilot is still required for K8.

## Reproduction and validation

Run from the repository root with a **new** output path:

```sh
npm run eval:service-availability -- --out /tmp/resonance-availability-new.json
npx vitest run packages/eval/src/__tests__/service-availability-feasibility.test.ts
```

The CLI refuses to overwrite a report. The [retained JSON](service-availability-feasibility-2026-10-18.json)
contains 12 scenarios / 60 points, two K1 sensitivity cases, the base commit and
source hashes. It was produced on base `fab1ae2` with the newly added sources.
SHA-256: `4b3b438cdbcb19c115a0afe2d4c24601497368f2fbdbb534e81472c67cf481a9`.

Eleven focused tests pass, including analytical state-count checks for one/two
cohorts and withholding, co-hosting, common factors, analytic roots, threshold
bracketing, infeasible ceilings and invalid inputs. Independent implementation
review found no blocking issue. This verifies the stated model, not the real
network, its latency, its outage correlation or its ability to survive an
arbitrary volunteer schedule.
