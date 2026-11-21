# DEC-018 production resource rebaseline review — November 21, 2026

## Verdict

**REVISE — do not adopt the proposed contract as written.** The costing model is useful and most arithmetic is correct, but it is not yet a complete evidence-based production contract. The deployment model is provisioned infrastructure rather than lightweight personal volunteering. No existing rejection is reversed and no implementation or production acceptance follows.

The proposal is `docs/developers/v0.4-production-resource-rebaseline.md`; authorization is `delivery/decisions/DEC-018.md`.

## Verified object sizes and source floor

Canonical fixed-length source objects produce:

```text
one vote                                      555 B
four-vote certificate                       2,247 B
coordinator request                           562 B
binary accept = 17+562+2,247                2,826 B
five-vote binary accept                     3,382 B
four-vote framed accept                     3,347 B
five-vote framed accept                     3,903 B
```

The independently confirmed accept-generated lower bound remains 1,024 decoded B per four-vote certificate, 10,240,000 B per 10,000-row copy and 40,960,000 B across four raw copies. Distinct spends prevent identical-claim deduplication.

## Physical model arithmetic

The proposed values recompute internally:

- C model: 192,074,801 B/copy; 76,360,655 B headroom under 256 MiB.
- D model: 394,529,828 B; 142,341,084 B headroom under 512 MiB.
- P model: 19,693,236 B; 13,861,196 B headroom under 32 MiB.
- F=P gives the same modeled failure headroom.
- L model: 1,127,038 B; 970,114 B headroom under 2 MiB.
- Entry model: 7,444; 8,940 headroom under 16,384.
- Metadata model: 17,889,616 B; 15,664,816 B headroom under 32 MiB.
- Additive aggregate model: 5,993,264,734 B; 2,596,669,858 B headroom under 8 GiB.

These are not closure proofs. Delegation cardinality, failure/orphan counts, standalone activation size, SMT representation, simultaneous failures, migration credits and actual reservation paths are unbounded or model-dependent. The aggregate is deliberately no-credit and may double-count overlapping obligations.

## Work and cumulative model

Corrected cold arithmetic is:

```text
10,000 imported accepts                 442,800,000 B
availability                             15,360,000 B
100-configuration materialization     2,373,304,320 B
remaining listed terms                       97,627 B
Cold                                  2,831,629,947 B
4 GiB headroom                        1,463,337,349 B
```

The cumulative schedule totals 4,085,909,203,335 B; 4 TiB leaves only 7.64% and 8 TiB leaves 115.28%. These are not lifetime bounds. Inherited copy/materialization multipliers, actual index reconstruction and changed-path persistence remain unmeasured.

C models 201 retained delegations, while cold charges restoration equivalent to three bundles. No proof establishes that three restorations open every retained historical proof. The cold model therefore is not demonstrably complete.

## Network and deadline correction

Ordinary one/two attempts are 750,374/1,500,748 B; issuer-wide one/two attempts are 1,755,404,964/3,510,809,928 B. Two attempts are arbitrary failure coverage and exclude TLS, discovery, packet loss and observer traffic.

The statement that two approximately 1,024,161,536 B recovery attempts exceed 2 GiB is a unit error:

```text
2*1,024,161,536 = 2,048,323,072 B
2 GiB           = 2,147,483,648 B
remaining       =    99,160,576 B
```

They exceed 2 decimal GB, not 2 GiB. The underlying recovery estimate also lacks a complete primitive derivation.

Payload-only rates for a 4 GiB exceptional envelope are 11.45 Gb/s at 3 seconds, 1.145 Gb/s at 30 seconds and 114.5 Mb/s at five minutes. There is no evidence volunteers meet these rates after overhead, disk, hashing, signatures, queues and loss. Deadline gates remain unchanged.

## Operational meaning

The additive memory screen is 1,417,493,460 B, leaving 729,990,188 B under a 2 GiB hypothesis. This is not RSS evidence and conflicts with the approved 512 MiB model-free relay target. Co-hosted application/prover memory remains unresolved.

Power cannot be inferred from work bytes. DEC-013 is partial and host-confounded. Labor, repair supervision, storage wear, bandwidth prices and recruitment are unknown. Existing availability arithmetic already requires approximately 99.749% individual availability for one cohort with one permanent withholder and 99.874% for two independent cohorts at a 99% target before common outages. Larger transfers do not improve that arithmetic.

The proposal therefore describes provisioned infrastructure, not casually available personal volunteers.

## Owner decision

Do not adopt these numbers as the approved production contract yet. Choose the product/deployment direction first:

1. Preserve exact evidence retention and 10,000-row semantics by explicitly evaluating provisioned infrastructure and obtaining missing operational/economic evidence.
2. If lightweight personal-volunteer operation is immutable, change product scope or suspend this line rather than merely enlarging numeric caps.

No rebaseline revives RSO7/RSO8/RSO9, proves reducer safety or establishes affordability. No implementation, production routing or R1/R2/K/R acceptance follows.
