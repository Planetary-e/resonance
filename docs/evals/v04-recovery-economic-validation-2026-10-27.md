# Resonance recovery economic validation plan — DEC-007

**Status: evidence and measurement plan only.** The owner selected **Validate
production cost** in DEC-007. The existing RSO5 diagnostic may be characterized,
but this document does not authorize implementation, deployment, production
routing, a campaign, new external traffic, physical power instrumentation, pilot
operations, Git/CI, a release, or any K/R acceptance.

FEAT-001 remains blocked. R1/R2, EVL-003/004/005/015 and K1–K8 remain open.
Independent deployments, physical power measurements, new external traffic and
pilot operations each require separate owner authorization and sanitized evidence.
The stopped campaign must not be resumed or renamed as an economic measurement.

## 1. Decision question and boundaries

The decision is whether recovery can be economically and operationally sustainable
under explicit owner budget/value assumptions without hiding resource use or
weakening five/quorum-four/at-most-one-Byzantine, original safety and privacy,
four-copy availability, prospective funding, or evidence requirements.

The following remain different quantities and must not be converted into one
another without measurements and prices:

- metered reconstruction/copy work in bytes;
- elapsed and CPU time;
- process-tree memory and disk I/O;
- physical energy in joules or watt-hours;
- physical network bytes on every edge and direction;
- failure, detection, recruitment, repair and catch-up time;
- active labor by operator role; and
- money over an owner-defined accounting period.

No new architecture is proposed. No result from this plan can retroactively make
RSO5 fit its existing operation or cumulative work limits.

## 2. Current local evidence and its limits

### 2.1 Completed DEC-007 local diagnostic

A local `/usr/bin/time -l` run of the in-process four-node/two-transition RSO5
diagnostic completed with:

| Metric | Observed value |
| --- | ---: |
| Host/runtime | Apple M3 Pro, arm64, Node.js 24.19.0 |
| Elapsed real time | 68.04 s |
| User CPU | 18.03 s |
| System CPU | 7.17 s |
| Total CPU | 25.20 s |
| CPU utilization | approximately 37.04% of one core |
| Peak RSS | 385,236,992 B, exactly 367.390625 MiB (367.4 MiB to one decimal) |
| Block I/O operations reported by `time -l` | 0 |
| Instructions | 7,862,713,853 |
| Cycles | 2,784,054,943 |
| Reclaims | 36,432 |
| Faults | 3,659 |
| Voluntary context switches | 62,078 |
| Involuntary context switches | 51,543 |
| Latest in-process work total | 677,938,671 B |
| Finalizer verification | 23 hashes verified |

No independent session workload was reported during the run. That observation is
**not** whole-host isolation: operating-system services, unmeasured processes,
thermal state and other host activity were not controlled or excluded.

The zero block-I/O-operation counter does not establish zero disk bytes, zero
filesystem work or zero storage wear. Peak RSS for this in-process run does not
price an independent multi-process deployment. Instructions and cycles are not
joules. CPU utilization is not idle CPU, package power or whole-system power.

### 2.2 What this run cannot establish

This is not independent-node, physical-network, power, production, K7 or K8
evidence. It does not measure:

- baseline or recovery energy;
- independent process-tree memory/CPU across machines;
- physical packets below TCP, TLS overhead, discovery or Internet egress;
- disk bytes and fsync/storage tails on independent hosts;
- natural failure/repair rates, tails or correlated cohort loss;
- recruitment, enrollment, catch-up or verification labor; or
- monetary cost, owner value or production affordability.

The current honest classification is **local prototype diagnostic evidence**. It
is sufficient to define subsequent measurements, not to choose a production
budget or claim production economics.

## 3. Common preregistration and evidence rules

Before any future measurement, freeze a manifest containing:

