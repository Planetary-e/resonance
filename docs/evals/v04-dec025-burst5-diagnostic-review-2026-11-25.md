# DEC-025 burst5 diagnostic review — 2026-11-25

## Verdict: REVISE before a three-run campaign

The deadline-instrumented diagnostic is operationally clean and its identities verify. It is preserved separately as evidence of corrected burst behavior. The existing peak-memory gate still fails, so a full qualification campaign is not yet justified.

- **1002/1002 good**, with zero refusals, uncertainties, inconclusive results or deadline exceedances.
- p95 **3,750.600 ms**, p99 **3,825.914 ms**, maximum 4,008.084 ms.
- Publish, search and mailbox each 334/334 good.
- No validation, reconciliation, contention, exact-retry or content failures.
- Network **96,127.919 B/good**, zero coverage mismatches.
- Disk final = actual 380,795,905 B.

Aggregate and post-load-ready peak are **1,914,650,624 B = 1.783 GiB**, below the 2 GiB measured startup envelope but above the existing 1.5 GiB `processTreeRssPass` threshold. Maximum relay peak is **386,777,088 B = 368.83 MiB**, below 512 MiB. Final aggregate is **1,060,929,536 B = 1.012 GiB**.

The peak equals post-load ready, indicating startup/allocation-bound memory rather than runtime growth. This does not change the summary result.

Artifact SHA-256: `aa708d04f5822f76ac7620768238c05ab031b7bb98d914a7297de617fe840354`; log `91b9cc3c70271834f6996b7c2837729351c39435591b59234bc6cce628eaca4b`; seed `6d2cbe3c4deb64f396163b2bbae63a221f63b379a05e78360472d99a8d4e1739`.

## Next action

Perform a focused startup-memory correction or further bounded allocation diagnosis, then run one fresh diagnostic that preserves the clean operational result and clears the 1.5 GiB peak gate without weakening measurement or workload constraints. Only then is a three-run campaign justified. No production or K/R acceptance is implied.
