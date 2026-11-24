# DEC-023 fresh idle resource review — 2026-11-24

## Verdict

**K7 idle CPU fails. Memory results are useful diagnostics but are not yet qualified fixed-cardinality sustained evidence.** Do not authorize a full nominal/idle rerun campaign yet. First make the small final-cardinality measurement correction and complete one coherent offered-load/CPU/latency correction block.

Artifact SHA-256 is `6eaa4c8d4e00c4024db68c308e52aca686b1bc1ce0254f9c1d96432fdc32d07b`; source log SHA-256 is `434e3e7c52014f67e41c353af8d89933b0b95fa949430d745ea76f3e639028c6`. The log agrees with the artifact. No production or K1–K8 acceptance follows.

## Valid local K7 conclusions

- Duration: **1,801.690 s**, with 361 five-second samples.
- Idle CPU: **98.257251 s = 5.4536% of one core**, decisively above the unchanged 1% target.
- Per-relay peaks: **282.266–322.562 MiB**, all below 512 MiB.
- Aggregate peak: **1.548 GiB**, below the 2 GiB measured startup envelope. Nine early samples exceed 1.5 GiB; later RSS is substantially lower.
- Mean aggregate RSS: **401.0 MiB**. The final timed sample is 286,392,320 B.
- Disk shows no material growth: sampled peak and final are both 373,038,849 B.
- Physical idle power remains unmeasured; CPU seconds are not watts.

These are local macOS observations, not reference-hardware or independent-host qualification.

## Sustained cardinality is not established

The harness checks `leasedActivePublications === 10000` only during initial stats at `packages/eval/src/client-held-local-resources.ts:1246`. Final stats are collected but their active cardinality is neither checked nor recorded. `fixedActivePublicationsPerRelay: 10000` is therefore a configuration declaration, not final-state evidence.

The seed expires about 22.9 hours after this run, so lease expiry does not explain the RSS decline. The decline from roughly 296–338 MiB per relay at startup to 23–28 MiB in the last timed sample is consistent with transient GC and OS RSS reclaim, not proof of record loss. Final stats rising to about 112 MiB per relay is consistent with fresh stats/active-record allocation; exact causes require profiles.

The smallest measurement correction is to require every relay's final active count to remain 10,000, record initial/final counts and a stability result, and record signed lease expiry relative to the measured window. Do not add per-sample full active-record scans, which would increase idle CPU. Initial/final checks suffice here because no user writes occur and signed expiry lies outside the window.

## CPU contributors

Exact attribution is not yet recorded. Read-only inspection identifies:

- Each relay samples RSS every 250 ms.
- The parent recursively walks and stats the persistence root every five seconds. This root contains approximately 61,255 files, causing roughly 22 million file visits over the idle run.
- Each relay performs durable traffic checkpoints every 30 seconds. These ordinary-maintenance writes must remain enabled.
- Five-minute cleanup, publication expiry and journal-compaction checks also remain active.

The first two are measurement overhead; the latter are required maintenance. Record per-process CPU deltas before optimizing rather than suppressing maintenance to pass.

## Next coherent correction deliverable

Without changing operation counts, deadlines, quotas or production rate limits:

1. **Offered-load pacing:** preserve 1,002 operations, two coordinators, five replicas and all failure accounting, but schedule offered publishes within the unchanged 10/minute/source-IP relay limit. Pacing occurs before operation submission and must not extend original deadlines or reclassify refusals.
2. **Idle CPU:** add parent/relay CPU attribution, reduce recursive disk-scan and fixture-sampling overhead, preserve all ordinary maintenance, and add the final-cardinality assertion.
3. **Mailbox/operation latency:** profile synchronous mailbox journal scanning/compaction and connection setup. Mailbox p95 was 7.713 s, overall p95 6.810 s, with one deadline exceeded. Move non-critical compaction off the synchronous request path only while preserving per-acceptance fsync and atomic recovery.

After focused correctness/resource controls and a smoke run, reassess whether fresh idle and nominal qualification are justified. Existing K1 failure, idle CPU failure, missing sustained-cardinality proof, absent physical power and all external K2–K8/deployment blockers remain unchanged.
