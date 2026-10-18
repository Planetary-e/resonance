# V3 policy archive integration

Parent: **B-HISTORY-LIFECYCLE / K2 and K3**. Continue the reviewed page prerequisite
and existing cumulative effort/stop policy. No new trust assumption, resource
allowance, history pruning or restart of the suspended investigation is authorized.

## Observable target

One persistent managed wallet and protected observer, issuer and relay paths
complete 65 real rotations from independently pinned original v1 genesis: first
64 into v2, the 65th into v3 with 65 archived issuer keys and one current key.
After restarting the components, old evidence still validates and a new-key spend
succeeds. Retired issuance, archived retries and already-spent tokens refuse.
This is a composed integration prerequisite, not K2's 100-cycle/1,000-fault gate.

## Reviewed format and integration contract

V3 policy body keeps the existing kind/revision/issuedAt/expiresAt/activeKey and
1–8 current `keys`, replacing inline `archivedKeys` with the complete immutable
archive descriptor. Sign every descriptor field under
`resonance:admission-policy:v3` with the existing pinned authority algorithm.
Retain the existing policy byte ceiling. Initially allow only v2→v3 and v3→v3;
refuse downgrade and fresh v3 genesis. The independent observer context remains
anchored to original v1/v2 genesis: including its own context digest in a fresh v3
genesis would otherwise create a circular definition.

V2→v3 reconstructs the exact chronological archive from authenticated ancestry
and adds only eligible predecessor current entries, unchanged after retry cutoff.
V3 successors preserve the exact prior root as immutable prefix, retain all other
current entries under existing cutoff/pin rules, and compare newly introduced
issuer fingerprints and epochs against the entire archive. No unbounded Set or
complete-archive array is an acceptable substitute for bounded traversal.

Keep legacy policy verification and complete-array helpers explicitly v1/v2-only.
Add runtime v3 refusals to legacy key lookup and successor helpers, not casts.
Distinguish signature/schema validation from an opaque resolved-policy capability
bound to the signed digest, original pins/context, exact transition head and full
verified archive. Provide <=8 current keys, bounded historical lookup and bounded
archive visitation. Missing data means refusal, not absence. Global freshness
continues to require the existing authenticated observer head mechanism.

Extend existing protected observer snapshots with a bounded archive-append payload
containing only newly staged canonical pages (initial pages on migration). Before
advancement/observation succeeds, authenticate the transition and both archives,
reserve all local/replica storage including ciphertext, cache/index and replacement
peaks plus conflict headroom, persist pages and policy together in the existing
protected checkpoint, and obtain four durable confirmations. Pending state is
non-serving after interruption. Offline signatures alone never activate v3.
Reconstruct pages from retained observer ancestry after owner loss/restart;
disposable caches cannot become the only copy. Use bounded page transfer through
the existing authenticated observer transport. Preserve original histories.

Consumer integration is required before activation:

- Policy store/rotation resolves before installation/sign approval and binds
  predecessor root/head, archive bytes and reservation evidence in review.
- Observer state/replay/restore/transfer understands append payloads and preserves
  terminal conflict evidence.
- Managed wallet gets a versioned format fence and historical lookup for profiles
  and retirement records; retain existing files and reservations. Its existing
  72-profile limit accommodates this 66-profile scenario only.
- Issuer state and protected replay resolve historical membership/archival before
  exposing reopened state; retain totals and seals.
- Witness/coordinator/spend histories and recovery use bounded lookup/visitation
  for original attribution, votes, certificates and denial fences.
- Setup/activation/restoration/application entrypoints use resolved policy paths
  or explicitly refuse v3. No signature-only fallback.

Asynchronous resolution must finish within existing exclusive operations before
exposing or committing state. Synchronous storage schemas may remain structural.

## Predeclared validation

Use real issuer keys, signed policy advances and actual token operations. Retain
the exact candidate and resource envelope. In addition to the target above,
exercise missing/corrupt pages, omitted ancestry, stale state, reservation
exhaustion, interruption around replication and competing advancement. Refuse or
recover exact pending work. Check one-byte/one-record reservation exhaustion and
policy-conflict preservation at capacity. Do not increase production budgets to
make a fixture pass. Run focused tests during implementation and one final composed
regression after review. A safety counterexample invokes the existing stop rule.

## Remaining 100-cycle dependency

The same wallet needs a funded, versioned paged profile catalogue, stable existing
wallet filenames, bounded wallet opening and paged status output. Preserve all
old profiles/reservations/retirement markers. Retirement-fence metadata also needs
paging if local cleanup is exercised each cycle. This is implementation within
the same design, not permission to increase the old constants.

## Contract review receipt

Astra High: 18:38:49–18:40:16 UTC, 87 seconds, no code/tests. Latest shared weekly
usage observation: 7%; not attributable model/task cost. The review identified no
owner trust decision for the 65-transition contract. Insufficient real storage
funding still requires the existing explicit resource decision.

