# RSO5 unified independent-process 20-run matrix receipt — DEC-008

**Status: 20/20 unified diagnostic runs complete; independent review may proceed; E2 blocked; no K/R or economic acceptance.** No 30-minute windows, production deployment or campaign was run.

## Frozen harness and preserved history

Command:

```
node scripts/rso5-economic-matrix-driver.mjs
```

All 20 runs used one frozen source-hash manifest and one harness identity. No source edits occurred during execution. `delivery/results/econ-matrix-mixed-version-invalid.json` preserves the earlier matrix as mixed-version invalid diagnostic history, not a unified baseline. No previous artifacts or hashes were deleted or overwritten.

Unified identities are exclusive `unified-*` runs. Frozen preregistered order, seeds, scenarios and analysis are unchanged. `node:crypto.randomBytes` values remain nondeterministic; runs are not exact business replays.

## Per-run outcomes

Every run used 52 independent workers with clean stops and zero survivors. Power JSON and CSV are blocked with no samples. Each run has manifest, summary, process, disk, network, work, cleanup, authorization, owner-assumption, decision and power artifacts; new-view readiness artifacts are present wherever new-view groups execute.

| Order | Unified run | Scenario | Work bytes | Messages |
| ---: | --- | --- | ---: | ---: |
| 0 | `unified-local-04` | local-loss | 689,351,732 | 19,039 |
| 1 | `unified-new-view-04` | new-view | 102,221,003 | 5,115 |
| 2 | `unified-local-05` | local-loss | 689,255,396 | 19,039 |
| 3 | `unified-return-04` | returning | 487,248,843 | 14,035 |
| 4 | `unified-return-03` | returning | 487,283,399 | 14,035 |
| 5 | `unified-new-view-03` | new-view | 102,221,003 | 5,115 |
| 6 | `unified-new-view-05` | new-view | 102,221,003 | 5,115 |
| 7 | `unified-local-02` | local-loss | 689,317,176 | 19,039 |
| 8 | `unified-cold-05` | cold | 242,138,343 | 9,897 |
| 9 | `unified-return-02` | returning | 487,310,623 | 14,035 |
| 10 | `unified-local-03` | local-loss | 689,289,952 | 19,039 |
| 11 | `unified-cold-04` | cold | 242,103,787 | 9,897 |
| 12 | `unified-cold-03` | cold | 242,138,343 | 9,897 |
| 13 | `unified-return-05` | returning | 487,345,179 | 14,035 |
| 14 | `unified-cold-02` | cold | 242,103,787 | 9,897 |
| 15 | `unified-new-view-02` | new-view | 102,221,003 | 5,115 |
| 16 | `unified-return-01` | returning | 487,345,179 | 14,035 |
| 17 | `unified-new-view-01` | new-view | 102,221,003 | 5,115 |
| 18 | `unified-cold-01` | cold | 242,103,787 | 9,897 |
| 19 | `unified-local-01` | local-loss | 689,351,732 | 19,039 |

All runs are diagnostic PASS. Five cold, five returning, five new-view and five local-loss runs completed. Local-loss recovered 820 proofs with 820 signed logical process-held copy audits. Every new-view group completed post-newView startup and durable serving readiness.

## Aggregate recomputation

| Metric | Unified aggregate |
| --- | ---: |
| Separate work metric | 7,604,826,829 B |
| Request+response envelopes | 240,430 |
| Application payload bytes | 1,429,623,281 |
| Application WebSocket frame bytes | 1,431,083,271 |
| Worker user CPU | 408.574828 s |
| Worker system CPU | 132.099268 s |
| Maximum sampled process-tree RSS | 179,683,328 B |

Traffic was reset before each lifecycle. Envelope counts use one semantic: request+response envelopes, with authentication refusals separate and no response envelope. Per-run edge messages, payload bytes and frame bytes equal their summaries. Aggregate rows equal the sum across runs. Work is independently recomputed as `sum(roles.used_bytes)` in each run.

`delivery/results/econ-unified-evidence-hashes-final.json` binds 254 artifacts: execution, frozen plan/manifest, baseline and every run's manifest, summary, process, disk, network, work, cleanup, authorization, owner assumptions, decision, power JSON/CSV and all present new-view readiness files. `delivery/results/econ-unified-review-hashes.json` additionally binds this receipt and mixed-version history.

## Remaining limitations

- No 30-minute idle or sustained windows were run.
- Power remains blocked: `powermetrics requires superuser; no calibrated external AC meter authorized`. No samples or energy estimates exist.
- Application WebSocket payload/frame bytes exclude handshake/control frames and TCP/IP bytes. Loopback is not Internet, Wi-Fi or last-mile evidence.
- `nettop` matched zero worker rows; `iostat` is whole-host only. Per-process physical disk counters and fsync latency remain unavailable.
- RSS sampling is best-effort on one host. Logical process-held copies are not physical devices or crash-durability proof.
- Prices, budget, value and affordability remain pending. E2 remains blocked by aggregate windows and power; E3 requires separate owner authorization.

**Independent review can proceed** on the unified 20-run evidence, scenario/readiness behavior, privacy, resource accounting and complete artifact coverage. No E2, production or K/R acceptance is claimed.
