# DEC-017 RSO9 independent rejection review — November 20, 2026

## Verdict

**CONFIRM REJECTION.** RSO9-SMT16 has source-backed evidence-storage and legal-transition failures. Compact verifier roots do not eliminate original evidence or the prover's issuer-wide indexes. No implementation or production/R1/R2/K/R acceptance follows.

This closes the routine RSO7/RSO8/RSO9 representation alternatives under the existing stop policy. Continued production recovery now requires an explicit owner decision on resource/evidence requirements or suspension, not another ordinary representation variant.

## Original evidence C failure

A legal accept-generated history requires genuine certificates with four or five distinct-witness votes. Each vote conservatively requires 256 decoded bytes for witness key, signature, set ID, issuer key, spend and request binding, excluding action, version, kind, JSON and request bytes. Four votes therefore require at least 1,024 B per accepted-row certificate. Distinct spends create distinct signed claims and cannot be deduplicated as identical objects.

```text
raw per copy        10,000*1,024 = 10,240,000 B
raw excess over C                  =  9,977,856 B
four raw copies                    = 40,960,000 B

encoded per copy    10,000*(1,024+265+256)+5,739
                                   = 15,455,739 B
encoded excess                     = 15,193,595 B
four encoded copies                = 61,822,956 B
```

Legacy/local accepted rows need not all originate from an accept certificate, but a legal accept-generated workload does. This qualification does not weaken the counterexample.

## Prover indexes and exact issuer-wide transitions

A verifier may store only roots, but a prover must locate accepted rows by spend and every row for an issuer during retirement/legacy attribution. A and AI or equivalent information remain necessary unless the prover performs a full scan.

```text
minimum dual index  10,000*32 + 10,000*32 = 640,000 B
D index excess                                115,712 B
finite control subtotal                        99,628 B
combined D excess                             215,340 B
```

Actual accepted-row leaves and internal SMT nodes are larger. Removing AI exchanges the overflow for a linear scan.

Legacy attribution removes selected unattributed rows and all rows already attributed to each selected issuer, then installs permanent issuer fences. A legal command can remove 10,000 rows. In this schema:

```text
M(10,000) = 252+98*10,000 = 980,252 B
P excess                              914,716 B
minimum pending NEW_VIEW             997,240 B
minimum materialization work      14,703,780 B
W excess                            9,985,188 B
five-voter key-list network         1,600,000 B
```

The source-backed facts are issuer-wide deletion and linearly many affected keys. Work/network figures are candidate forecasts using inherited materialization and transmission models, not universal lower bounds.

## Recovery and ordinary-case scope

For 10,000 evidence objects, retained per-object availability accounting gives 15,360,000 B, already above W. Published cold, NEW_VIEW, local-C and returning forecasts exceed W by 10,921,723, 10,807,035, 10,774,500 and at least 10,721,145 B respectively. These are optimistic forecast failures dependent on the inherited Rref primitive.

Ordinary 16-proof witnesses, 728 B root bundles, constraint summaries, denial maps and retry outcomes are arithmetically coherent optimistic schemas. The 140,384 B bound applies only to non-deleting ordinary cases and is not a differential reducer proof. Configuration, timing and metadata remain unqualified; metadata has only 38,576 B remaining after 10,000 101-byte entries but is not itself proven over cap.

One correctness defect remains: other-leaf non-inclusion must prove the terminal leaf shares the queried key's path through their divergence. Merely proving an unrelated other leaf exists does not prove absence from another branch. This does not reverse physical rejection.

## Aggregate and references

Four encoded evidence copies plus one dual index total 62,462,956 B; five potential-leader indexes give 65,022,956 B. Aggregate bytes need not exceed 2 GiB, but per-node C/D remains fatal. Entry count need not grow by 10,000 when objects stay in existing reservation scopes.

RFC 6962 supplies append-only Merkle inclusion/consistency, Efficient Sparse Merkle Trees supplies sparse membership/non-membership and caching trade-offs, and CONIKS supplies key-transparency context. None proves Resonance reducer equivalence, authorization continuity, availability or physical fit.

## Owner decision

Close RSO9. Further changes only to verifier representation do not cure the evidence and issuer-wide-transition contradictions. Explicitly reconsider resource/evidence requirements or suspend/stop the production recovery line. Do not delete originals, reduce legal workloads, enlarge caps implicitly or infer implementation/acceptance.