- authorization ID and permitted stage;
- scenario, run ID, fixed seed and execution order;
- exact source/configuration hashes and finalizer/evidence hashes;
- hardware model, chip, memory, storage, salted host identity and role;
- OS build, Node/runtime versions, power mode and network configuration;
- start/end UTC, elapsed time, warmup and cooldown;
- concurrent-workload and isolation limitations;
- units, sampling rate, instrument model/range/accuracy and calibration date;
- missing samples, invalid runs and all exclusions with reasons; and
- sanitization procedure and hashes of controlled raw evidence.

A failed or invalid run remains in the ledger. Do not replace it silently, select
only favorable repetitions, widen a maximum envelope after seeing results, or
convert a diagnostic into an acceptance run. Any change to run count, seeds,
hardware, scenario or analysis requires a dated amendment before the affected
measurement.

All evidence arrays must report sample count, missing/censored count, minimum,
median, p90, p95, p99, maximum and an uncertainty interval where meaningful. A
small sample must not be presented as a stable tail distribution. Fewer than 20
events yields descriptive values only, not a claimed validated p95/p99.

### 3.1 Predeclared laboratory runs and seeds

For each named hardware/network configuration, use one fixed order seed
`0xE0072026` to permute scenario order before measurements begin. Execute five
complete repetitions of each scenario:

| Scenario | Run IDs | Seeds |
| --- | --- | --- |
| Cold recovery | `cold-01` through `cold-05` | `0xE0070001` through `0xE0070005` |
| Returning recovery | `return-01` through `return-05` | `0xE0070101` through `0xE0070105` |
| Complete local-loss recovery | `local-01` through `local-05` | `0xE0070201` through `0xE0070205` |
| New-view recovery | `new-view-01` through `new-view-05` | `0xE0070301` through `0xE0070305` |

The same seeds and scenario definitions apply to power, process, disk and network
capture so records can be joined. A run is complete only when the entire selected
recovery, predecessor-independent evidence checks and durable readiness finish.
Partial attempts remain failure records and are not substituted with shorter
successful paths.

These 20 laboratory repetitions are resource measurements, not a 100-transition
campaign or acceptance schedule. Natural-churn observations cannot substitute for
any of these predeclared laboratory runs.

### 3.2 Required evidence artifacts

The following are **future required artifacts**, not files created by this plan:

| Artifact | Required content |
| --- | --- |
| `delivery/results/econ-local-rso5-2026-10-27.json` | Exact local `time -l` counters, environment, work total, 23-hash verification and isolation limitations. |
| `delivery/results/econ-lab-manifest.json` | Frozen order seed, scenario seeds, hardware/roles, instrument metadata, authorizations and source/config hashes. |
| `delivery/results/econ-power-<run>.json` | Idle/sustained baselines, absolute and baseline-subtracted energy, power statistics, thermal state and validity. |
| `delivery/results/econ-power-<run>.csv` | Timestamped external-meter and authorized OS power-tool samples with units and missing-sample markers. |
| `delivery/results/econ-process-<run>.json` | Per-process and process-tree CPU/RSS, elapsed time, child processes and isolation notes. |
| `delivery/results/econ-disk-<run>.json` | Read/write bytes and operations, fsync count/latency, queue/tail data and storage-wear indicators where available. |
| `delivery/results/econ-network-<run>.json` | Sanitized per-edge/direction/purpose packets and bytes, TCP/UDP/TLS/discovery/retry/failure overhead and capture reconciliation. |
| `delivery/results/econ-pilot-14d-manifest.json` | Separate authorization, operators, networks, cohorts, privacy review, observation seed and frozen analysis. |
| `delivery/results/econ-pilot-14d-events.json` | All sanitized failure, detection, recruitment, enrollment, catch-up, repair and censoring events. |
| `delivery/results/econ-pilot-14d-labor.json` | Active/passive time by operator and role, interruptions and verification work. |
| `delivery/results/econ-pilot-14d-availability.json` | Member/cohort availability, correlations, joint service intervals and uncertainty. |
| `delivery/results/econ-owner-assumptions.json` | Owner-approved prices, period, arrival rates, budget, value, hardware life and uncertainty margin. |
| `delivery/results/econ-decision.json` | Gate-by-gate evidence references, calculations, limitations, reviewer verdict and owner decision. |
| `docs/evals/v04-recovery-economic-evidence-YYYY-MM-DD.md` | Reproducible evidence receipt and deviations, without K/R acceptance overclaim. |

