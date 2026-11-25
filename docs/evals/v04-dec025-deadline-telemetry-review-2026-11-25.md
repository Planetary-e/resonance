# DEC-025 deadline telemetry review — 2026-11-25

## Verdict

**ACCEPT FOR ONE FRESH FULL BURST DIAGNOSTIC.** Independent review confirms the evidence-gap correction without changing operation, workload, scheduler or deadline semantics.

`attachDeadlineContention()` runs immediately after the unchanged `deadline_exceeded` assignment. Successful-but-late operations now retain per-operation phases and bounded relay contention snapshots even without a transport error. Thrown publish/timeout/closed-connection paths share the same helper. Evidence includes sequence, kind, outcome, optional error class, relay occupancy, GC/event-loop/persistence spans and dropped-entry counters.

The sequence-42 regression proves a late mailbox operation with no `errorClass` retains its evidence. Focused tests reproduced locally: **3/3 passed**; implementer affected regression: **77/77 across 15 files**. Actual-source noEmit, build and diff checks passed.

Run one fresh full diagnostic to determine the actual cause of late operations and assess the remaining peak-memory blocker. No production or K/R acceptance is implied.