## Core implementation receipt

Sol High implemented the signed/resolved v3 core at 18:43:01–18:48:05 UTC
(5m04s). Focused validation: **44 tests / five files / 8.06s**, including real
67-key RSA fixtures, 64 authenticated v2 rotations, the 65th archived entry in
v3 and another v3 successor. Existing archive/trust/rotation tests remain green.
TypeScript initially required one explicit union annotation; the build then
passed. That annotation made no runtime change after the focused pass.

Astra High independently approved the frozen candidate at 18:48:41–18:49:23 UTC
(42s), without rerunning tests or modifying code. Module SHA-256:
`6278e18f178d62da46c07fa472ae9b2e0eef0800f1f72a7f6f773fb1f9abc7bf`.
No actionable correctness findings. The composed scenario must additionally
exercise a multi-current-key cutoff-only update followed by later archival.

Core capabilities prove historical validity, not live freshness or funded
publication. Visitor side effects must remain staged until success. Observer,
wallet, issuer, witness/coordinator and spend integration remains outstanding;
the 65-transition core test is not the target composed scenario or a complete KPI.
Latest shared weekly usage observed by the reviewer: **9%**, versus the prior
7% observation; this does not attribute cost to a model or task.

## Observer integration block

The next bounded implementation preserves the existing protected observer writer
and original ancestry. Sol High owns observer state/checkpoints/replay/restoration
and bounded page transfer; no wallet or issuer migration is accepted implicitly.
Acceptance requires authenticated pages and policy in one durable transition,
existing four-copy confirmation, non-serving pending state, missing/corrupt-page
refusal and restoration without depending on a disposable cache. Existing
snapshot, wire and storage limits remain unchanged.

The requested multi-current-key regression now passes: migration retains two
current keys, a cutoff-only update writes no pages, premature archival refuses,
and a later transition archives both keys with the shortened final cutoff.
Reopening from original signed ancestry preserves both archived entries and the
new current key. Focused core v3 file: **10 tests passed / 8.59s**. This is core
coverage only; the protected composed scenario remains outstanding.

### Observer review receipt

Sol High implementation interval: 18:52:47–19:10:44 UTC (**17m57s**).
Seven new integration tests passed, including four-copy replication interruption,
actual durable-download reopening after deleting the original owner directory,
conflict preservation and exact byte/record exhaustion. Existing observer,
restoration, recovery/configuration and command tests were exercised; targeted
regressions were corrected. This is not a claim of one aggregate final run.
TypeScript and whitespace checks passed before review.

Astra High review: 19:11:04–19:13:00 UTC (**116s**). Two P2 implementation
findings require correction: archive-page serving reset its scan budget between
validation and retrieval and omitted the validation signal; final asynchronous
page decoding could return after cancellation/deadline. These require shared
operation accounting and cancellation checks, not relaxed targets or a new
architecture alternative. No provenance/quorum/conflict-preservation defect was
identified by inspection. Acceptance remains pending the distinguishing fixes
and affected regression. Shared weekly counter observed at **12%**, compared
with **9%** at the previous core-review exit; no per-task attribution is claimed.

Remote advance ingestion, legacy policy artifact transfer and desktop activation
still require v3 integration. The local API accepts explicit staged pages; that
does not make the existing remote advance frame support them. The new observer
test is added to the existing three-OS durability CI job with its unchanged
15-minute limit. No installer or activation is requested.

### Observer acceptance after review fixes

Sol High corrected both findings at 19:13:34–19:14:52 UTC (**1m18s**).
Four new cases distinguish cumulative scan exhaustion, cancellation during initial
archive validation, and cancellation/deadline during final page decoding. The
v3 file passed **11/11**; TypeScript and whitespace passed. Astra High approved
the corrections at 19:15:19–19:15:23 UTC (**4s**), without duplicate tests.

Final affected regression on the frozen implementation: `npx vitest run
--maxWorkers=1` with `policy-observer-v3.integration.test.ts`,
`protected-policy-observer.integration.test.ts`,
`policy-observer-history-restore.integration.test.ts`,
`policy-observer-recovery.integration.test.ts`,
`policy-observer-config.integration.test.ts` and
`policy-observer-recovery-command.integration.test.ts` (all under
`packages/relay/src/__tests__/`): **88/88 tests, six files, 97.06s**. Loopback
networking was permitted. This accepts the bounded observer implementation, not
remote v3 ingestion, all consumers, the 65-rotation composed target or a full KPI.
The CI durability list contains 27 unique existing test paths on three OSes.

## Remote observer propagation substep