Raw packet captures, operator identifiers and sensitive logs remain in controlled
storage when needed, referenced by hash. Repository artifacts contain sanitized
flow records, salted identities and relative timing; no IP addresses, recipient
keys, evidence plaintext or private payloads are published.

## 4. Stage 1 — local evidence ingestion and measurement validation

Stage 1 is limited to preserving the completed DEC-007 diagnostic and checking
that its evidence can be joined to the exact candidate:

1. Record every value in section 2 without replacing the earlier work baseline or
   treating the new 677,938,671 B total as an economic unit.
2. Record source/config identity, the finalizer's 23 verified hashes, runtime and
   all known host/isolation limitations.
3. Preserve zero block-I/O operations as a counter observation only; do not infer
   zero bytes or storage cost.
4. Mark physical power, independent process/network, labor and monetary fields as
   unmeasured rather than zero.

**Gate E1 — local evidence usable for planning:** all local counters and identity
fields are present, limitations are explicit, and no power/network/production
claim is made. Failure means the local result is anecdotal and cannot calibrate
the next stage. E1 does not qualify production or any K gate.

## 5. Stage 2 — independent physical resource measurement

**Authorization gate:** no Stage 2 action until the owner separately authorizes
the named hosts, power instrumentation, independent processes and any external
traffic. Instrumentation that requires elevated privileges also requires explicit
system-owner authorization. This document authorizes none of them.

### 5.1 Named hardware and controlled conditions

Start with the observed Apple M3 Pro/arm64 and Node.js 24.19.0 configuration, but
record exact model, memory, storage, OS build and salted host identity before
use. Repeat the complete matrix on every additional hardware class proposed for
production; do not extrapolate M3 Pro energy to another machine.

For each matched baseline/run pair:

- use the same OS build, power adapter/source, power mode and network settings;
- fix screen brightness and peripheral configuration across idle and recovery;
- record battery state/charging, ambient temperature and thermal/throttling state;
- use AC power for external-meter comparisons and report battery-only separately
  if it is a production configuration;
- suspend only owner-approved discretionary workloads, and record everything not
  controlled; and
- preserve warmup, cooldown and complete run order.

Use a properly ranged external AC power meter sampling at least once per second,
with recorded accuracy/calibration, plus an appropriate OS power tool such as
`powermetrics` where authorized. The external meter measures whole-system energy;
the OS tool supplies supporting component evidence. Neither is replaced by CPU
utilization, cycle counts or a work-byte conversion.

### 5.2 Baseline and complete recovery energy

For each hardware/power configuration, collect:

1. one continuous **30-minute idle baseline** with the application processes
   present but no recovery work;
2. one continuous **30-minute sustained maximum-envelope recovery workload** in
   the isolated laboratory, with scenario mix and order frozen in the manifest;
3. five complete cold, five returning, five complete local-loss and five new-view
   runs using the predeclared seeds; and
4. paired idle windows immediately before and after each complete run.

Report absolute watt-hours and incremental energy
`E_incremental = E_run - mean(P_idle_matched)*t_run`. Also report average and
peak watts, energy per successfully completed recovery, energy of failed attempts,
thermal throttling and confidence/uncertainty from instrument accuracy and
repetitions. Do not hide failed-attempt energy by dividing only by successes.

The sustained 30-minute workload is a power/thermal measurement, not a lifetime
or 100-transition qualification.

### 5.3 Independent processes, disk and physical network

