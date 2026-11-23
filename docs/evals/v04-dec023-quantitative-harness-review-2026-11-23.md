# DEC-023 quantitative-harness review — November 23, 2026

## Verdict

**ACCEPT FOR NOMINAL RE-RUN.** Search validation and per-relay oracle corrections provide a credible measurement harness. No workload or acceptance threshold was weakened, and no production/K/R acceptance follows.

## Corrections reviewed

- Search results are bounded by the requested limit, not required to contain exactly one record. Offer queries correctly search complementary need publications.
- Every result is parsed and checked for distinct publication/generation identity, kind, scope, signature, expiry, current active state and exact generation.
- The complete expected top-10 generation sequence is independently computed, including similarity ordering and truncation. The exact query match must be present.
- Conflict, withdrawal, expiry, wrong type/scope, invalid signature, duplicate identity, false positives and missing expected matches are rejected.
- Each relay owns an independent fixture oracle. Only definite accepted/duplicate acknowledgments advance that relay, in actual settlement order. Partial success is supported.
- Uncertainty is sticky per relay/publication. Dependent validation is explicitly inconclusive without reconciliation rather than blaming a correct committed server result. Submitted counts remain unchanged and good does not increase.
- Replay targets a fully acknowledged original, retains per-relay reasons, and does not hide capacity errors.
- The validator and harness sources are included in artifact identity.

## Evidence

- Validator/partial-success/uncertainty controls: **8/8 passed**.
- Development smoke: **6/6 good**, including two searches; exact replay returned duplicate on all five relays.
- Full affected run: **54/54 passed across eight files**.
- Actual-source noEmit, build and diff checks passed.
- Independent review accepted the corrected harness for a nominal rerun.

The controls include a real relay commit followed by SIGKILL acknowledgment loss, exact committed lookup after restart, and continued inconclusive validation despite the correct server result.

## Remaining qualification

The harness acceptance does not establish production success, latency, memory, power, privacy, independent execution or deployment. Run the unchanged nominal workload, report all failures, and complete three independent executions before any statistical conclusion.
