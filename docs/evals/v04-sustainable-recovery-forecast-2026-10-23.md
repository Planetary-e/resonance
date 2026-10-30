# Sustainable recovery: fixed-contract allocation forecast

October 23, 2026; R1 / B-HISTORY-LIFECYCLE / K2–K3. **NO-GO: full physical,
metadata, work and time bounds remain UNKNOWN.** This is deterministic arithmetic
for the integrated proposed architecture, not implementation or qualification.
No original scope, fixture, history, reservation or stopping rule is changed.

Contract: [integrated design](../developers/v0.4-sustainable-recovery-design.md),
SHA-256 `b06067509635a96a97adc3b85da4681d9f65ee986bdb3854ac8656a42d654e14`.
Checkout `/Users/marcos/Documents/Codex/2026-09-15/i-x20/resonance-v04`, branch
`feature/v0.4-private-transport`, HEAD
`c81d2ac55f083c62127d9ea663a3f2d30b078ffb`; HEAD does not identify the dirty sources.
Forecast-time source-set digest:
`7ba85f340931c995ba27daedb66407e3207b7856698aa103cf41686afcb41036`.
`source-hashes.json` records every path/hash and method: SHA-256 of sorted
UTF-8 relative path, NUL, SHA-256 of exact working-file bytes (or DELETED), NUL;
tracked plus nonignored untracked files, excluding this report to avoid circular
identity. Concurrent later edits require a new identity; the frozen design hash
was checked before these results were produced.

Artifacts, all in `/tmp/v04-sustainable-redesign-2026-10-23/`:
`forecast.py`, `forecast.json`, `scope-manifest.json`, `source-hashes.json`.
Reproduce with `python3 /tmp/v04-sustainable-redesign-2026-10-23/forecast.py`.
The script performs integer arithmetic and source identity hashing only. It
checks the sum of all 98 explicit per-scope control allocations against the
closed formula; it does not invoke the application or execute tests/campaigns.
The temporary artifacts need preservation if required beyond the local session.

## Finite feasibility frontier

There are 17 local owners (five observer, ten witness, issuer, wallet), 80
replicas (five for each of 16 protected owners), and one operator: **98 NEW**
scopes. Each protected owner's data is conservatively charged six physical
copies; wallet and operator have one each. Only witness owners 1–5 return.
Their return count is respectively 1 or 50 **per owner**, with six copies each;
the operator also records every return. All owners retain N configuration/
transition frames plus two base frames. Thus the exact chosen control capacity is

`Q(N,R)=98*8192+16384*(98*(N+2)+7*R)`.

Let `DATA=6*sum(2L_i+2D_i+2P_i+C_i+F_i for16 protected owners)`
`+(2L_wallet+2D_wallet+2P_wallet+C_wallet+F_wallet)+X`.
Every variable means physical encoded bytes, including ciphertext/framing and
retained interrupted copies. `C` excludes the new flat control frames already
in Q. Atomic double buffering is already represented by the coefficient 2.
Let `O` be all fresh-authority retained obligations outside the arenas.

| Declared scenario | Chosen control Q (B) | Fresh residual for DATA + O (B) | Prospective legacy residual for DATA (B) |
| --- | ---: | ---: | ---: |
| Two transfers: N=2, R=5 | 7,798,784 | 2,137,579,520 | 260,310,138 |
| Repeated stress: N=100, R=250 | 193,249,280 | 1,952,129,024 | 74,859,642 |

For each row, the byte frontier is the corresponding sum <= residual. Fresh
subtracts the authority's 2,105,344 control bytes from 2,147,483,648 before Q;
prospective legacy subtracts the entire measured 1,879,374,726 baseline (which
already includes authority control), leaving 268,108,922 before Q. There is no
legacy credit for objects copied into the new arenas. Fresh still pays every
retained application obligation; it is not migration of the exhausted authority.
The 250 returns are an explicitly declared repeated pattern, not the universal
meaning of K2's 100 rotation/recovery/compaction cycles.

**Both chosen control capacities fit alone in both cases. Full fit is UNKNOWN.**
A completed physical manifest exceeding its residual rejects this chosen
allocation envelope. This upper-capacity failure would not prove all compatible
architectures mathematically impossible. No unapproved payload cap, deletion,
refund, cross-scope deduplication or larger resource limit is assumed.

## Separate literal gates

Entry capacity: prospective legacy `346+98=444 <=512`, leaving 68 entries;
fresh arenas use 98, leaving 414 before any additional outside allocations.
The exhausted artifact yields `512+98=610`, exceeding capacity by 98. It cannot
add this layout under the unchanged rules; forecasting the earlier baseline
does not reset that artifact. Extra physical owners/wallet replicas/standalone
outside allocations require a revised count before a fit assertion.

Serialized metadata: the 98 NEW entries add at most `98*1024=100,352 B`.
At that ceiling, the old complete serialization plus updated top-level delta
must be <=`1,048,576−100,352=948,224 B`. This is a sufficient literal threshold;
actual shorter entries can be evaluated using their actual encoded total.
Old serialization is UNKNOWN. Fresh also requires its actual top-level and
outside-obligation serialization. Every canonical encoded new path/component/
scope must fit 1,024 B; no original path renaming is assumed. Metadata is a
separate gate and its simultaneous images are already funded by authority control.