Use independently observable node processes on separately metered hosts or
isolated virtual machines, with five pinned roles `N1`–`N5`, the executed active
set, predecessor/successor roles, and policy/observer processes identified. A
single in-process simulation cannot satisfy this stage.

For every process and its complete child tree, record:

- user/system CPU and elapsed time;
- peak RSS and a documented shared-memory aggregation method;
- disk read/write bytes and operations, fsync count/latency and I/O tails;
- process creation, restart, crash and shutdown costs; and
- host-level background activity and virtualization overhead.

Capture actual traffic at the host packet layer and, where authorized, a router or
switch observation point. Measure below TCP, including IP, TCP/UDP,
retransmissions, ACKs, resets, ICMP, ARP/ND, DNS/DHCP where applicable, discovery,
TLS records/handshakes, application payloads, retries and failures. TLS need not
be decrypted; record its actual ciphertext bytes and overhead.

For every source/destination edge and **both directions**, report:

- packets and bytes at stated capture layers;
- LAN, Wi-Fi, last-mile and Internet/egress classification;
- protocol and purpose, including consensus, ABCI/IPC where applicable, evidence,
  delegation, snapshot/chunk, discovery, policy/observer and health traffic;
- retransmission, duplicate, timeout and failure bytes;
- predecessor-to-successor, successor-to-evidence-copy and observer traffic; and
- capture drops and host/router reconciliation.

Do not sum host and router copies of the same packet. Do not infer physical
traffic from application work or in-process buffers. Every declared edge must be
present even when its measured value is zero; an undeclared or unexplained edge
invalidates the network-complete claim.

**Gate E2 — physical resource evidence complete:** all 20 complete scenario runs,
including five new-view runs with their power, process, disk and network artifacts,
30-minute baselines, process-tree/disk records and the full edge/direction matrix
are valid, or every failure is carried into cost and tail analysis. Natural churn
cannot substitute for any required laboratory scenario or artifact. Missing power
calibration, uncontrolled scenario changes, incomplete process trees or unmatched
network directions blocks an economic estimate. E2 supplies physical quantities,
not prices or production approval.

## 6. Stage 3 — independent natural-churn pilot

**Authorization gate:** Stage 3 requires a new owner decision after Stage 2,
privacy/compliance review, informed operator consent and a sanitized-data plan.
It is not authorized by DEC-007 or this document. No stopped campaign may be run.

### 6.1 Predeclared population and duration

Run one continuous **14-day observational pilot** with:

- at least five independent operators `O1`–`O5`, each with separate administrative
  control and labor records;
- at least three genuinely distinct network providers, recording shared upstream
  dependencies rather than counting brand names alone;
- five pinned member roles, active/standby successor roles, a policy/observer role,
  an operator-labor recorder, a privacy/data steward and an independent reviewer;
- all natural failures, repairs, replacements and partial/censored events included;
  and
- observation-rotation seed `0xE0071401`, fixed before the pilot. Natural event
  timing is observed, not seeded or injected to manufacture a tail.

Record homes, power regions, ISPs, geography, administrative domains and shared
members/dependencies as correlation cohorts. Do not assume independence when
these overlap. Do not exclude weekends, holidays, failed recruitment or an event
whose recovery is still open at day 14.

Fourteen days cannot by itself validate annual availability, rare-event p99 or a
99% long-run target. If there are too few events, report censoring and descriptive
results; do not extend or add injected failures after seeing the data without a
new separately reviewed protocol.

### 6.2 Failure, repair and labor measurements

For every member and cohort, record:

- service-available time and quorum-available time;
- failure/detection timestamps and cause class;
- detection, recruitment, enrollment, evidence transfer, catch-up, verification
  and durable-readiness durations;
- open/censored repair time and unsuccessful attempts;
- replacements per cohort and simultaneous/correlated losses;
- p50/p90/p95/p99/max with event counts and uncertainty, only where supported;
- active labor minutes by detection, recruitment, enrollment, catch-up,
  verification and incident review; and
