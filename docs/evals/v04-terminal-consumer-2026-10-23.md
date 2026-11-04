# R1 terminal consumer enforcement — October 23, 2026

Status: bounded consumer implementation and focused evidence PASS; independent
Astra HIGH review found no actionable P1/P2, composed47/47 PASS. Full productive lifecycle and
R1/K2/K3 remain OPEN. This is not integrated product acceptance.

Parent: B-HISTORY-LIFECYCLE / R1 / K2–K3. Existing <=20 active-minute consumer
allowance, historical effort retained; no new campaign/budget authorization.
Execution routed Sol HIGH. Entry/exit shared weekly usage observed 5%/5%, ordinary
usage allowed; this coarse account counter does not establish per-agent cost or
zero cost. Architecture pause was excluded from active work. No precise active
CPU/model charge is available; work completed within the bounded task window.

## Contract and implementation

Both preparation and independent witness/coordinator installation require four
actual paired producer exports plus separately retained original deployment and
owner-state pins. Pins include original context (owner and five storage keys),
genesis, selected root/generation, successor barrier and exact sequence/head.
Caller must retain these from authentic enrollment/local state; context parsing
or bundle self-assertion never authenticates them. Current explicit CLI supplies
no independent pins and refuses; only explicit APIs with trusted retained pins
provide the productive consumer path. No discovery/authority registry was added.

Every operation verifies actual four distinct same-attempt replica signatures,
selected complete generation and exact original-history suffix, then retains
original full policy/archive/role/vote/certificate/acceptance replay. Missing,
partial, substituted, repeated-owner, unknown-pin and stale inputs refuse before
successor durable readiness. No opaque storage endorsement replaces semantics.

The producer signs a nested commitment to the original descriptor digest and
stable terminal descriptor (root/generation/barrier/ordered selected IDs). Manifest
v2 retains the original digest and selected IDs, allowing durable state parsing to
reconstruct the signed commitment. This additional persistence fixes the discovered
counterexample where a legacy manifest was version-upgraded with arbitrary terminal
rows. Legacy successor manifests reject during the existing image/record/restore
parser path. Receipt challenges can renew without changing manifest identity.
No decryption key was added to manifests. No automatic continuation/activation.

## Evidence

Final focused command:

```
node_modules/.bin/vitest run packages/relay/src/__tests__/terminal-witness-preparation.integration.test.ts packages/relay/src/__tests__/semantic-freeze-boundary.integration.test.ts
```

PASS: 2 files, 10 tests, 22.84s wall; Vitest summed test durations 30.57s reflect
concurrent files, not wall duration. Productive real signed four-owner preparation,
original accepted-row inheritance, witness/coordinator installation, exact successor
reopen/reinstall, fresh challenged producer resume and stable manifest are covered.
The negative matrix checks both preparation and witness/coordinator install before
any state advance. A genuine legacy signed freeze with fabricated v2 rows fails
durable handoff-record parsing. The historical semantic-freeze diagnostic retains
real spend/late-certificate advancement and now asserts bare-prefix refusal.

`node_modules/.bin/tsc --noEmit -p packages/relay` PASS.
`node_modules/.bin/tsc --noEmit -p packages/node` PASS.
Typecheck wall durations were not separately measured.

Rework: initial typecheck caught variable shadowing and implicit test array types;
initial focused 8/9 run exposed premature successor role capture in the new fixture.
Those were corrected. Productive successor starts with no unauthorized captured
role. A later strengthening added nested durable commitment verification; final
focused evidence above supersedes earlier successful runs. No review acceptance
is claimed here.

## Exact candidate and preservation

Checkout `/Users/marcos/Documents/Codex/2026-09-15/i-x20/resonance-v04`, branch
`feature/v0.4-private-transport`, HEAD
`c81d2ac55f083c62127d9ea663a3f2d30b078ffb`. Approximately 80 preexisting dirty or
untracked paths retained; no Git mutation. Pre-delta bytes, per-file patches, logs
and before/after hashes are under `/tmp/v04-terminal-consumer-2026-10-23/`.

