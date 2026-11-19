# DEC-015 RSO7 follow-up review — November 19, 2026

## Verdict

**CONFIRM REJECTION.** RSO7 is incompatible with the unchanged original production contract. No further RSO7 revision or implementation spike is justified. Production recovery remains open; no R1/R2, K1–K8, economic or release acceptance follows.

## Decisive physical counterexample

The original reducer permits 10,000 combined votes/certificates/accepted rows/denials, rejecting only counts greater than that limit. Accepted rows cannot be collapsed to latest winners because retry, conflict, split and denial behavior depends on their retained bindings.

The revision's 100 B per-row counterexample is deliberately conservative. An actual minimum reducer-produced `search` row under the existing binary codec is 276 B:

```text
owner                  4 + 43 = 47
issuer presence/value  1 + 4 + 71 = 76
spend                  4 + 43 = 47
action "search"        4 + 5 = 9
binding                4 + 93 = 97
                                276
```

Even using 100 B per row:

```text
one generation: 10,000 * 100 = 1,000,000 B
D limit                                  524,288 B
one-generation excess                  1,475,712 B
```

The complete current+pending accepted-row-only D reservation in the revised document is 2,302,864 B, exceeding D by 1,778,576 B. Page sharing or removing the second generation cannot rescue the design because one generation already exceeds D. Externalization also fails: the row state exceeds C=262,144 B and L/P=65,536 B, and moving it to unnamed aggregate storage would evade the partition contract.

## Repaired finite model

The revision correctly repaired much of the earlier accounting:

- Digest-directed delegation restoration: Restore=79,737 B and local-only 47,202 B.
- Revised cold reserve: 4,587,515 B, leaving 131,077 B under W.
- Local-C recovery: 4,440,292 B.
- Finite cumulative forecast: 230,579,193 B, leaving 37,856,263 B.
- Finite physical C/L/P/D/F: 258,595/3,620/53,864/278,504/5,338 B.
- Current/pending paged snapshots limit the maximum finite failed extent to 5,338 B under F.
- The cumulative mix is correctly 12 non-cut and 12 cut member operations.
- The 34,556 B provenance difference is exactly four later observer-advance records × 8,639 B: the uncapped artifact totals 677,938,671 B and later DEC-012 evidence totals 677,973,227 B.

All displayed record sizes, operation equations, cumulative rows and physical totals recompute internally consistently.

These finite values have limited diagnostic value only. Their 72-entry index, 2,208 B mutation and 65,536 B state exclude the legal semantic state that causes physical rejection. They do not support implementation or production feasibility.

## Residual design defects

The revised new-view record preserves locks carried by four signed view-change records but has only one `selectedNextLock` for additional local locks. Multiple local-only locks cannot all be represented; a future protocol would need a complete selected-lock set or explicit refusal. `newViewQ` formation/signature semantics also need the same precision as other QCs.

The returning-reserve equation omits `PolicyHistory=114,688 B` without an architectural reason. Charging it would produce 2,748,043 B, still below W, and add 458,776 B to the four-row cumulative scenario. This does not change rejection but demonstrates that complete accounting is still not established.

## Owner decision

Close RSO7 as rejected. If production recovery continues, authorize a genuinely different state/recovery architecture capable of representing the original 10,000-row semantics, or explicitly reconsider the resource/partition contract. Do not delete originals, reduce accepted-row capacity, enlarge caps implicitly, substitute research budgets, or claim R1/R2/K acceptance.