- passive waiting separately from active labor, with interruptions and volunteer
  availability constraints.

Join each event to its actual energy, network and disk usage from Stage 2-like
instrumentation where authorized. If the pilot does not measure a quantity, mark
it unknown rather than copying a laboratory mean without qualification.

**Gate E3 — operational evidence usable:** the full 14-day window, minimum
operator/network diversity, all events and labor records are present with
sanitization and correlation analysis. Missing operators/networks, selective event
omission or private-data leakage invalidates the pilot. Sparse tails limit the
conclusion; they do not justify inventing rates or claiming availability.

## 7. Monetary model and required owner assumptions

### 7.1 Formula

For an owner-defined period `T`, let `R_s` be the measured/approved number of
cold, returning, local-loss, new-view and other recovery events of type `s`. For each event:

- `E_s` is measured energy in kWh, keeping incremental recovery energy separate
  from ordinary idle energy;
- `N_{s,e,d}` is measured physical bytes on edge `e` and direction `d`;
- `H_{s,r}` is active labor hours for role `r`; and
- `A_s` is incremental hardware/storage wear and replacement cost.

Use owner-approved prices `p_e`, `p_{n,e,d}` and `p_{h,r}`:

```
recovery_cost_s = E_s*p_e
                + sum_edges,directions(N_{s,e,d}*p_{n,e,d})
                + sum_roles(H_{s,r}*p_{h,r})
                + A_s

C_T = ordinary_operating_cost_T
    + sum_scenarios(R_s*recovery_cost_s)
    + incident_and_privacy_cost_T
    + contingency_and_measurement_uncertainty_T
```

Ordinary operating cost includes idle energy and baseline services. Incremental
recovery energy must not be counted again in that baseline. Network prices may
differ for egress, ingress, last-mile and operators; do not replace the edge sum
with one universal price unless the owner explicitly supplies that assumption.

The owner must separately define value `V_T` and budget `B_T`. Affordability is
`C_T <= B_T`; an economic benefit claim additionally requires an owner-approved
comparison of `V_T` with `C_T`. Neither can be inferred from technical metrics.

### 7.2 Explicit owner inputs before pricing

`econ-owner-assumptions.json` must state:

1. currency, accounting period and ordinary operating-cost baseline;
2. electricity tariff/time-of-use and whether incremental or absolute energy is
   being priced;
3. per-edge/direction network prices, data caps and overage rules;
4. paid and volunteer labor rates, including any explicitly chosen volunteer
   shadow price and available labor hours;
5. hardware purchase/residual value, service life, storage wear and replacement
   policy;
6. recovery arrival rates by scenario and retained-history growth, with evidence
   or an explicit assumption label;
7. maximum-envelope and contingency margin covering measurement uncertainty,
   failure/repair tails, correlated churn and history growth;
8. budget `B_T`, value/benefit definition `V_T`, and acceptable service target; and
9. sensitivity ranges approved before viewing the final cost result.

No electricity factor, egress price, volunteer hourly rate, lifetime replacement
count or monetary value is invented by this plan.

## 8. Availability evidence is not an economic price

The corrected independent five-member/quorum-four model gives:

| Required quorums m | 99% disappearance tipping point d99 | Approximate required μ/λ |
| --- | ---: | ---: |
| 1 | 3.268211% | 29.60 |
| 2 | 2.291063% | 42.65 |
| 3 | 1.863358% | 52.67 |
| 4 | 1.609932% | 61.11 |
| 5 | 1.437650% | 68.56 |

At 10% independent disappearance, one quorum already fails the 99% target with
91.854% availability; at 20%, its availability is 73.728%. Permanent unavailability
of more than 20% of a five-member cohort guarantees quorum loss, but probabilistic
failure against the 99% target happens much earlier.

