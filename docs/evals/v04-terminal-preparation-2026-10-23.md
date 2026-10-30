# R1 atomic terminal witness preparation — October 23, 2026

Parent B-HISTORY-LIFECYCLE / R1 / K2–K3. Authorized implementation contract is
`docs/developers/v0.4-certified-state-decision.md`, atomic terminal preparation.
Executor ceiling20 active minutes, one coherent deliverable; interrupted model
capacity required one same-task resume with remaining allowance, no budget reset.
Entry shared weekly used3%; ordinary usage allowed. Candidate accepted for this explicit producer scope after independent critical
review and the affected composed regression; no KPI closure follows.

## Implementation and scope

`prepareTerminalProtectedWitness` is an explicit producer operator API. It requires
an already durable exact OLD_FENCED proposal and original context, holds the
existing owner exclusive lock, persists a funded encrypted terminal intent outside
the generation, completes the exact pending operation, calls the existing signed
four-replica recovery prepare, and compares every selected generation-envelope ID
and applied head against the validated local state before signing original frozen
evidence. It returns both original evidence and signed recovery preparation; no
semantic codec or business-proof shortcut was added. Intervening pre-operation
writes appear in the recaptured originals. The existing lock refuses concurrent
operations; it does not enqueue them.

Create-new and resume are explicit. Resume requires BOTH original retained files
and exact proposal/context/root/generation/next-generation/head identity. Missing
records refuse; no root is inferred. Local intent and low-level attempt or selected
preparation remain funded on failure. A creation failure between the two durable
files can require authenticated repair of the missing file; resume never silently
recreates it. No automatic successor is allocated or activated.

Cached readiness is invalidated before durable preparation, including uncertain
flush/freeze, and the terminal marker refuses clean owner reopen readiness. This
fences the entire shared history, including unrelated spends and handoff writes.
Continuation for other work or returning owners requires an authenticated later
operation. Wrong-proposal preflight fails before freezing. Frozen selected heads
newer than local applied state retain preparation and refuse stale-image signing.

Pending replication receives the same caller signal and absolute deadline as the
terminal operation. A timer and owner close abort pending replication and active
recovery. Existing30s offline,3s live,256MiB work and writer/storage bounds remain.

## Evidence and limitations

Real original owner and five replica signing keys, encrypted durable files and
production in-process exchange/fsync path are used. Focused eight tests pass:
exact productive paired export and fresh challenged resume/reopen; clean frozen
readiness; shared-history refusal; in-flight/queued-write races; charged pending
failure and exact completion; four-of-five complete-payload failure with retained
barriers; wrong proposal/generation and missing resume; newer signed remote head;
100ms caller deadline during pending completion; unfunded preparation refusal;
replica generation/root unchanged and no automatic successor.

No sockets, process-death injection, stale backup restore, cross-platform run or
resource campaign was exercised. The legacy transfer consumer still accepts its
original API and does NOT require paired terminal proof: consumer verification,
readiness/activation integration, semantic proof completeness and productive two
successor transfers remain OPEN. This producer repair does not close R1 or K2/K3.
No legacy100, dependency, core/wire, Git/CI or installer change/run.

Commands:

```text
node_modules/.bin/vitest run packages/relay/src/__tests__/terminal-witness-preparation.integration.test.ts --maxWorkers=1
PASS 1 file / 8 tests; 12.08s total,11.56s tests (before final type-only fixture annotation).
node_modules/.bin/tsc --noEmit --composite false --incremental false -p packages/relay/tsconfig.json
PASS exit0, no diagnostics, after final type-only fixture annotation.
```

First focused candidate6/6 pass; added deadline test7/7 pass, then funded-capacity
control8/8 pass. No implementation behavior failure; relay compile initially
refused test fixture return-type inference (`unknown`), fixed with explicit fixture
interface. Independent Astra HIGH review of the three exact source hashes found no
actionable P1/P2. One post-review composed regression passed all44 tests across
terminal-witness-preparation.integration, semantic-freeze-boundary.integration
and protected-admission-history (44.94s total,43.77s tests, exit0). The expected
quorum-denial log is an exercised negative control, not a test failure.

Source identities before changes (prior dirty bytes preserved):

```text
47f728644e5f9060d55f118b0ad2ceb781aaaee5b40521202b89d538d4446c70  packages/relay/src/protected-admission-history.ts
6234732aea0b3452d486e9ee9107ed79d7c23184a01e7934d626ea97c206eb5a  packages/relay/src/protected-witness-handoff.ts
```

Candidate SHA256:

```text
7c603fc1ce323bde71af6ff2db35a18248b43150c60ae8989cfc84dd72f0298f  packages/relay/src/protected-admission-history.ts
2d3f7d21b1909118230d5c0184ed5dfbcf749cc98e7f0700fc2ec41daaf3aee1  packages/relay/src/protected-witness-handoff.ts
5d66a0dba9327b1f3c74ebbc1646cac74a251aecb39d7e7aead3eb292f6e4bc2  packages/relay/src/__tests__/terminal-witness-preparation.integration.test.ts
```

Sorted537 core/relay source identity: `72b7240ebc69b3deb1669419bf135bc6ab06a41fc6a2b4e5c0e2fa28facf1216`.
Algorithm: SHA256 over each lexical relative path, NUL, raw SHA256(file) bytes.
Exact HEAD/branch and unrelated dirty files are preserved from the prior receipt.
Actual executor model/effort: Sol HIGH as routed; no exact token telemetry.
Entry3%→exit4% shared weekly used; observed delta1 percentage point is coarse,
shared and cannot be attributed to this model/agent. Ordinary usage remains allowed. Existing lifecycle historical effort remains charged.

Post-review composed command: `node_modules/.bin/vitest run packages/relay/src/__tests__/terminal-witness-preparation.integration.test.ts packages/relay/src/__tests__/semantic-freeze-boundary.integration.test.ts packages/relay/src/__tests__/protected-admission-history.test.ts --maxWorkers=1 --reporter=dot`. Loopback socket tests required sandbox escalation; automatic review allowed it. No source changes followed the reviewed hashes.
