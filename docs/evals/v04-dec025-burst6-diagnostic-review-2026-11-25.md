# DEC-025 burst6 diagnostic review — 2026-11-25

## Verdict: ACCEPT for a fresh three-run burst campaign

Independent review verified artifact, log, source and seed identities. This diagnostic clears the existing single-run operational and resource gates, so the required three-execution campaign is justified.

- **1002/1002 good**, zero refusals, uncertainties, inconclusive results or deadline exceedances.
- p95 **5,500.558 ms**, 499.442 ms below 6 s; p99 **6,449.646 ms**, below 10 s.
- Maximum good latency 6,854.865 ms; publish, search and mailbox each 334/334 good.
- No validation, reconciliation, contention, exact-retry or content failures.
- Network **96,125.879 B/good**, zero coverage mismatches.
- Disk final = actual 380,795,905 B.
- Aggregate/post-load-ready peak **1,543,045,120 B = 1.437 GiB**, below 1.5 GiB by **67,567,616 B** and below 2 GiB startup.
- Maximum relay peak **314,884,096 B = 300.25 MiB**, below 512 MiB.
- Final aggregate **899,465,216 B = 857.82 MiB**.
- `processTreeRssPass`: **passes** for this diagnostic.

Artifact SHA-256: `54019e33abd3f3bcfea9248f8dae0a7035b34707c8104f0cf1109becc30ba0dc`; log `88e90abd8bd2e85b42a1422b75941d8972686f7a2122cc7fa4f065bdb1a8aeec`; seed `3d4bfa4dbc5fafe44acc315be517fd653207a15015f2f0d41009bd47204c1a0f`.

Proceed with three fresh independent seeds, clean relay directories/processes, unchanged source and thresholds. This diagnostic remains separate and is not substituted for a campaign run. Narrow p95 and memory margins make variability material; one clean run is not qualification. No production or K/R acceptance is implied.
