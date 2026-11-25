# DEC-024 harness finalization review — 2026-11-25

## Verdict

**ACCEPT FOR ONE FULL FRESH NOMINAL RUN FOLLOWED BY ONE FRESH 30-MINUTE IDLE RUN.** This is harness correctness acceptance only, not production or K1–K8 acceptance.

## Preserved failure

The first corrected full run used a fresh 10,000-publication seed and exited after approximately 44 minutes with `Relay exited` during harness finalization. Its failed artifact is `delivery/results/client-held-local-resource-failure-run-nominal-run-1.json`; no successful operation or resource qualification is inferred from its partial execution.

The fixture sent a large final disk-event result and immediately exited. The parent could process child exit before that result and reject the pending stop request. This was a measurement-shutdown race, not proof of an operation failure.

## Correction and independent review

`ResourceRelay.stop()` now awaits the complete stop result before sending a separate authenticated exit command. The fixture remains alive after returning its final disk history and exits only on that command. Parent and child use the same ordered IPC channel, and expected exit has no pending stop request to reject. Unexpected-exit diagnostics retain relay index, code, signal and stderr.

Independent review accepted the two-phase ordering, complete disk histories, unauthenticated-exit rejection and unchanged production behavior. No scheduler, workload, generation-map, persistence or threshold change was made.

## Verification

- Focused shutdown/disk tests reproduced locally: **5/5 passed**.
- Implementer affected regression: **72/72 passed across 14 files**.
- Actual-source noEmit, build and diff checks passed.
- Development full-harness smoke: **6/6 good**, exact replay acknowledged, all five relay histories returned, and nominal/idle disk accounting reconciled exactly at 813,706 bytes.

A new full fresh seed and nominal execution are required; the failed execution is not counted as a qualifying run.
