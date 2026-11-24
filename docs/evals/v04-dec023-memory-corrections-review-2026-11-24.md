# DEC-023 memory and persistence correction review — November 24, 2026

## Verdict

**ACCEPT FOR NOMINAL RE-RUN.** The reviewed memory/persistence corrections preserve evidence and durability while removing measurement duplication and whole-journal/snapshot allocation patterns. This is focused correctness evidence only, not a measured memory improvement or production acceptance.

## Corrections

- Relay stats use the live leased cardinality rather than constructing a second full store.
- Artifacts include production implementation and seed-data hashes, module-entry and post-load ready RSS/peak evidence, and explicit `preExecMeasurementAvailable: false`.
- Valid legacy base/matching snapshots remain byte-for-byte authoritative while an empty fsynced incremental log/marker is initialized; no complete evidence rewrite is required for migration.
- Bounded JSON writing preserves temporary-file fsync, rename and directory-fsync barriers without a full-string plus full-Buffer duplicate.
- Incremental replay parses each operation once and rejects a cached `createdAt` that differs from the signed timestamp.
- Mailbox startup streams 64 KiB chunks with byte-accurate offsets. Compaction uses two record-at-a-time passes before fsync/rename/directory fsync and reload.
- Journal offsets and required live lease/quota state replace a second retained parsed journal. Withdrawal, replay, ACK, conflict, quota and torn-suffix behavior remain intact.

Production rate limits, outbox caps, workload and acceptance thresholds remain unchanged. No distinct-source-IP topology or increased publish quota is claimed.

## Validation

- Focused persistence/mailbox/live/process/resource controls: **80/80 passed**.
- Development smoke: **6/6 good operations**, exact replay succeeded, and validation failures were empty.
- Actual-source TypeScript noEmit, build and `/opt/homebrew/bin/git diff --check` passed.
- Independent review accepted a fresh nominal measurement.

The nominal artifact was not modified during these focused corrections. New full-scale measurements are required to determine actual memory, throughput and latency outcomes. No production/K/R acceptance is inferred.