These values do **not** price economics. `d99` is a probability threshold under
independence, not replacements per month, labor hours, energy, traffic or money.
The stationary μ/λ approximation supplies no event arrival rate or price. Shared
power, ISPs, geography, administration and members invalidate simple independent
multiplication. Economic analysis needs the measured event rates, physical costs,
labor and owner assumptions above.

## 9. Predeclared decision rules

The gates constrain interpretation; they do not fit a cap or approve production.

### D1 — Evidence supporting retention of existing caps

Retain the existing caps as non-negotiable constraints only if the owner reaffirms
them and a complete candidate demonstrates, under the maximum envelope:

- protocol-derived per-operation and cumulative work within the unchanged caps;
- funded physical storage, network, process-tree and recovery obligations;
- measured energy/labor and cost within owner infrastructure and `B_T`; and
- the required service/privacy/safety properties with a predeclared uncertainty
  and history-growth margin.

This cannot qualify the current RSO5 diagnostic, which already exceeds work
limits. Retaining caps may therefore mean rejecting the current candidate and
requiring a genuinely different future design, not lowering the measured numbers
until they appear to fit.

### D2 — Evidence that could justify a reviewed revised budget

A revised resource/economic budget can be **proposed for review**, never adopted
by the measurement team, only when:

1. E1–E3 are valid or every limitation is explicitly carried as unresolved;
2. complete maximum-envelope process, energy, disk and every-edge network costs
   are measured on named production-representative hardware;
3. natural failure/repair, recruitment/enrollment/catch-up labor and correlation
   evidence support the chosen arrival and margin assumptions;
4. the proposed resource budget is no lower than measured mandatory maxima and
   includes the owner-predeclared margin for uncertainty, tails and history
   growth; and
5. `C_T` with that margin fits explicit `B_T` and the owner's value test, without
   weakening trust, privacy, four-copy availability or evidence obligations.

Architecture, privacy/compliance and owner approval are still separate. A revised
budget is not production authorization or K/R acceptance.

### D3 — Evidence requiring trust/deployment change or stopping production

Escalate to an owner architecture/deployment decision when any of the following
occurs:

- maximum-envelope `C_T` exceeds `B_T` or the owner value test fails;
- energy, network, storage, labor or repair time exceeds actual operator or
  infrastructure capacity;
- correlated cohorts make the independence model materially overstate service;
- measured availability or repair tails miss the owner's service target;
- required recruitment/enrollment/catch-up labor cannot be supplied;
- privacy, safety or four-copy durability cannot be maintained economically; or
- the only apparent cost reduction requires weaker quorum, trust, evidence or
  privacy assumptions.

Changing trust or deployment requires its own explicit owner and architecture
review; it is not an economic tuning action. If no acceptable trust/deployment
option meets safety and budget, **stop production rather than hide the cost or
silently weaken requirements**.

### D4 — When prototype-only is the honest result

Classify the result as prototype-only when evidence remains local/in-process,
power or physical-network measurements are missing, independent operators or
natural churn are absent, tails are too sparse, or owner prices/budget/value are
undefined. A technically successful prototype with unknown production economics
is still prototype-only.

The current evidence is in this category. Sparse 14-day observations also cannot
support annual, rare-tail or broad production claims. Prototype-only is a valid
negative/limited finding, not a reason to fabricate missing evidence.

## 10. Final evidence review and owner decision

The independent reviewer must reconcile run counts, seeds, source/config hashes,
instrument validity, every edge/direction, missing and failed runs, labor and
censoring, monetary units, owner assumptions and all margins. The reviewer must
state separately:

- physical quantities measured;
- quantities assumed;
- uncertainty and unavailable tails;
- work-cap status without refitting;
- economic affordability under explicit owner inputs; and
- which of D1–D4 follows.

Only then may the owner choose to retain caps, review a revised budget, authorize
a separate trust/deployment review, stop production, or retain prototype-only
status. No gate in this plan itself accepts RSO5, R1/R2, K7/K8 or production.