| Source | Before SHA-256 | Final SHA-256 |
| --- | --- | --- |
| protected-witness-handoff.ts | 2d3f7d21b1909118230d5c0184ed5dfbcf749cc98e7f0700fc2ec41daaf3aee1 | 64fd50d3bf08d1800c2e8b9df618518e62136ea21a538d98f428daab29c91505 |
| protected-admission-history.ts | 7c603fc1ce323bde71af6ff2db35a18248b43150c60ae8989cfc84dd72f0298f | 85a46cb7639dde4d1d94ae494d92d5d34e8a2902e841a14f91dbb1af3d43f249 |
| witness-handoff-state.ts | 8eee364414312904133ee1245907705473d33629e3ca9cad7e9eb71c5a0f9819 | 3f4f90de2fb8bfafa3bc25b6e86e88449f5b6b8c6fe2979bd77910e3db847493 |
| terminal-witness-preparation.integration.test.ts | 5d66a0dba9327b1f3c74ebbc1646cac74a251aecb39d7e7aead3eb292f6e4bc2 | ef33fcef0b380e9c43c1aaa26059ec826e6e5715d7c9bff74b17a7a36d3021dc |
| semantic-freeze-boundary.integration.test.ts | 924d3d2275284125012228a949f6d417c89e1656a1bb388f1d06746db476dda5 | f2d3f870424e2cb4d8d5563cd5bdcdb69abebc1639189a82fdaa73866e882ac8 |

Documentation changed: consumer design/counterexample subsections in existing
`docs/developers/v0.4-certified-state-decision.md` and this new receipt. Parent owns
completion/roadmap changes; parent appended independent architecture conditions to
the shared decision document. No build/install/CI or legacy100 command was run.

## Remaining blockers and obligations

The ordinary node integration test at
`packages/node/src/__tests__/protected-witness-handoff.integration.test.ts:170`
was not run or claimed passing: its old `witness-transfer-prepare` invocation at
line 216 has no independent pins and now refuses. Its later second-transfer return
also requires an authenticated continuation of the frozen shared owner history.
Do not migrate that by bypassing the barrier or silently skipping the test. The
existing stopped conditional frozen100 campaign remains untouched. Consumer API
passing evidence does not close this integration incompatibility.

Independent review and the scoped composed regression are complete. Full
ordinary node lifecycle integration remains unaccepted as described above. Original-policy completeness, authenticated shared-history
return and productive two-transfer service remain necessary R1/K2/K3 obligations.
Existing limits, original artifacts, trust premises and legacy stopped32/100 stay.

Independent critical review: Astra HIGH, <=5 active minutes, read-only; verified
all five baseline/current hashes and the mandatory paired-proof, separate-pin,
semantic-replay, nested durable commitment and activation paths. No actionable
P1/P2. Did not rerun tests or qualify full lifecycle/policy-proof completeness.
Parent verified all five source hashes unchanged. Sorted537 core/relay source
identity: `f571057a7134307ddfd890a6639159e775a3585be8924b42490619d8023d508e`
(path + NUL + raw SHA256(file), lexical path order).

Post-review composed command: `node_modules/.bin/vitest run packages/relay/src/__tests__/terminal-witness-preparation.integration.test.ts packages/relay/src/__tests__/semantic-freeze-boundary.integration.test.ts packages/relay/src/__tests__/protected-admission-history.test.ts packages/relay/src/__tests__/witness-handoff-epoch.test.ts --maxWorkers=1 --reporter=dot`. PASS4files/47tests,52.37s wall/50.99s tests,exit0. Loopback permission allowed by automatic review. Source hashes unchanged after independent review. This excludes the known incompatible ordinary node lifecycle fixture and the stopped legacy100.

Parent exit observation after review/composed validation: shared weekly6%used,
ordinary allowed (entry5%; executor earlier observed5%). This one-point coarse
shared-account change cannot be assigned to a specific model or agent. Model
routing was Sol HIGH implementation, Astra MEDIUM <=3min architecture decision
and Astra HIGH <=5min independent review; no reviewer correction was needed.
An implementation-detected durable-commitment correction strengthened the initial
architecture assessment before independent review. Historical effort is retained.

Follow-on validation limitation: the operator executor found direct node noEmit
can resolve existing relay dist declarations through project references. The
reported command did pass, but it does not establish cross-package current-source
compatibility. The operator lifecycle block must run a source-mapped noEmit
configuration before accepting the integrated candidate; no stale declaration
success is promoted to current-source proof. Focused/composed Vitest source tests
above retain their separate scope.
