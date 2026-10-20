# Scoped fingerprint real-text evaluation

Measured 2026-10-18T03:36:31.843Z using the cached nomic-ai/nomic-embed-text-v1 FP32 model with remote downloads disabled.

50 labeled positive pairs, 50 labeled negative pairs, 100 unique needs and 100 unique offers. Matching uses the application's actual need rewriting and embedding path. Threshold: 0.65.

| Projection | Recall | Negative-pair false positives | Balanced-fixture precision | Recall at 5 |
| --- | ---: | ---: | ---: | ---: |
| pilot-static-v1 | 100.0% | 96.0% | 51.0% | 96.0% |
| public/2026-09 | 100.0% | 78.0% | 56.2% | 92.0% |
| community-comparison/2026-09 | 100.0% | 94.0% | 51.5% | 92.0% |
| public/2026-10 | 100.0% | 98.0% | 50.5% | 94.0% |
| community-comparison/2026-10 | 100.0% | 78.0% | 56.2% | 94.0% |
| public/2026-11 | 100.0% | 94.0% | 51.5% | 94.0% |
| community-comparison/2026-11 | 100.0% | 94.0% | 51.5% | 92.0% |

Retrieval ranks labeled target offers among the distinct corpus offers; corpus order breaks equal-score ties.

| Scope pair | Direct equal hashes | Mean direct similarity | Reconstruction top 1 | Reconstruction top 5 | Known-text unique identification |
| --- | ---: | ---: | ---: | ---: | ---: |
| public/2026-09 → public/2026-10 | 0/100 | 0.497461 | 97.0% | 100.0% | 100.0% |
| public/2026-09 → community-comparison/2026-09 | 0/100 | 0.487578 | 95.0% | 100.0% | 100.0% |
| public/2026-10 → public/2026-11 | 0/100 | 0.488867 | 86.0% | 100.0% | 100.0% |

Chance top-1 matching is 1.0%. Reconstruction receives only public projection matrices and fingerprints, with target order reversed and ties scored conservatively. The dictionary attack knows the candidate texts, recomputes their public fingerprints, and requires unique identification in both scopes.

## Predetermined gates

Quality must lose at most five percentage points of recall/recall-at-five, and add at most five points of negative-pair false positives, relative to the pilot. Result: **pass**. This relative gate does not establish adequate absolute quality: 48/50 labeled negatives pass the pilot's fingerprint threshold. Both linking attacks must stay at or below 5% top-1 identification. Result: **fail**. These are engineering screening criteria, not a formal privacy guarantee.

## Resource measurements

Model initialization: 0.51 s. Embedding: 2.89 s. CPU: 15.349001 s. Process lifetime peak RSS: 1026.0 MiB. darwin/arm64, Node v24.19.0.

## Limits

- Fixed small English labeled fixture, not a representative deployment or multilingual quality study.
- Relative quality preservation is not absolute matching adequacy: the current threshold admits many labeled negative candidates, before any later confirmation.
- Balanced-fixture precision is not estimated real-network precision; unannotated cross-pairs are not labeled negatives.
- Dictionary linking requires unique identification in both scopes and assumes the exact text is in the candidate corpus; it does not estimate arbitrary-world guessing probability.
- Reconstruction attack uses only fingerprints/public matrices and the same candidate population at both scopes; churn is not modeled.
- CPU time and process RSS do not measure device energy, full-app memory or Internet traffic.
- Scopes are public deterministic transforms, not encryption or differential privacy. No live protocol behavior is changed.

The companion JSON records model-file and dataset hashes, exact per-pair ranks and all measured counts.
