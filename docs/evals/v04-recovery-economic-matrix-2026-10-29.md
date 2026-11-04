# RSO5 independent-process 20-run economic matrix receipt — DEC-008

**Status: 20/20 diagnostic runs complete; parent baseline review may proceed; E2 blocked; no K/R acceptance.** This is not production deployment, a campaign, a 30-minute window, physical power evidence or an economic-affordability verdict.

## Execution and immutable lineage

Initial command `node scripts/rso5-economic-matrix-driver.mjs` incorrectly repeated selection smoke and then failed its first actual lifecycle. The final successful resume command was:

```
node scripts/rso5-economic-matrix-driver.mjs --retry=8 --start-index=6 --previous=delivery/results/econ-matrix-execution-failure-retry-7-1793266170850.json
```

The complete ordered result is `delivery/results/econ-matrix-execution-resume-6-final.json`; the validated baseline is `delivery/results/econ-matrix-baseline-final.json`. Earlier selection, startup, readiness and metrics failures remain in `delivery/results/econ-matrix-entry-failures.json` and per-run failure artifacts. No failed artifact was deleted or overwritten. Retry identities are distinct and preserve the frozen preregistered IDs, order, seeds, scenarios and analysis.

## Per-run outcomes

All runs used 52 independent workers with clean stops and zero survivors. Each has run-specific manifest, summary, process, work, network, cleanup, decision and blocked-power artifacts. New-view runs additionally have post-newView startup/durable readiness evidence.

| Order | Run | Scenario | Work bytes | Outcome |
| ---: | --- | --- | ---: | --- |
| 0 | `matrix-local-04-retry-2` | local-loss | 689,289,952 | diagnostic PASS |
| 1 | `matrix-new-view-04-retry-3` | new-view | 102,221,003 | diagnostic PASS; post-newView startup complete |
| 2 | `matrix-local-05-retry-4` | local-loss | 689,317,176 | diagnostic PASS |
| 3 | `matrix-return-04-retry-5` | returning | 487,248,843 | diagnostic PASS |
| 4 | `matrix-return-03-retry-6` | returning | 487,345,179 | diagnostic PASS |
| 5 | `matrix-new-view-03-retry-7` | new-view | 102,221,003 | diagnostic PASS; post-newView startup complete |
| 6 | `matrix-new-view-05-retry-8` | new-view | 102,221,003 | diagnostic PASS; post-newView startup complete |
| 7 | `matrix-local-02-retry-8` | local-loss | 689,351,732 | diagnostic PASS |
| 8 | `matrix-cold-05-retry-8` | cold | 242,138,343 | diagnostic PASS |
| 9 | `matrix-return-02-retry-8` | returning | 487,283,399 | diagnostic PASS |
| 10 | `matrix-local-03-retry-8` | local-loss | 689,289,952 | diagnostic PASS |
| 11 | `matrix-cold-04-retry-8` | cold | 242,103,787 | diagnostic PASS |
| 12 | `matrix-cold-03-retry-8` | cold | 242,138,343 | diagnostic PASS |
| 13 | `matrix-return-05-retry-8` | returning | 487,283,399 | diagnostic PASS |
| 14 | `matrix-cold-02-retry-8` | cold | 242,103,787 | diagnostic PASS |
| 15 | `matrix-new-view-02-retry-8` | new-view | 102,221,003 | diagnostic PASS; post-newView startup complete |
| 16 | `matrix-return-01-retry-8` | returning | 487,248,843 | diagnostic PASS |
| 17 | `matrix-new-view-01-retry-8` | new-view | 102,221,003 | diagnostic PASS; post-newView startup complete |
| 18 | `matrix-cold-01-retry-8` | cold | 242,138,343 | diagnostic PASS |
| 19 | `matrix-local-01-retry-8` | local-loss | 689,351,732 | diagnostic PASS |

Five cold, five returning, five new-view and five local-loss runs completed. Local-loss recovered 820 proofs with 820 signed logical process-held copy audits; these are not physical-device/crash-durability claims.

## Aggregate measurements

| Metric | Aggregate |
| --- | ---: |
| Separate work metric | 7,604,737,825 B |
| Authenticated WebSocket messages | 265,814 |
| Application payload bytes | 2,316,046,867 |
| Application WebSocket frame bytes | 2,318,400,849 |
| Worker user CPU | 410.475847 s |
| Worker system CPU | 132.727686 s |
| Maximum sampled process-tree RSS | 181,436,416 B |

`delivery/results/econ-matrix-evidence-hashes-final.json` binds the execution, plan, baseline and every run artifact. The aggregate validator recomputed each per-role work total and checked every request/response linkage, new-view readiness record, power blocker and exact-path cleanup.

## Remaining blockers and limits

- No 30-minute idle or sustained windows were executed.
- Physical power remains blocked: `powermetrics requires superuser; no calibrated external AC meter authorized`. Every power artifact is blocked with no samples.
- Application WebSocket payload/frame bytes only; handshake/control frames and TCP/IP bytes are excluded. Loopback is not Internet, Wi-Fi or last-mile evidence.
- `nettop` matched zero worker rows; `iostat` is whole-host only. Per-process physical disk counters and fsync latency remain unavailable.
- `node:crypto.randomBytes` fixture values are nondeterministic; runs are not exact business replays. No deterministic seed retrofitting or draw discard occurred.
- Prices, budget, value and affordability remain pending. E2 remains blocked by aggregate windows and power. E3 requires separate owner authorization.

**Parent can proceed to baseline independent review** of the 20-run evidence, run isolation, scenario/readiness behavior, privacy and accounting. No E2, production or K/R acceptance is claimed.
