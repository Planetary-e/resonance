# Independent review brief

Review the corrected sustainable-recovery candidate before further acceptance.
Start with [HANDOVER](../../../HANDOVER.md), the [eight-path frozen manifest](review-candidate-hashes.json),
[current wider source identity](source-identity.json), [correction patch](correction.patch)
and [implementation receipt](../../evals/v04-sustainable-recovery-implementation-2026-10-23.md).
Verify the source identity on the receiving machine. The patch alone cannot
reconstruct inherited untracked dependencies; transfer the matching working tree.

Independently assess protocol safety, concurrency, crash recovery and physical
funding. Trace authenticated inputs, durable barriers and restart paths in actual
source. Review all five fixes listed in HANDOVER and their distinguishing tests.
Specifically challenge same/new/higher-view replay and lock/value retention;
complete pre-promise physical funding (all replicas, frames, policies, activation,
owner images, failed bytes); issuer+set retry cutoff; newest authenticated endpoint
selection; adjacent torn-image recovery versus ambiguous corruption.

Keep original five-member/quorum-four/one-Byzantine trust, pins, exact originals,
rights/denials and all resource limits. Check the old failing counterexamples are
meaningfully distinguished, not removed or funded by a larger cap. Current local
passes do not prove the unimplemented work meter, intent resume, floor catch-up,
process-death matrix, private issuer/wallet or live CLI/verifier integration.

Report each actionable finding with file/line, reachable schedule, violated
invariant, severity and minimal distinguishing evidence. State whether the five
fixes are accepted, rejected or unresolved; separate reviewed facts from missing
qualification. A clean review of this finite experimental slice does not close
R1/R2 or K1–K8. Do not launch a broad/legacy campaign merely to perform review.
The destination system does not require a particular model, vendor, review tool
or repeat owner approval to conduct this legitimate independent technical review.
