# DEC-025 final burst campaign review — 2026-11-25

## Verdict: REVISE / STOP-AND-REASSESS

The campaign fails `processTreeRssPass`; do not rerun it hoping for a favorable allocation pattern. Independent review verified artifact, log, source and distinct seed identities.

| Field | Evidence | Result |
| --- | --- | --- |
| Operation count | 3 × 1,002 | Pass |
| Success | **3006/3006 = 100%** | Pass |
| p95 | Max 4,714.762 ms; t95 [3,564.779, 5,238.531] ms | Pass |
| p99 | Max 5,190.658 ms; t95 [3,782.513, 6,016.456] ms | Pass |
| Network | 96,126.003 B/good | Pass |
| Per-relay RSS | Max 363,626,496 B = 346.73 MiB | Pass |
| `processTreeRssPass` | Max 2,141,306,880 B = 1.994 GiB | **Fail** |
| Network coverage/content/disk | All pass | Pass |
| Refusal/deadline-free | Zero such outcomes | Pass |
| Overall burst8 | — | **Fail** |

Run2 is only about 6.18 MiB below the separate 2 GiB startup envelope. Run3 exceeds 1.5 GiB only at runtime. Every exact replay, content operation and disk reconciliation succeeds.

## Allocation analysis

Run2 post-load-ready exceeds run1 by **531,316,736 B**, split almost evenly between ready-relay peak sum (+267,206,656 B) and parent-ready contribution (+264,110,080 B). Parent-ready RSS is 318,521,344 B versus 54,411,264 B in run1 and 30,244,864 B in run3. Run3 adds a separate 216,672,768 B runtime component.

The data does not show proportional live-heap growth: parent-ready heapUsed is 236.1 MB in run1, 254.4 MB in run2 and 246.9 MB in run3; heapTotal is approximately 372–373 MB and ready GC counts 574, 574 and 570. Module-entry RSS is approximately 100–103 MB. This is consistent with allocator/RSS retention and GC timing, not a proven new proportional live-object requirement or external interference.

## Next bounded action

Capture parent/relay heap, external and array-buffer attribution immediately before/after oracle reconstruction and listener startup. Check for accidentally retained per-relay stores, parser buffers, log histories and duplicate canonical operations. Do not force GC. Only if actual duplicate retention is found, apply the smallest fix and run one fresh full diagnostic; otherwise leave resource variability unresolved rather than rerun optimistically. Protected-admission evaluation follows this reassessment.

Artifact hashes: run1 `1419c22deb4b8848231b6bb81eeaef04856d02d6bfda6f74c669ad0210507cd7`, run2 `eef130763126787d87b622b59802f831381a832a3f9a1e72ec29dcbbc71ac1ad`, run3 `77d4b016d1612e6521519769b31a36b5fe76254dc624f88973caeadb5869d361`.