Continue B-HISTORY-LIFECYCLE with the same original trust/resource contract.
Observable target: an observer advanced locally to v3 serves immutable pages;
another observer receives the signed advance through the existing channel,
fetches only its new pages from pinned observer endpoints and durably advances.
Restart the target and resolve the same original ancestry. Do not put pages in
the existing advance frame or accept peer-selected URLs. Preserve exact selected
heads, predecessor/root binding, existing operation deadlines, cumulative bounds
and exclusive writes. No committed page source means refusal. Missing/corrupt
pages, wrong heads, cancellation and concurrent advancement must not partially
activate the policy. Legacy unsupported consumers remain fenced. This substep
does not authorize desktop activation or establish the final 65-cycle scenario.

### Remote implementation candidate

Sol High: 19:18:01–19:26:24 UTC (**8m23s**). The frozen remote candidate
passes **36 tests / two files / 19.79s**, including the observer v3 and generic
checkpoint-writer files; TypeScript and whitespace pass. The remote operation
uses a shared three-second absolute deadline, at most 16 page requests and a
cumulative byte bound across fallback. Existing replica timeout defaults remain
unchanged. Review and affected regression are pending. Legacy artifact transfer
and collection wrappers remain v1/v2-only and are the next integration boundary.

### Windows CI prerequisite