Work: `W<=4*(L_selected+D_selected+V_selected+H_selected+J_bootstrap)` and
actual cumulative `W<=268,435,456 B`, so the proposed four-materialization target
requires selected material <=`67,108,864 B`. J is zero only after certified
bootstrap; initial legacy bootstrap includes its complete original closure.
V (needed proof DAG), H (including cold 101-configuration authentication/current
policy), J and actual materialization factor remain UNKNOWN. Full archive
allocation and per-operation selected proof closure are distinct quantities.
One cumulative meter must include every nested decoder/copy/expansion.
The unchanged live 3 s/offline 30 s/recovery p95 300 s time gates require actual
maximum-envelope crypto/disk/network evidence; arithmetic cannot establish them.

## Declared schema and remaining concrete inputs

The manifest has 98 physical-scope records with owner, role, local/replica kind,
copy count, allocation entry, lock, event counts, K, field coefficients and typed
UNKNOWN diagnostics. No unknown value is zero. A scope's missing L/D/P/C/F must
be supplied as an enforced finite encoded maximum. Operator X needs its actual
standalone-copy/interrupted-output workflow. Fresh O needs a complete retained
outside-arena inventory with its entry/metadata costs.

The declared SemanticRow maximum is 2,048 B with 16 direct refs. A 10,000-row
**individual table** has 20,480,000 B header capacity before unspecified
cipher/index/container overhead and separately charged proof objects. Enumerate
all distinct applicable tables per owner in L; the parser default 10,000 is not
a global sum across tables or scopes (`admission-history-records.ts:57,103,129`).
Issuer cardinality is also constrained by its actual policy's `maxPermits`,
whose value is an input (`admission-issuer-ledger.ts:135,215`). Private issuer
claims, wallet catalogues and current-policy mirrors require their own bounds.
A publication count does not supply those inputs.

The 32 suffix slots have `32*16384=524,288 B` declared header capacity per
owner, with 128 refs per slot. D must close actual encoded physical overhead;
original payloads and proof bundles are separate retained objects. ObjectRefs
are 96 B embedded within the bounded headers, not extra duplicate header
charges. ArchiveFrames have 256 B plus exact payload, with physical encryption/
framing still to bound; reference count alone cannot bound referenced bytes.

The finite KPI counts map to event/schema fields but do not supply payload-size
closure: 10,000 active publications maps to declared live application storage;
two nominal simultaneous operations/eight-request bursts to concurrent pending
peaks; >=1,000 faults to interrupted P/F/X and retained retry images; >=1,000
submitted operations/profile over three executions to actual distinct payload
and proof events; 100 cycles to an explicit rotation/recovery/compaction manifest.
None implies 10,000 lifetime claims or bounds every historical original.
A finite event list must identify exact distinct proof objects, authenticated
configuration receipts, owner-private state, all required pins, retained failed
appends, and physical placement/copies. Deduplicate identical bytes only inside
the same physical/privacy scope. No per-return full snapshot is inserted into C.

The direct dependency for a complete forecast is that authenticated manifest,
with enforceable maxima for each listed field, actual old authority serialization,
and maximum selected work closures. Then substitute into the existing equations;
no new ledger, cryptography or experiment framework is needed. In the absence
of those bounds, production implementation and another trial remain NO-GO.
R1/R2 and K1–K8 remain OPEN; prior 32/100, reconstruction and 512-entry stops,
cumulative effort and original fixtures remain unchanged.

Receipt: Sol MEDIUM as assigned; one bounded <=6 active-minute forecast task.
Entry shared weekly usage 11% used/ordinary allowed is parent evidence, not a
per-agent cost or new allowance. Exit account usage and precise agent token
accounting are unavailable here; parent owns the shared receipt and critical
review. No production/design edits, application tests, campaigns, CI, builds,
installers, data acquisition, corpus/model inspection or app invocation.

## Reviewed contract amendment and reproduction

Original frozen forecast/hash above is retained. Two critical P2 clarifications
were applied to the design: authenticated stable-cut selection with state/proof
transfer during view change, and exact independently selected endpoint/durable
floor binding at startup. Same-reviewer narrow recheck confirms both. Additional
control/proof frames beyond prepaid K are explicitly charged in C, never omitted
or silently treated as failed append data; C remains UNKNOWN. The equations and
known-capacity numbers are unchanged.

Reviewed design SHA256:
`8c9047d08925ada0f35ddb7b665cb6491bb2f805fffe80d0fd2c5176ac0d8a00`.
Parent reproduced the forecast in the distinct `reviewed/` artifact directory
without overwriting originals; all four known numeric frontiers are identical.
The reviewed pre-final-doc-update source digest is
`13989a1f75793c686b532dc8732c9b54d7ec1ddb057e0f55c7edd81cc9d099b6`.
Later checkpoint/report/roadmap edits are documentation only and do not alter the
forecast arithmetic. No production/test/campaign/build change follows.

Routing: Astra MEDIUM bounded architecture<=12active minutes; Sol MEDIUM
forecast approximately5active minutes within6; one Astra HIGH critical review
<=6active minutes plus same-finding90s narrow recheck. Two material design P2
clarifications addressed in one round; initial conservative all-R-per-scope
accounting corrected before the frozen forecast. Shared quota observed11%→12%
weeklyused, ordinaryallowed; coarse/shared, not model-specific billing.
Historical effort, counters and previous stopped approaches remain charged.