Published core `46ccfd7` [CI](https://github.com/Planetary-e/resonance/actions/runs/39156269911)
passed the general suite and all macOS/Linux jobs, but two Windows jobs failed.
Six multi-operation tests reached the default five-second test-wrapper timeout.
An issuer crash test expired its initial observation while populating the fixture,
before starting its child process. Production correctly refused that expired
observation.

A separate Sol Medium task owns only the five affected test/fixture areas.
Acceptance is one affected local pass followed by real Windows CI; no local run
qualifies Windows. Preserve production three-second observation and ten-second
private-operation limits, negative expiry assertions and the actual crash/recovery
flow. A deterministic setup clock, restored before exercising crash/recovery,
and explicit individual multi-operation wrapper limits are permitted; no global
timeout, retry masking or production deadline changes. This is a necessary
B-HISTORY-LIFECYCLE/K2-K3 validation prerequisite, not a new protocol alternative.
Shared usage at the recorded task entry was **14%** at 19:27:12 UTC; initial
reading began earlier and its exact duration is unknown.

Windows fixture correction receipt: five test-only files now pass **77/77 tests,
five files, 179.28s** in one serial local-network-permitted run. Parent reviewed
the changes: scoped setup clock restores in `finally` before crash/recovery;
individual wrapper limits preserve operation deadlines and negative expiry
assertions. Actual Windows validation remains pending. Sol Medium observed span
19:27:12–19:30:49 UTC includes test runtime/wait; earlier reading time is unknown,
so this is not an exact active-labor interval. Shared account moved **14%→15%**,
not attributable agent cost. No production files changed in this correction.

Remote review found three P2 implementation issues before acceptance: a silent
first source consumed the fallback deadline; failed transports were not debited
against the response-byte ceiling; repeated post-fetch read-only validation
could outlive cancellation while holding exclusivity. Corrections and specific
regressions are pending. Astra High review interval 19:27:33–19:28:56 UTC (**83s**).
Historical intermediate-head catch-up remains explicitly outside the completed
immediate-head propagation scope.

### Remote propagation acceptance

Sol High corrected the three review findings at 19:31:00–19:34:26 UTC
(**3m26s**). Fair per-source deadline shares preserve the original total; reply
capacity is reserved before dispatch and retained on failure; read-only validation
uses cancellable waits without racing mutation. The focused v3 file passes
**26/26** and TypeScript/whitespace pass. Astra High approved the corrections
at 19:34:44–19:34:55 UTC (**11s**).

One final affected serial regression passed **101/101 tests, six files, 42.65s**:
observer v3, history checkpoint quorum, admission policy observation, observer
configuration, observation batches and listener reuse. Loopback networking was
permitted. This accepts immediate-current-head remote propagation. Historical
intermediate-head catch-up, private artifact/consumer integration and the
65-rotation composed application target remain open.

## Next fixed observer-scale check

Before further consumer wiring, exercise the core 65-rotation boundary through
real protected observers and replication: original genesis, 64 signed v2
rotations, the 65th v3 transition with 65 archived keys, remote propagation to a
second observer, close/reopen and missing-page refusal. Use existing storage and
three-second operation ceilings; fixture setup may have its own test-wrapper
allowance. Record exact failure/evidence without increasing production limits
or silently tuning the scenario. This checks a necessary prerequisite of the
full wallet/issuer/relay target and cannot qualify all of K2.

Protected-observer scale check assigned to a fresh **Sol Medium** implementation
context on clean `42a4af7`. Scope is only new test/fixture files, one fixed
qualification run after fixture checks, no production edits or limit changes.
Shared weekly entry observation is **16% used**; this is an account counter, not
attributable task cost. Two independent five-replica observer histories must use
the enrolled real observer channel and unchanged production defaults.

### Fixed observer-scale result

Sol Medium implemented only the new
`packages/relay/src/__tests__/policy-observer-65-rotations.integration.test.ts`;
parent reviewed its fixture, assertions and unchanged production limits. File
SHA-256 `a8a1d3cedf1560bcc271c5f0f2f2a276380d8558c5408486eec5edd85be2c686`,
baseline `42a4af7`. One permitted-loopback run passed **1/1**, **28.77s test /
29.19s total**, 19:38:58–19:39:27 UTC. The initial sandbox invocation failed at
bind before enrollment and supplied no qualification evidence. Relay TypeScript
passes. No production edits, deadline increases or qualification reruns.

Both observers complete all 65 transitions, with four acknowledged replicas
checked on each step. The final transition transfers two canonical archive pages
separately. Target reopening retains the exact original head; all 66 current/old
keys and pins are checked, all 65 archive entries are visited, and missing/corrupt
persisted migration checkpoints refuse reopening. Detailed per-operation/byte
console output was suppressed in the captured run, so no detailed timing/storage
claim is inferred. Captured output: `/tmp/resonance-observer-65-permitted.log`.
The test joins the existing three-OS durability job without increasing its limit.

This passes the fixed observer prerequisite. Wallet/issuer/relay integration,
historical-head catch-up and K2's 100-cycle/1,000-fault requirements remain open.
Windows follow-up CI for `eece162` now passes all three Windows jobs; the general
CI run is still in progress as of this receipt.

## Historical catch-up implementation contract

Next prerequisite under the same blocker/KPIs: a lagging observer must acquire
an intermediate v3 policy and its immutable pages after the source has already
advanced further. A historical request must prove the exact requested transition
on original retained ancestry and page membership in that historical root. A
page merely present elsewhere in the source's history is insufficient. Preserve
pending/conflict/close fences, exclusive operations, funded ancestry after
restoration, bounded scans and one shared operation deadline. No global freshness
is inferred from historical validity.

Sol Medium owns this established-contract implementation and the bounded signed
artifact/collector integration it requires. Existing legacy core array/parsing
APIs continue to refuse v3; new metadata/transport APIs cannot authorize semantic
installation. Unsupported wallet/application entrypoints remain explicit refusals
until their migration. Personal clients retain the private route. Distinguishing
cases include intermediate-head recovery, wrong transition/fork, later-only page,
missing ancestry and cancellation. No production budget increases or pruning.

### Routing observation

The first bounded receipts support retaining Medium for established fixture/test
implementation: both the Windows fixture correction and the fixed 65-rotation
scenario passed their first permitted final runs and parent review. Protocol
integration still needed independent review: High implementations required one
correction round for two observer findings and one for three remote findings.
These different tasks do not prove model/effort equivalence or attributable quota
savings. Keep scoped review for protocol work and avoid extra review/test chains
when no material concern remains.

### Historical catch-up acceptance

Sol Medium implemented the historical exact-root serving and archived signed
transfer/collector path. The observed work/test interval was
19:44:13–19:49:06 UTC plus earlier unclocked implementation; do not treat it as
exact active labor. A restored-generation test initially omitted its required
`ready()` confirmation; correcting that fixture retained the production refusal.

Astra High review at 19:46:18–19:47:00 UTC (**42s**) found one collector
cancellation/deadline issue before fan-out. The correction bounds both read-only
verification stages by the caller's absolute deadline/signal. Public replay head
inputs are copied before awaiting, and page rescans yield every 16 cumulative
blocks without resetting accounting. A mutation fixture's consumed iterator was
corrected; no production limit or assertion was relaxed. Eight distinguishing
cases passed; Astra approved the corrections at 19:49:22–19:49:29 UTC (**7s**).

Final affected regression: **62/62 tests / four files / 32.57s** with permitted
loopback. Command: `npx vitest run --maxWorkers=1` on core and relay
`admission-policy-transfer.test.ts`, relay
`admission-policy-observation.integration.test.ts` and
`policy-observer-v3.integration.test.ts`. Full `npm run build` and whitespace
checks pass. The private client still uses the legacy assembler at
`packages/node/src/private-relay-client.ts:388`; the next necessary change is
resolved wallet installation and durable proof retention through that private
route. Transport metadata alone cannot install a v3 policy.

## Wallet v6 implementation contract

Astra High bounded contract review: 19:50:13–19:52:30 UTC (**2m17s**).
Implement a funded wallet proof journal, private backfill and resolved installation.
Keep the existing 2 MiB profile snapshot, 72-profile limit, token filenames,
reservations and permanent denials. The snapshot is the sole activation commit.
No owner approval is needed to implement explicit configuration/refusal; actual
activation requires a separately selected existing storage authority and finite
allowance. Session wallet opening currently provides neither. Do not borrow relay
reserves or silently choose a new global allowance. Missing configuration permits
legacy operation but refuses proof migration/v3 installation.

The proof store owns immutable encrypted original-genesis/advance records and
canonical pages, plus bounded non-authorizing backfill progress. Require actual
leases under the pinned authority, account for aggregate ciphertext, interrupted
files, staged records and replacement peaks before creation. Existing wallet file
peaks also remain charged (approximately 16 MiB per token-wallet file); no funding
claim follows from having enough physical free disk.

Install order: authenticate exact predecessor and complete archive; validate
profiles/retirements; reserve/check peak; publish pages and advance durably; create
required empty token wallet; atomically replace v6 profile proof reference; then
publish the in-memory resolved capability. Before activation, staged bytes remain
charged and the previous profile stays installed. After activation, missing proof
or token files refuse reopen. Flush uncertainty poisons the handle.

Reopen streams original signed ancestry with one cumulative core Budget, including
iterator reads/cleanup and page verification, through the manifest's exact head.
Retain existing array snapshot semantics; never collect the complete journal into
an array or restart a budget per transition. New pinned wallets retain genesis
and every advance. Pinned-v5 wallets backfill without changing active policy until
proof equals their exact installed head/body, preserving observed floor/conflict.
Unpinned legacy wallets need independent original observer pins; do not infer them.

Private transport adds bounded original-genesis and archive-page frames via the
existing private destination dispatch/scheduler and fixed configured observers.
A proof-step method returns one signed advance plus at most two appended pages
under one operation budget; metadata alone never installs a policy. Backfill is
bounded and resumable. Keep legacy successor API refusing v3. Wire/fixture work
and journal/wallet work may proceed in parallel only after their typed interface
is frozen and with nonoverlapping ownership.

Acceptance: real 66-profile wallet crossing the 65th rotation, new and pinned-v5
migration, restart, missing/corrupt evidence, publication-boundary interruption,
exact retry/retirement denials, wrong heads, cancellation, and funding exhaustion
before activation. Expired intermediate policies cannot spend before the fresh
observed head is installed. Full K2 and 100-profile paging remain separate gates.

### Wallet implementation dispatch

At 19:56–19:58 UTC the shared weekly counter reports **21% used**, with ordinary
usage allowed (previous recorded observation: 16%). This is not attributable
per-agent usage. B-HISTORY-LIFECYCLE and its cumulative effort/stop rules continue.
Sol Medium owns private transport and its tests; Sol High owns durable wallet
migration, streaming replay and its tests. Their file ownership does not overlap.
The parent owns application integration and documentation; Astra reviews the
integrated protocol changes before acceptance.

Frozen transfer types: `AdmissionPolicyProofCursor` carries the predecessor
`head` and signed `policy`; `AdmissionPolicyProofStep` carries the signed `advance`
and zero to two `{ digest, bytes }` pages. `fetchAdmissionPolicyGenesis` and
`fetchAdmissionPolicyProofStep` accept cancellation and use the existing private
scheduler. The latter verifies the predecessor and derives the appended-page
chain from signed roots/counts under one cumulative operation budget. A returned
step is evidence for wallet resolution, never an installation capability.

The app selects funding only through the explicit
`RESONANCE_WALLET_PROOF_STORAGE_SELECTION_FILE` absolute JSON path. Its version-1
selection pins `authorityDirectory`, `authorityId`, `walletDirectory`, proof
`directory`, `maxCiphertextBytes`, `maxRecords`, and all archive `limits`. The
authority must already exist and the wallet/proof scopes must already be reviewed
through the existing storage adoption/new-scope mechanism. Opening never creates
an authority, approves paths, raises a quota or borrows a relay allocation. The
authority handle remains owned until the wallet closes. The selection fixture
first correctly refused an unadopted authority; the fixture now explicitly
approves its absent test scopes. Three selection/ownership tests pass.

CI at `eece162` finished: all nine three-platform jobs pass; general tests report
**3,210 passed / one failed**. The failure is the default five-second wrapper in
the core v3 cumulative-limit test, which runs six 65-transition replays. Give that
test a 20-second wrapper while retaining each production limit and its 10 ms
stalled-reader assertion. No overall timeout or runtime limit is increased.

Initial application check passes: the actual HTTP API creates a pinned v5 wallet,
advances it privately, then backfills original proof under an explicitly selected
authority and restarts without changing token-wallet bytes (one test, 9.93s).
This is preliminary integration evidence, not acceptance of the wallet change.
Astra's in-progress review identified three implementation gaps: preserving the
independent authority argument during initial funded installation; promoting a
fully staged v5 backfill after interruption; and retaining enough control headroom
to reopen every committed proof store. Corrections and distinguishing tests are
required before committing this candidate. These are unchanged-contract fixes,
not new architecture alternatives or completed KPIs.

### Private proof transport receipt

Sol Medium's observed implementation/test span was 19:57:10–20:04:38 UTC
(7m28s, including test runtime; earlier reading unclocked). The transport is
implemented: exact original-genesis pins, signed predecessor cursor, zero to two
appended canonical pages and private destination dispatch. The unchanged 10-second
operation now also caps proof traffic at 32 socket attempts and 16 MiB of reserved
response capacity, charging discovery at its existing 1 MiB frame cap and private
forwarding at 512 KiB, including failures. These are conservative ceilings, not
measured bandwidth and not satisfaction of K7's 1 MiB target.

Evidence: 48/48 focused core/responder/private/observer cases; final private file
7/7 (18.40s total); original-genesis restart/restoration 2/2; existing private
legacy application 3/3. Initial fixture errors (serving a helper wrapper, forbidden
query-string endpoint, unresolved deferred source during teardown) were corrected
without production relaxation. No outstanding wire finding in Astra's review.

Astra High reviewed the integrated candidate at 20:02:37–20:04:56 UTC (2m19s).
The first three fixes are structurally present but await focused evidence. Three
further P2s require correction: bounded per-record reads including initial genesis
inside the operation budget; authenticated membership for exported resolved
retirement methods; and cancellation/deadline coverage of activation's extra key
import. Persisted proof references must also retain their resource envelope.
The wallet candidate remains unaccepted until these corrections pass.

### Wallet v6 acceptance receipt

Sol High's observed implementation/test interval was 19:57:51–20:11:36 UTC
(13m45s including commands/waits; earlier reading unclocked). Astra's targeted
correction review took 20:10:18–20:10:44 UTC (26s). All initial findings were
addressed; that review found one remaining funded-v5 opening verification outside
the cancellation race. The final correction wraps it in `opening.wait`, preserving
unfunded behavior. The parent inspected the correction and its passing gated
verification/ownership-release regression. No further reviewer chain was needed.

Final composed regression: **114/114 tests, 14 files, 142.10s**, with permitted
loopback and actual process death. It covers core v3/transfer, managed wallet,
freshness/retirement, funded proof, private wallet/proof transport, relay transfer/
observer, and desktop selection/backfill/legacy update/transfer. The command is
`npx vitest run --maxWorkers=1` with those 14 named test files. Logs:
`/tmp/resonance-wallet-v6-final.log`. Tested non-document candidate content SHA-256:
`31c26fbc93c31949c4315e0fafec560c24f75610e4c9161f612d155d5a0edd6f`.
The full build then found a test-only TypeScript cast requiring `unknown` for an
intentionally incomplete mutated authority. That erased type assertion was fixed;
runtime tests were not repeated. `npm run build` and the explicit desktop server
`tsc -b packages/app/tsconfig.server.json` both pass afterwards.

Evidence includes 66 real profiles through 65 rotations, retained token retry
denials, missing/corrupt/oversized proof refusal, exact authority/resource pins,
one-byte/one-record exhaustion, same-cap reopening, cancellation, and an actual
SIGKILL between completed backfill progress and profile activation. The desktop
uses the actual private relay/API path for pinned-v5 migration. New proof and
desktop tests are included in the three-OS CI jobs; their remote result is pending.

Shared weekly usage was 21% at dispatch and 27% at 20:13:19 UTC; ordinary usage
remains allowed. This six-point observed change includes concurrent account use
and is not per-agent attribution. Medium transport needed fixture corrections;
High migration needed the substantive review corrections listed above. Preserve
risk-based routing and bounded review; this is not model-equivalence evidence.

This accepts the local wallet/private-route implementation, not a complete KPI.
Issuer/relay v3 consumers, profiles beyond 72, semantic retention and the full
100-cycle/1,000-fault qualification remain under the same blocker. No merge,
installer, release or deployment was made.

## Protected issuer/relay consumer contract

Wallet candidate `083a619` is committed/pushed after local acceptance. The next
deliverable remains B-HISTORY-LIFECYCLE / K2 and K3: migrate already-enrolled
protected issuers and configured protected relays, then demonstrate real issuance
and admission with 65 archived configurations, restart and owner-loss restoration.
Astra High's bounded contract review ran 20:13:05–20:14:50 UTC (1m45s). Shared
quota at the preceding boundary was 27%; no budget/alternative reset.

Canonical original genesis, signed advances, immutable pages, selected head and
resource limits belong in each role's existing funded replicated history. Reuse
core streaming resolution and opaque membership; do not use the personal wallet
journal as protected source of truth or add a disk cache. Shared reference/schema
types belong in core; history readers belong in relay (node already depends on
relay). Keep original trust pins. Fresh enrollment at an already-v3 head stays
explicitly unsupported for this slice.

Version protected images with bounded `policyProof` and optional
`policyProofAppend` (original genesis or immediate signed advance plus at most two
pages). Backfill steps preserve all business state and installed freshness until
the exact installed head/body is proved. Installation commits proof append and
new policy reference atomically behind the existing four-copy durability barrier.
Use bounded checkpoint records, not the 64 KiB delta path. Check complete encoded
image and funded history capacity before intent; keep all existing ceilings. The
core policy file's actual ceiling is **1 MiB**, not permission to raise it to 2 MiB.

Configured relays commit protected history first, then mirror that exact durable
head/reference to their local policy store. An interruption between these steps
resumes the exact commit without rollback or premature service. Live verifiers
use at most eight current keys; retained spend/witness/denial validation obtains
authenticated archived membership, never a fabricated complete legacy policy.
Issuer allocations, profile pins, quotas, prepared responses, assignment/claim
bindings and permanent retirement totals stay intact.

Recovery must restore referenced original proofs across retained generations and
include proof validation in the restoration binding. A latest business checkpoint
or signature alone is insufficient. Missing proof fails closed. Pending histories
stay nonserving; observations/conflicts persist before refusal. Historical
validity does not replace a fresh four-observer challenge. One cumulative
read/byte/deadline envelope covers iterator reads and crypto. Unmigrated local-only
and operator entrypoints explicitly refuse v3.

Acceptance is a composed scenario with a long-lived active issuer while 65 other
configurations archive: legacy proof backfill; real issuance/wallet capability/
protected admission; restart; actual owner loss and funded-replica restoration;
missing/altered proof refusal; quorum failure and process death around intent/local
activation; preserved retries/responses/witness pins/denials; capacity/cancellation
refusal. No larger caps, new trust assumptions, installers or full-KPI claim.
One Sol High implementer owns this coherent integration and its tests. Parent owns
docs/CI and reviews results with Astra before acceptance.

### Cross-platform follow-up on `083a619`

CI `39162516807` passes all desktop/ownership jobs and Linux/macOS durability.
Windows durability reports 281 passed, three failed, five skipped. Two wallet
fixtures assumed Unix behavior: a `/record-1.bin` suffix did not inject the
intended failure on Windows, and self-SIGKILL returned a nonzero exit status rather
than a POSIX signal. Use `basename`, and require a flushed exact boundary marker,
empty stderr and the platform-specific abnormal termination before checking
recovery. The third failure is initial issuer population in the recovery-command
fixture exceeding observation freshness. Follow the existing crash-fixture rule:
prepare its batch first and scope a fixed monotonic clock only to initial
population, restoring the real clock before recovery commands and exact retries.
No production timing change or retry is introduced. Local correction checks and
the next actual Windows run remain necessary; general CI is still running.

The three corrected cases pass locally in a two-file run (24.32s). That run is
**12/13 overall**, not an aggregate pass: the separate, uncommitted consumer
implementation changed core retained membership and broke the existing 66-profile
wallet retirement case. The consumer implementer must restore that accepted
behavior before integration. The test-only Windows correction does not include
those in-progress production changes. Its log is
`/tmp/resonance-wallet-windows-fixtures.log`.

### General CI follow-up and active consumer validation

Run `39162516807` completed: eight platform jobs passed; Windows durability
retains the three fixture failures corrected locally in `c53e0d1`. General CI
passed 3,239 cases and failed 25 across four files. Its log is
`/tmp/resonance-083a619-general.log`. The distinguishing failures are invalid
history requests created at the maximum lifetime and fixed loopback port 33002
collisions. A bounded Sol Medium task owns only quorum lifetime arithmetic and
its test, plus observer test port allocation. Confirm the causes and preserve
production lifetime ceilings; do not hide failures with retries or larger caps.

The consumer integration remains unaccepted. Its unchanged 120-second composed
scenario exposed repeated prefix work and cumulative read-budget exhaustion.
The implementer is validating bounded opaque-head/membership reuse without
raising caps; offline restart and restoration must still authenticate original
proofs. The previously regressed 66-profile wallet retirement case passes again.
Sol High temporarily failed because its selected model was at capacity, then
resumed the same bounded implementation; no new architectural alternative or
KPI claim follows. Protocol review and negative/crash acceptance remain pending.

### Consumer candidate submitted for review

Sol High's frozen 28-file candidate is identified by content SHA-256
`805b9b149bf0204fbbc9486d6821886e1cedb4ac83478f9be7b4c0f79dd9a864`
(sorted relative path, NUL, bytes, NUL), excluding parent CI/docs changes.
Full local command/file receipt: `/tmp/protected-consumer-candidate.json`.
Observed interval20:17:18–21:11:47UTC (54m29s) includes commands/waits, not exact
active labor; earlier reading is unclocked. Shared weekly account usage27→34%
is not attributable per-agent cost. The implementation needed corrections to
repeated prefix work, cumulative membership scans and test transport framing;
the accepted wallet66 behavior was restored. No limit was raised.

The65-archive composed scenario passed in87.38s with the fixed120s wrapper,
real issuance/admission/replay, deletion of both owners and original funded
replica restoration. Missing/altered original proof is rejected. Additional
checks pass for three actual SIGKILL boundaries with real v3 bodies/pages,
one-byte/one-record capacity, cancellation, quorum loss, opaque membership
bindings and archived issuer retirement preserving totals and permanent denials.
Affected seven-file regression passes143/143; wallet66 passes on the final
candidate. These are implementation evidence, not full lifecycle qualification.
Astra review and the final composed run are pending.

Restored v3 APIs require an explicit funded original `ancestrySource`; existing
configuration/CLI paths without that source refuse. Fresh v3 enrollment and
proof-preserving semantic prefix retirement remain unsupported. No implicit
source selection or expanded funding is introduced.

Separately, the CI repair preserves the original monotonic deadline and caps
its signed lifetime at the configured maximum, preventing floating subtraction
from producing30001ms for a30000ms budget. A deterministic fractional-clock
regression covers it. Observer tests now hold OS-allocated listeners before
signing context endpoints, avoiding release/rebind races. Both affected suites
pass50/50 in32.78s with permitted loopback access. An earlier sandbox run denied
listener binding; it was not an application failure. Log:
`/tmp/resonance-ci-request-bounds-tests-loopback.log`.

Workspace build and explicit desktop-server compilation pass on the integrated
candidate (`/tmp/resonance-protected-consumers-build.log`). The new consumer
scenario is included in the existing three-OS admission durability CI job with
its15-minute job limit unchanged. No installers or merge are triggered.

### Protocol review corrections required

Astra High review21:11:13–21:14:02UTC found two P2 issues; candidate acceptance
is withheld. First, relay proof replay omitted the caller cancellation signal;
both issuer and relay proof reconstruction failed to share the replay absolute
deadline. Second, issuer installation awaited its initial cryptographic check
before creating a budget, then parsing and pre-intent validation restarted
budgets. Correct both by propagating one absolute computation deadline/signal
and cumulative counters. Do not race the durable mutation itself. Gate crypto
in distinguishing tests to prove cancellation/deadline release and no premature
intent. No other material provenance, opaque capability, permanent-denial or
intent/mirror ordering issue was found in this bounded review. Sol High owns
this single correction round; final composed validation follows.

### Review correction accepted; composed validation in progress

The two P2 fixes pass five distinguishing tests in10.54s and TypeScript.
Astra's scoped follow-up21:18:42–21:18:59UTC confirms both corrections: each
replay uses its original absolute deadline and signal; issuer verification,
parsing and pre-intent validation share the same budget. Durable mutation is
not raced. No further material finding in the scoped correction review.

Revised28-file content SHA-256:
`a4832b3445d9f2e59281c764ae774a9bba93feb797b6b5fdd73cd306f3b1ffc0`.
The receipt at `/tmp/protected-consumer-candidate.json` contains the correction
command and file list. Shared account usage is36% at21:18:21UTC, versus27% at
entry; this is not per-agent attribution. The resumed interval through21:18:43
includes waiting and is not exact active effort.

CI-only corrections are committed separately as `a39fd69`; no push yet.
One14-file final affected-path run is active, log
`/tmp/resonance-consumers-final.log`. It covers core v3/trust, full new consumer
scenario and faults, wallet proof, issuer replay/restore, relay history/roles,
freshness and desktop-server policy updates. Only relevant changes/failures
justify repeating it. Full build follows on this revised candidate.

### Final local consumer acceptance

The reviewed candidate hash remains exactly
`a4832b3445d9f2e59281c764ae774a9bba93feb797b6b5fdd73cd306f3b1ffc0`.
Final composed run: **189/189 across14files**,273.23s total,
`/tmp/resonance-consumers-final.log`. `npm run build` and explicit
`npx tsc -b packages/app/tsconfig.server.json` both pass on the same candidate;
log `/tmp/resonance-consumers-final-build.log`. Whitespace validation passes.
The final run includes all new consumer cases and the relevant issuer/relay,
core, wallet and desktop policy-update paths after the review fixes.

This accepts the scoped local consumer implementation. It does not close K2/K3:
operational CLI/configuration must retain/select funded original ancestry for
restored v3, profile history beyond72 and full lifecycle/fault qualification
remain. The blocked historical retirement investigation is not reopened.
Cross-platform CI will qualify the pushed candidate separately; no merge or
installer is authorized by this acceptance.
