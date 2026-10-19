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

### Published candidate and next operational prerequisite

Consumer implementation committed/pushed as `95fdda4`, together with local
CI-fix commits `c53e0d1` and `a39fd69`. Draft PR34 updated; CI run
[39167741462](https://github.com/Planetary-e/resonance/actions/runs/39167741462)
is active. No installer, merge or activation.

Next bounded prerequisite remains B-HISTORY-LIFECYCLE / K2/K3: connect restored
v3 original ancestry to ordinary recovery/configuration/CLI operation. Current
APIs succeed with explicit funded downloader ancestry; missing sources refuse.
Astra High is defining the minimal retained source reference, independent pins,
funding and lifetime/close contract before implementation. Observable acceptance:
actual recovery command and subsequent ordinary startup preserve v3 proof and
accepted responses/denials, while missing/wrong sources refuse. No implicit
funding, genesis replacement, disk proof cache, fresh v3 enrollment or semantic
retirement is included. The suspended historical investigation remains separate.
Shared usage at the preceding review boundary36%; same blocker/stop conditions.

### Remote consumer failures and next contract held

CI95fdda4 desktop checks pass on all three OS. Linux durability passes302
cases but the65-archive scenario exceeds the unchanged3s proof budget during
issuer reopening. Linux/macOS ownership each pass367 related cases and fail
the policy-current invalidation test. Its mock targets the legacy accessor;
the consumer migrated to the archived accessor. Confirm whether this is stale
fault injection or a real invalidation gap before modifying the test. Sol High
will diagnose these two concrete failures under the same candidate; no timeout
increase, frozen qualification clock or new architecture alternative. Do not
start operational-source implementation until the current failures are resolved
or a stop condition is identified. Logs: `/tmp/resonance-95fdda4-117794146311.log`,
`/tmp/resonance-95fdda4-117794146326.log`,
`/tmp/resonance-95fdda4-117794146377.log`.

The next source-selection contract is ready but held: preserve v1 configs and
add an optional strict versioned recovery-download selection with directory,
independent enrollment/continuation files and existing funding identity. Capture
paths and pins before awaits. Match role/context, original genesis, complete
download proposal and immutable restored generation root; a later recovery
requires explicit new continuation selection. Bind selection to reviewed apply.
Reuse the existing downloader with initialization disabled and no exposed run();
preflight BOTH ciphertext and manifest reservations with zero additional bytes.
Normal ownership lock/temp cleanup is acceptable, accepted evidence unchanged.
No new decoder or proof cache. Issuer opens explicitly selected existing funding;
relay must match its already-selected authority.

Transfer downloader ownership to returned recovery children so parent close
cannot invalidate them; failure/child close releases source. Ordinary startup
owns its own reopened source. Shared adapter plus issuer CLI/startup comes first,
relay wiring second; each is part of the same unfinished operational requirement.
Use minimal valid v3 fixtures (no repeat65) for actual command+fresh startup,
interrupted restore/child lifetime, missing/wrong/incomplete source, zero funding
delta, wrong generation and3-versus4fresh confirmations. No semantic retirement
or fresh v3 enrollment in this bounded integration.

### October19: bounded CI follow-up and platform policy

User requests routine development on macOS only, with Windows/Linux deferred to
a final test. CI matrices and its general job now default to macOS; installer
matrix defaults to Apple Silicon. Both workflows expose manual boolean
`all_platforms` (defaultfalse) to opt into all three platforms at final validation.
Installer triggers remain tags/manual, never ordinary branch pushes. YAML parses
with Ruby's standard parser; both expression branches decode to the intended
one-versus-three matrices. This intentionally defers Windows/Linux confirmation,
not a claim that their failures passed.

The8-file SPKI memo correction over95fdda4 has content hash
`baa8abe7f7c492e90ee2449e9fc0be8c7b705b2fbba4948ecfef0ffefbb04c4e`.
Exact-DER key import reuse is private per operation, capped72, preserving every
profile/body/signature check. Measured repeated imports8971→326; local cold
issuer open+ready2144ms, unchanged3000ms proof limit. Seven discriminants pass;
the fixed65 scenario passes86.18s. Astra's scoped review05:07:28–05:07:42UTC
accepts the memo and currentResolved fault injection. Parent22compatibility
tests/3files pass12.03s; workspace and desktop-server builds pass. Receipt:
`/tmp/protected-consumer-ci-followup.json`. Shared quota last36→39%; observed
implementation interval21:32:57–21:41:28UTC includes commands/waits, prior reading
unclocked. No exact per-agent cost inferred.

Completed95fdda4 CI also exposes admission-history-recovery changed-image refusal
creating a writer prematurely, and a macOS65-observer socket4003 failure. These
are being narrowly diagnosed before the next implementation or push. Prior
component acceptance remains local; no complete KPI.

### Remaining CI correction review

Policy/workflow preference is committed as703f9e8; reviewed exact-RSA memo and
invalidation fixture as ea4a10e. The macOS observer65 case passes once locally
in28.71s with the memo. Its old4003 cause is not demonstrated: current handlers
report no failure, so no observer algorithm or fairness/timeout was changed.
The test now includes bounded stage/handler/exchange diagnostics in its thrown
error, and a real4003 rejection checks that those diagnostics survive.

The retained-state review regression was reproduced. Digest validation moved
before writer opening; new writer/archive creation now follows full image and
original-proof validation. Existing writers still open to provide their proof.
Two distinguishing cases pass10.04s, including restoredv3 missing-proof refusal
without writer creation and successful complete-proof reopen. Astra accepts
this scoped correction05:16:42–05:16:46UTC. Parent is running the two directly
affected recovery/history suites once after review. No limit increases.

Shared weekly counter42% at05:17:06UTC, compared with39% at the prior receipt;
ordinary use remains allowed. This account delta is not per-agent attribution.
The automatic permission reviewer briefly failed from model capacity on a CI
query; the same approval path subsequently succeeded. No check was bypassed.

Final recovery-order regression passes **62/62 in2files**,103.70s,
`/tmp/resonance-recovery-order-final.log`. Sol's frozen4-file follow-up identity
is `bdc609e6a14434cd03c67f10577c5cd2fb96b2ff73abda9ddd310aa53f88c707`,
receipt `/tmp/protected-consumer-ci-final-followup.json`; TypeScript and whitespace
checks pass. Observed work05:11:53–05:17:21UTC includes commands/waits, earlier
reading unclocked. Current42% shared account usage is not per-agent cost.
The new candidate is ready for macOS CI; Windows/Linux are explicitly deferred
by the owner, and the prior observer4003 remains unconfirmed remotely.

### Operational issuer source integration starts

Publishedf575e64; macOS CI39203967267 running. The next single SolHigh
implementation begins with the shared retained-download adapter and issuer
recovery/ordinary startup only. Relay runtime integration follows as the next
part of the same operational prerequisite. Contract above is fixed: strict
optional ancestry selection, independent original enrollment/certified
continuation and existing funding; zero-additional-reservation preflight;
independently owned repeatable source; reviewed selection bindings and
validation before owner/writer creation. Proposed selection shape:
`{version:1,kind:'recovery-download',directory,enrollmentFile,continuationFile,
funding:{authorityDirectory,authorityId}}`. Legacy config remains valid.

Use minimal realv3 command/process tests, not another65rotation scenario.
No new decoder, proof cache, reserve, enrollment or semantic-retirement work.
Known implementation prerequisites are eligible for development; they do not
reset B-HISTORY-LIFECYCLE or its historical effort/alternatives. Shared usage at
entry uses the latest42% observation, exact per-agent usage unavailable. Parent
owns CI/docs and review coordination; implementer must report bounded plan
before edits and freeze for review before one affected final regression.

### macOS result: reopen performance line held

Run39203967267: desktop and local-ownership pass; durability305pass/1fail.
The same cold issuer reopen with65archived configurations exceeds its retained
3000ms proof budget on the macOS runner after the bounded memo correction.
Log `/tmp/resonance-f575e64-macos-durability.log`, stack owner319/issuer113/
consumer-test215. The prior observer4003 did not recur. General suite still
running at this observation. Local2144ms is not hosted-runner qualification.

Hold further performance adjustments on this route. Astra will assess the
existing K1 three-second authorization contract versus K2 five-minute recovery
target and identify whether an explicit offline-recovery budget decision is
required. Do not change retained limits or count this as two failed architectural
alternatives without evidence. No threshold is weakened. The minimal operational
v3 source/CLI integration is independent and may finish under unchanged limits.

Astra's decision review05:27:28–05:27:52UTC confirms separating offline
reconstruction from live authorization is compatible with K1/K2, but requires
owner approval because the retained proof currently pins3000ms and its contract
requires unchanged limits. The failure alone is not a security counterexample
or proof of two failed alternatives; local memo improvement remains evidence.
Stop condition4 applies to pursuing the proposed changed resource assumption.

Owner question is pending: allow explicit versioned offline reconstruction up
to30s, with no serving until complete and unchanged3s authorization, storage,
bytes/blocks/transitions/memory. No change is applied while pending. A new
contract must preserve original proof and all denials/conflicts, use one absolute
deadline/cumulative counters and cancel reads/crypto; never reinterpret old
references silently. If authorized, one bounded implementation/review and cold
macOS measurement follows, not open-ended tuning. The timeout currently only
proves>3s; it does not establish duration/p95/K2 compliance.

### Issuer operational source candidate submitted

SolHigh froze15files at05:33:00UTC overf575e64, content SHA256
`2650d07c46ce794eaa70b3a779d7535521dcb603a2a03bccf60aa59d10d6c77a`
(sorted relativepath,NUL,bytes,NUL), receipt
`/tmp/issuer-operational-source-candidate.json`. Shared ancestry adapter, strict
issuer selection/config, actual recovery CLI and ordinary script startup,
immutable-generation checks, owned source transfer and resumption proof
validation are implemented. V3 restoration without explicit existing funding
refuses before new owner state; completed recovery status exposes its certified
continuation for explicit selection.

Final focused3checks/2files pass15.52s; node TypeScript and whitespace pass.
Coverage includes actual minimalv3 CLI restore/interruptedresume/fresh startup,
retained response/denial,3-versus4 fresh confirmations, wrong/missing/corrupt
source/pins/funding, zero additional allocations, source lifetime after parent
close and subsequent reopening. Minimalv3 descriptor is empty with real original
proof records; archive-boundary evidence remains the earlier separate test.
No new process-death fixture; parent affected regression will include existing
crash paths after review. Relay runtime wiring remains the next separate slice.
Candidate is under Astra contract review; no acceptance/commit yet.

### Operational source review: two corrections required

Astra withholds acceptance on two P2 findings. First, the recovery command
preflighted selected ancestryA while opening workspaceB/download; no equality
of path/genesis/continuation linked selection to the actual source, and B could
reserve before the later check. Bind/recheck the captured selection and verify
both actual-source reservations before opening it; distinguish old-owner source
selection when starting another recovery. Reproduce fundedA/unfundedB and a
valid but wrong continuation, requiring unchanged authority and absent owner.
Second, closing a preparation removed its source but left its WeakMap capability
valid. Explicitly invalidate closed/consumed preparations before any intent and
retain one-time transfer. Closed-v3-preparation restore must leave destination
absent. These are implementation corrections under the existing frozen contract,
not an added resource/trust assumption. SolHigh owns one scoped correction round.
Configured ordinary startup preflight and successful parent/child lifetime had
no further material finding in this review. No candidate acceptance yet.

### Owner decision and integration resume — October 19

The owner approved the proposed separation: offline startup reconstruction may
use up to30 seconds; live authorization retains3 seconds. This authorizes an
explicit versioned contract, not silent reinterpretation of retained references
or any change to memory, bytes, blocks, transitions, storage or trust. No serving
until reconstruction and current authenticated policy checks finish. One bounded
implementation/review/cold-Mac measurement follows. K2/K3 remain open.

Astra accepted both P2 corrections in source candidate
`90050adb1734487b5c5455b420ab86562c1dfd0ecb6df6deba17310fda2cd3e4`.
Parent seven-file affected regression is running; workspace and desktop-server
TypeScript compilation pass. Source implementation used SolHigh, review AstraHigh,
one correction round, first-pass acceptance withheld for two P2 findings.
Shared account usage at resumed block entry is48%; earlier42% is not attributable
to this task alone. Historical unclocked effort remains unknown.

CI39203967267 completed: macOS ownership and desktop boundaries pass; durability
and general tests fail. General reports3270 passed,2 failed and1 worker error.
Besides the known cold65 three-second timeout, history-volunteer-service has a
gap/fork/stale-predecessor failure and a worker exited unexpectedly. Preserve
these distinct unresolved results; do not claim the timeout change fixes them.
Log: `/tmp/resonance-f575e64-general-fail.log`. No installers were launched.

Parent acceptance: exact frozen source candidate verified unchanged. The selected
seven-file regression passes76/76 in137.92s on local Node24.19.0/macOS, log
`/tmp/resonance-issuer-source-composed.log`; `npm run build` and
`npx tsc -b packages/app/tsconfig.server.json --pretty false` pass.
This closes the issuer operational-source slice, not K2/K3 or relay runtime wiring.
Remote general worker termination includes an explicit V8 heap-limit error at
about2GiB; root cause and affected file remain unqualified. No memory ceiling
is increased to mask it.

### Frozen startup executor implementation contract

Parent B-HISTORY-LIFECYCLE / K2,K3; prerequisite, not KPI qualification. Issuer
operational source is committed as cbe2913. Astra's bounded read-only design
preserves proof-reference v1 canonical bytes, digest and original timeout. A new
explicit execution envelope selects v2 offline-startup-reconstruction, with an
integer timeout <=30000ms; absent/v1 execution retains reference-bounded behavior.
The budget retains exact original limits for comparisons and all six cumulative
resource counters. A live helper must reject reuse of an offline budget.

One context starts at public owner open before its first await, sharing a single
absolute deadline, cancellation and lazy proof budget across initial key/profile
validation, retained roots, baseline/current/pending images and original proof.
Discovery of the first reference cannot restart time. Shorter caller deadlines
win. End startup before returning the API; live exclusive operations and relay
resolvedPolicy cannot inherit its budget. Existing bounded exact-head opaque
caches may survive; readiness and current authenticated observations remain
mandatory. Cancellation rejects late results/cache installation and closes owned
resources; native crypto computation itself is not physically interruptible.

Scope: core executor, protected issuer/relay startup and their existing proof
adapter. Standalone owner-loss replay/preparation/resumption remain unchanged.
No new memory/storage allowances, reference migration, trust changes, authority
retirement, release or installer. SolHigh implements; AstraHigh reviews critical
phase separation. Acceptance: v1 compatibility, malformed envelope rejection,
shared original resource ceilings, shorter deadlines, startup >3s but <=30s,
cancellation/lock cleanup/no late cache, live >3s refusal including cached paths,
readiness remains unverified, and current/pending share counters. Focused checks
first; one composed affected regression and existing65 cold scenario after review,
then one cold Mac CI measurement. No open-ended tuning or p95 claim.

Startup executor candidate: SolHigh implemented eight source/test files over
cbe2913; manifest `/tmp/resonance-startup-candidate.sha256` hashes to
77f7e78aa9c9b74cf6a7d5003baab574e71aba594f0bf1446672f5d8eb20d088.
AstraHigh verified every file and accepted the bounded contract with no material
findings in the first review. Core18 checks and13 focused discriminants pass;
workspace build passes. Final one-line startup WeakMap deletion is included in
reviewed hashes and will be covered by the composed regression. Five-file parent
regression includes the existing65-archive scenario, both protected owners and
operational issuer recovery. Its reopen metric includes issuer open plus fresh
ready() replication, so it is not a standalone reconstruction-time measurement.
Shared usage observed by Sol50%, versus48% at entry; no per-agent attribution.
One cold macOS CI run is still required after the reviewed candidate is stable.

Parent final startup regression:103/103 in5files,212.94s, local Node24.19.0/Mac.
Log `/tmp/resonance-startup-composed.log`. The exact reviewed eight-file manifest
still matches. Existing65 cold issuer reopen plus fresh ready() measured2118ms,
475 SPKI imports, receipt mtime2026-10-19T07:17:23.066Z. This is one local sample,
not p95 and not hosted-runner qualification. Workspace plus explicit desktop
server compilation pass after regression. No memory/trust/storage ceiling changed.
Implementation interval roughly07:07–07:14UTC, review completed before07:16UTC;
parent cold measurement began07:16:24UTC. Prior unclocked effort stays unknown.
Pending separate CI history-fixture failure and heap exhaustion remain unresolved.

### CI925441e follow-up — October19 09:37UTC

Owner requests autonomous continuation until a full KPI or actual stop condition.
Shared account entry52%; previous interval closed at51%, not per-agent costs.
Mac CI39215366293: ownership/desktop pass; durability314pass/3fail; general3284pass/
3fail plus worker heap exhaustion. Original startup timeout did not recur; failures
are copied opaque restore capability (fixture DataCloneError), complete frozen
history quorum collection, and remote observer archive transfer. V8 OOM persists.
No KPI completion. Log `/tmp/resonance-925441e-ci-fail.log`.

Bounded next deliverable under B-HISTORY-LIFECYCLE/K2,K3: remove the fixture
regression without weakening opaque-capability rejection and identify exact OOM
source with a minimal discriminant. SolMedium owns replay fixture plus the exact
OOM file only after identification. No broad suite reruns, memory-limit increases,
test deletion or suspended retirement investigation. Parent separately classifies
remaining transport failures against unchanged deadlines/request/byte budgets;
no resource expansion is authorized by the startup30s decision. Acceptance is
focused regression and evidence of the actual cause, followed by reviewed fixes.

Fixture correction accepted: SolMedium, parent two-line review, no rework. Opaque
capability now has a close function: a spread copy plus a cloned review preserve
WeakMap forgery rejection without attempting to structuredClone functions. The
sole test file absent from CI completion was history-checkpoint-exchange; its
8MiB Buffer deep matcher enumerates numeric keys. Installed matcher reproduction
aborts under256MiB; Buffer.equals passes under the same cap and rejects a last-byte
mutation. Full checkpoint size and every byte are still checked; product limits
unchanged. Exact owned diff SHA256
edacab84fbb40d74b7f6cd6805e098109af9a456c2600f9d85255a008d194c01.
Composed36/36 in2files,7.95s, `/tmp/resonance-925441e-ci-fixtures-composed.log`.
One initial sandbox socket EPERM resolved by permitted run. No fullsuite rerun.
Shared quota52%→53%, not agent-attributed. Transport failures remain separate.

Remote transfer diagnosis: retained CI evidence shows the healthy source returns
page chunks before a local per-peer slice cancels it, then remaining pinned peers
fail quickly; operation ends at1.07/1.49s although its absolute envelope is3s.
Astra proposes a bounded scheduling correction: complete the fair initial pass,
then exactly one retry pass only for peers terminated by local slice expiry,
using unused original deadline and unchanged16requests/16*reply-byte reservations.
Restart pages from index0, no retained partial page or weaker validation. Invalid,
unavailable or authenticated denial results do not become retry candidates.
Acceptance requires delayed healthy-source success within original deadline,
silent-first fallback, cap exhaustion and cancellation refusal. One frozen local
observer65 check after focused discriminants; failure invokes the existing stop
assessment, not automatic timeout tuning. Frozen-history collection remains
unproven; a separate read-only diagnostic plan will identify the swallowed cause.

Frozen collection diagnostic prerequisite: keep five bounded internal summaries
(member ordinal, stage, completed reads, elapsed/deadline flag, fixed reason code)
in the existing two unavailable-quorum errors. No raw peer identities, messages,
paths or payloads; no revalidation, async work, altered storage or limits. The
cold fixture adds only role+elapsed on freeze failure. Unit discriminants separate
deadline from malformed responses while preserving refusal and cancellation.
SolMedium owns recovery module/fixture and existing focused recovery tests; this
is independent from the page scheduler's nonoverlapping files. No concurrent
performance qualification; cold65 runs once after both candidates freeze/review.
These diagnostics identify the failed stage, not CPU-versus-disk causality.

Frozen follow-up candidates: recovery diagnostic owned diff
195c2767057d13e02023a8ce9f8e33fde69119c1e166a585dd9cc1b69cf55980,
19/19 checks8.78s and workspace tsc pass. Parent review confirms bounded fixed
metadata only, original acceptance/refusal paths unchanged. Page scheduling
manifest `/tmp/resonance-page-retry-candidate.sha256` hashes
60c6a35b00434eb6d1b9ea42ad30940f8030995ec5f723abf8dbc578b5aea5fd;
SolMedium focused+v3 integration50/50 pass28.12s, final byte-cap assertion15/15,
relay tsc passes. Astra review pending. Logs `/tmp/resonance-page-retry-focused.log`,
`/tmp/resonance-page-retry-unit.log`, `/tmp/resonance-freeze-diagnostic-focused.log`.
One sandbox bind failure resolved in permitted run. Shared usage54%; concurrent
interval observations are not additive/per-agent costs. No cold65 yet.

Astra accepted the page scheduler on first review, no material findings/rework.
Parent four-file regression passes63/63 in192.36s, including observer65 and
consumers65 under unchanged deadlines. `/tmp/resonance-925441e-transport-composed.log`.
Workspace and explicit desktop-server TypeScript builds pass. Page manifest
verified unchanged. Freeze failure did not reproduce locally; diagnosis is
prepared for the next hosted run, not a claim the failure is fixed. No KPI is
complete. Push the stable combined candidate once and retain its CI outcome.

### Relay operational ancestry — bounded implementation contract

B-HISTORY-LIFECYCLE/K2,K3 next necessary operational prerequisite. Baseline64587dd;
shared account entry55%, CI39232901708 running independently. AstraMedium read-only
pass identifies strict relay config, direct/deferred runtime and recovery/readiness
missing the already implemented shared ancestry source. No new protocol decision.

Observable result: an explicitly selected funded restored-v3 relay starts through
ordinary config/runtime and actual recovery/readiness, preserving original source
until child closure. Reuse history-ancestry-source; preserve legacy configs and
strict extra-field rejection. Capture original/canonical paths and independent
pins before awaits. Compare selected immutable root/genesis against persisted owner
before writer mutation. Check both original-download reservations before opening;
reuse explicit selected funding and never adopt/conflict/change authority scope.
Missing/changed/unfunded/corrupt/incomplete/wrong-generation sources refuse without
new allocations. Bind the actual recovery download and original destination spelling
into reviewed apply. One-time source ownership transfer, close child then source,
cleanup failures/abandonment, recovery close must not invalidate transferred child.
Existing fresh quorum/readiness and deferred reverse links remain required.

SolHigh owns relay admission-history-config/protected-history/runtime/command/
recovery/restore/readiness and focused related tests; no helper framework, source
migration, new budgets, >72 profiles, fresh-v3 enrollment or retirement investigation.
Acceptance: strict legacy/new config, actual minimalv3 restore/reopen/readiness,
path/pin/manifest/generation/funding refusals, both reservation peaks, transfer/lock
lifetime, direct/reverse-link runtime and failure/shutdown cleanup. Then one reviewed
affected regression/build. No new heavy65 campaign or repeated qualification.

### Hosted freeze evidence and stop decision — October19

Mac durability job117994916417 on64587dd passes316/317 (29/30files): page migration
now passes; copied-capability fixture passes. Sole failure: issuer freeze after
2003ms, all five collectors hit deadline with71–72 verified reads, no reported
invalid-history reason. `/tmp/resonance-64587dd-durability.log`. This proves2s
exhaustion, not eventual completion, CPU causality or K2 compliance. General CI
is still running; matcher OOM remote confirmation remains pending.

Astra confirms stop condition4 applies to changing the frozen fixture allowance.
Production recovery already defaults30000ms, but the fixture explicitly pins2000ms
and prior startup30s approval excludes owner-loss collection. Proposed decision:
use existing production30000ms in this fixture, keep exact quorum/validation/
resource caps and short-deadline failure tests, retain the2s failure, then one fixed
cold hosted measurement. Owner question sent; no limit change while pending.
Independent already-active relay operational source work may finish. No additional
performance tuning, new alternatives or implied KPI completion.

Relay candidate frozen: eight files, manifest
`/tmp/resonance-relay-ancestry-candidate.sha256` SHA256
 a3efc6b69202a71562a2f1c946551800e75d004db4591bcdb3c96b5efa63ca94.
SolHigh final focused4/4 in3files12.64s (55 filtered); source typecheck passes.
Evidence includes minimal realv3 recovery/readiness, parent-close/source lifetime,
selected direct/reverse runtime and shutdown/failure paths. Earlier composed
63/65 found two integration issues: expected policy-store/lock creation before
owner apply, and fixture storage adoption lacking original-download scope; both
corrected before freeze. Review must check narrow file allowances and funding
semantics. AstraHigh review pending, so no acceptance claim. Sol active work ended
10:04:55UTC; start roughly parent dispatch09:51UTC, no fabricated finer timing.
Shared entry55%→57%, not agent-attributed; parent regression after review only.

Relay first review withheld acceptance: three P2 implementation violations,
not a protocol/resource redesign. (1) Destination was reviewed before awaited
genesis parsing but not rechecked immediately before publication; carry a bound
assertion and publish canonical destination, regress retarget during await.
(2) Selected downloader preflight occurred before startup clock; establish clock
at public entry and propagate unchanged through preflight/runtime/owner, check
cancellation and cleanup. (3) Policy-store name exception accepted foreign files;
bind it to the actual owned configured-verifier store/lock identities, otherwise
retain pristine destination. Regress legitimate creation vs foreign same names.
Astra requires one scoped correction round and follow-up review before acceptance;
prior passing component tests do not close these findings. Existing source/funding/
parent-child invariants otherwise consistent. SolHigh owns correction, no budgets
or stop-policy conditions reset. No heavy65 rerun required for these corrections.

Relay follow-up: destination/canonical publication and owned-store identity fixes
accepted. Clock regression test initially inherited an absolute deadline, which
would not distinguish the old default-clock bug; corrected public case omits it
and advances preflight past30000ms (inherited50→51 case retained),2/2 pass.
Reviewer found one residual cleanup edge in new configured-store wait: outer
wait's final deadline check may reject after inner callback returns but before
store assignment, leaking handle/lock. Retain handle outside wait and catch-close,
including late result cleanup; add discriminant at that boundary. This is a second
scoped correction to the same startup/cleanup finding, not an added deliverable.
No acceptance until this correction and composed regression complete.

Parent relay composed regression77/78 in7files145.43s; one compatibility failure
in existing managed-readiness quota test. New apply marked `applied` before owner
open; a prepublication capacity refusal then prevented the existing explicit
quota-review/raise/retry flow. Preserve test and restore retry semantics before
successful apply, retain busy protection and source lifetime. This is necessary
integration correction, not permission to expand storage automatically. Sol fixes
minimum path; follow-up review and affected readiness regression required. Other
six composed files passed. Log `/tmp/resonance-relay-ancestry-composed.log`.

Final relay acceptance: Astra accepted all three P2 corrections and the narrow
readiness retry delta. Exact final ten-file manifest hash
d196c40ac7ca54bfeac4b0499291cb97414239165140f14684dc537b16a280a3
verified. Six unaffected composed suites passed; final full affected recovery/
readiness suite28/28 passes81.82s, `/tmp/resonance-relay-ancestry-readiness-final.log`.
Combined coverage is78 distinct checks across7files (not a fresh single all-green
run after the one-file correction); targeted retry/source tests3/3 also pass.
Workspace and desktop-server compilation pass. This closes operational relay
ancestry wiring locally, not K2/K3 or independent qualification. First review
rejected3P2; scoped cleanup/discriminant follow-up and parent regression exposed
further same-boundary compatibility work, all retained above.

Shared account exit62%, relay entry55%; whole resumed block52%→62%. Counts include
other account activity and are not per-agent costs. No new quota cap inferred.
Model routing: AstraMedium design, SolHigh implementation/rework, AstraHigh review;
Luna was unnecessary for deterministic commands. Original freeze2s condition4
remains pending owner decision. No threshold has changed. General64587dd CI still
running at latest check; no remote completion claim for the new relay candidate.

### Owner approved production-default freeze qualification

Owner explicitly answered yes to replacing this fixture's2s owner-loss collection
allowance with the existing30s production default. Approval covers collection
only, not agreement/download/provision/replay deadlines, quota/trust/validation or
KPI targets. Remove only that override; log role/elapsed/allowance on success for
one new hosted Mac measurement. Keep short-deadline failure coverage and retain
both prior2s failures. Entry shared quota62%, ordinary usage allowed. This is a
mechanical approved fixture change, no new agent or architecture review needed.

Previous64587dd general CI now complete:3316/3317 pass, sole failure issuerfreeze
at2004ms with allfive collectors reaching73 reads. No worker error/OOM remains.
Log `/tmp/resonance-64587dd-general.log`; ownership/desktop pass and durability
316/317 sole samefreeze failure. Locally validate changed cold65 case plus existing
short-deadline recovery tests, then push with reviewed c8802e6 relay integration
and one new Mac CI. No further limits move without evidence/decision.

Local approved fixture validation46/46 in2files162.94s, including original short
deadline/cancellation checks; `/tmp/resonance-freeze-production-default.log`.
Successful console metrics were suppressed, so final instrumentation writes two
bounded temp receipts and existing Mac CI jobs report them after tests (also on
failure). No extra scenario/rerun, product change or timeout changes elsewhere.
Receipts distinguish complete collection from an absent/failed measurement.

Hosted approved collection measurement at candidate `5fad341`: Mac durability
job118064459656 passes317/317 in30files369.99s. Issuer collection2821ms; relay
collection69ms; both under the existing30000ms production allowance. Log
`/tmp/resonance-5fad341-durability.log`, run39253963213. Ownership and desktop
jobs also pass; general suite still running. This resolves the separately
approved collection fixture failure, not K2/K3. Shared quota at resumed
checkpoint64% (previous62%); account-wide, not model/task attribution.

Next prerequisite review (AstraMedium, read-only): a funded v7 local enrollment
catalogue can preserve synchronous capability allocation, original token-file
names and exact retries with sequential historical wallet opens. Status must
page explicitly. However the existing100-transition fixture envelope permits
256 cumulative page reads; current replay rescans prior archive prefixes and
exceeds that before100 rotations. Do not dispatch catalogue implementation on
a knowingly impossible acceptance setup, raise limits, or reset per-transition
counters. Assess a bounded single-replay optimization preserving original
ancestry, non-reactivation and charged actual work before freezing implementation.
No production or fixture budget has changed.

### Frozen prerequisite: cumulative full-replay work

Parent blocker B-HISTORY-LIFECYCLE / K2,K3; same archive alternative and cumulative
effort ledger. Observable result: original signed100-transition history replays
within unchanged256 cumulative page-read/page allowances, leaving room for wallet
membership visitation. Current construction requires702 reads; proposed replay
requires74 (37 new pages plus37 final revalidation); these are predictions to
measure, not passing evidence.

AstraMedium contract: only `resolveAdmissionPolicy` may hold a call-local exact
validated prefix plus archived fingerprint/epoch sets. Validate original genesis,
every signed contiguous transition, unchanged pins/cutoffs/witness rules and
exact new-page suffix linkage/content. Enforce non-reactivation against the
validated sets. Charge every actual read and all existing byte/entry counters,
including a mandatory complete final archive reread before returning any handle.
Bound temporary sets by existing charged entries/bytes; discard on success/failure.
No cross-call cache, persisted trust, new resource allowance or change to
standalone advance/preparation behavior. Missing/corrupt final pages, cancelled
final scan or exhausted counters must refuse without emitting a handle.

Acceptance: real100-transition signed history at unchanged fixture limits;
measured read counts; fingerprint/epoch reuse, root/count/content mismatch;
early page corruption/removal before final pass; final-pass cancellation and
exact resource exhaustion; fresh second replay and standalone advance still
read original evidence. SolHigh implements only core resolver and discriminating
tests; AstraHigh reviews; parent runs one affected composed regression. Walletv7
and UI remain subsequent coupled implementation, not part of this code delta.
Entry shared quota64%; no timer/budget increase. Retain the previous failed
collection evidence and current hosted success separately.

Replay prerequisite implementation: SolHigh active12:49:35–12:52:00UTC;19/19
focusedv3 tests pass19.03s and core TypeScript passes. Actual100-transition
replay uses74 reads/pages,200 scanned entries and twice final archive bytes,
on two independent calls under unchanged256-read/3000ms envelope. No limits
changed. Focused log `/tmp/resonance-replay-prefix-focused.log`. Two-file
manifest `/tmp/resonance-replay-prefix-candidate.sha256`, SHA256
9881cad9383582f45145ae7cf37cf533ee9a8ea3acc8875ebf0bd89e4ade42b7.
AstraHigh review12:52:03–12:52:33UTC accepts without findings, no rework. Shared
quota observed66%, entry64%; no exact task attribution. Parent affected-path
regression is running; do not claim composed acceptance yet.

### Next coupled contract: funded wallet enrollment catalogue

Dispatch only after the replay prerequisite composed regression passes. Same
B-HISTORY-LIFECYCLE/K2,K3 alternative; this is the remaining100-profile dependency,
not a separate KPI or a reset of cumulative effort. Observable target:101 locally
enrolled profiles after100 real signed transitions, reopen across72→73 and100→101,
with original token history, bounded open handles and explicit paged status.

Use a version7 encrypted `admission-profile.json` under its existing domain/2MiB
ceiling as the sole activation commit. Retain exact current policy, freshness
pins/floor/conflict and proof reference, active issuer, original first-wallet
identity, plus authenticated enrollment catalogue root/count. Enroll only locally
activated profiles, never all keys seen during legacy proof backfill. Immutable
encrypted catalogue records share the already selected proof directory allowance
and inventory; migration may group legacy entries into bounded pages. No new
authority, manifest, implicit quota, orphan deletion or raised legacy constants.
Root/hash authenticates retained local enrollment; original-chain resolution and
current-policy membership authenticate profile authority and cutoffs.

Keep original `admission-wallet.json` and issuer-fingerprint filenames and token
formats. Reserve every new token file at its existing16MiB+8192 ceiling and all
publication/replacement peaks before activation. Preserve reservations, permanent
denials and local retirement evidence. Missing enrolled files refuse, never
initialize empty. Before commit old snapshot remains authoritative; after commit
missing/corrupt catalogue/proof/token evidence refuses. Uncertain writes poison
the owner until reopening. v5 backfill remains non-authorizing until exact
installed head, with unchanged floor/conflict; v6 migration authenticates original
proof and each enrolled file before activating v7, without token rename/rewrite.

Use one budget/deadline for replay plus bounded membership visitation. A minimal
core visitor may create opaque memberships bound to the current resolved handle
after complete archive validation; stage results until operation success. No
per-profile replay, accumulating retainedIssuerKeys beyond72, or deadline resets.
Keep provider synchronous: parsed profile/membership index is bounded by funded
catalogue; hold active wallet plus at most one historical wallet, closing each
historical handle in finally. Scan all historical reservations/denials before
returning a recorded retry or allocating fresh; any incomplete/expired/corrupt
scan refuses. Check monotonic deadline between synchronous reads, freshness again
before allocation/return, and preserve exclusive operations/session-close fencing.

Status returns active summary and explicit archivedTotal/nextCursor with at most
72 archived entries per page. Cursor binds activated catalogue generation; stale
cursor refuses. Wire minimal authenticated API/client/UI pagination, reset page
after mutation, and distinguish archived policies from local retired wallets.
No unrelated UI or asynchronous provider migration.

Acceptance: unchanged existing2GiB authority,16MiB proof allowance,256 records and
existing archive/time limits; measure actual inventory, open handles, snapshot
size and timings. New wallet, pinnedv5 backfill and v6 migration preserve filenames
and rights; exercise101 enrollment boundary/reopen, historical exact retry or
cutoff refusal without fresh allocation, permanent denial, missing/corrupt and
wrong-provenance evidence, byte/record/reservation refusal before activation,
cancellation/close/concurrency, and actual process death around catalogue and
activation publication. A private app update crosses the boundary under its
existing25s envelope. Run focused tests, AstraHigh review, then one composed
affected regression. No release, installer, relay/issuer refactor or historical
semantic-retirement investigation. If remaining selected resources cannot fit,
retain evidence and apply existing stop policy; do not enlarge them.

Replay prerequisite composed acceptance:81/81 tests in4files192.63s pass
(corearchive, walletproof, protected issuer/relay v3 consumers and observerv3).
Log `/tmp/resonance-replay-prefix-composed.log`. Together with19 focusedv3 tests,
100 distinct checks pass; this is component coverage, not100 lifecycle cycles or
a complete KPI. First-pass AstraHigh review accepted; no rework rounds.

Replay prerequisite committed as `8925748`; workspace TypeScript build passes
(`/tmp/resonance-replay-prefix-build.log`). Shared exit67% vs entry64%, with
concurrent account use unassigned. Walletv7 SolHigh implementation dispatched
after composed acceptance, entry67%; frozen coupled contract above applies.
The old candidate5fad341 hosted general suite is allowed to finish; no duplicate
installer or new CI run is triggered while implementing this next candidate.

Walletv7 first focused run15/16 passes;101-profile lifecycle took107409ms and
exceeded the existing60000ms test ceiling. Log `/tmp/wallet-v7-proof-focused.log`.
Keep this failure and all resource/deadline ceilings. Identified implementation
work is quadratic historical token-file reopening on every transition. Frozen
contract requires full authentication on opening/migration and complete provider
reservation/denial scans, not repeated ciphertext opening on each transition.
Minimal correction retains authenticated retirement receipts tied to each
historical file identity and new resolved membership; every transition must
check unchanged dev/ino/size/mtime/ctime and non-aliased regular-file status.
Changed history refuses until authenticated reopening, never trust mere existence.
Refresh only after successful owned mutation; uncertain writes poison. Regress
changed historical file between transitions and owned retirement followed by
transition. This corrects implementation within the existing alternative; no
new cache of reservations, enlarged limit or counter reset.

Hosted5fad341 general result:3326/3327 tests pass in361files1701.72s. Approved
collection completes issuer3200ms/relay75ms (30000ms allowance); no OOM. Sole
failure is pre-crash setup in `history-volunteer-service.test.ts` certifiedGeneration:
append checkpoint to allfive services rejects a missing predecessor after writer
returned its requiredfour-confirmation quorum. This occurs before launching the
SIGKILL child or exercising retirement. Log `/tmp/resonance-5fad341-general.log`.
Do not claim fullCI green or historical-retirement qualification.

Frozen independent fixture correction: confirm quorum completion contract;
explicitly enroll exact root/delta on each service before test requires allfive
checkpoint states. Deterministically hold back fifth delivery to reproduce old
setup failure; retain real crash assertions. No production/quorum/deadline changes,
no suspended historical-retirement investigation. SolMedium owns only this test
file; walletSol owns disjoint wallet work. Prepare edits now but serialize test
execution behind wallet timing measurement to avoid host-load contamination.
Parent review and one targeted fixture regression; no another fullsuite rerun.

Walletv7 corrected coupled qualification17/17 passes56.73s,
`/tmp/wallet-v7-proof-final.log`. Private app100→101 update4607.88ms within25s;
101-profile reopen2418.40ms within unchanged3s;148 cumulative page reads;peak2
wallet handles. Actual proof directory3,170,439bytes/242records plus3 reserved
controls=245≤256; encrypted profile5458bytes; authority reservation1,718,616,902
bytes≤2GiB. Local results are not a hosted timing/p95 claim. Original107409ms
failure is retained. Corrected intermediate15/17 had fixture clock mismatch
(private descriptors real time versus query clock2000) and an assertion expecting
status to succeed despite deliberately changed history; both discriminants fixed.

Parent review required new membership helper to capture the original policy
before await; correction and mutation regression pass. Small focused36/36 across
core membership, legacy wallet/retirement and UI pass; corrected legacy/catalogue
checks15/15 also pass (overlapping coverage, not additive distinct totals).
One newly added multi-key legacy-handle case is compiled but awaits parent
regression. Sol froze production13:17:04UTC; core/node/app-server/app compile.
AstraHigh review now active; no final acceptance yet. Independent fixture test
starts only after wallet host becomes idle. Shared usage latest68%, walletentry67%;
not attributable task/model cost.

Independent quorum-fixture correction accepted by parent: exact authenticated
root/delta enrollment before allfive checkpoint setup; deterministic fifth writer
append omission covers genesis and continuation. Production quorums unchanged.
Whole affected file57/57 passes218.56s, `/tmp/resonance-five-replica-fixture.log`;
existing SIGKILL assertions unchanged. SolMedium prepared only this test file,
no concurrent workload during wallet timing. SHA256
d3aba6211028e7c5654ddb60d5b29a69cc7ac1199338bbc600882f7a81a262c8.
Hosted fullgreen confirmation awaits the next stable candidate; no whole suite
was rerun locally or installer triggered.

Wallet AstraHigh review requires three P2 corrections: read-only withWallet must
recheck rather than refresh authenticated file identity; new-wallet acquisition
uncertainty must poison owner; every newly acquired active handle must close if
validation fails before ownership transfer. Add distinguishing regressions plus
sparse-v5-enrollment, historical ownership-open failure after earlier reservation,
and final synchronous scan deadline/freshness expiry. One bounded SolHigh
correction bundle, followed by scoped review and affected regression; no new
resource/authority assumption. Original candidate manifest
acb8c0ec68a7fb97f8055538773b221ba67a57d0eb5f652882f2eaff9f43c52e
remains evidence, not accepted. Review verification13:19:10–13:20:11UTC; review
began earlier without its own clock stamp. No fabricated active interval.

Wallet correction candidate: allthree P2 fixes accepted by scoped AstraHigh
follow-up13:27:31–13:27:41UTC. Final14-file manifest SHA256
078d6a8918d72efbb28264acaf877445fa4b6f1311a153a28a537f756210b23e;
only managedwallet and proof tests changed from the first review. Final focused
24/24 passes67.42s, `/tmp/wallet-v7-review-correction-focused.log`, including
all required discrimination cases. Private update4514.73ms; reopen2580.68ms
(~86% of unchanged3s local allowance);148reads/2handles and storage metrics
unchanged. No cold/p95 claim. Frozen13:29:07UTC, core/nodecompile passes.
Parent composed regression covers remaining12 affected core/legacy/private/API/UI
files without repeating the unchanged101-profile scenario.

Shared quota before bounded next-cycle contract review72% (walletentry67%);
account-wide and not task-attributed. One AstraMedium read-only decision evaluates
actual100-cycle oracle feasibility and necessary prerequisites. No broad1000-fault
run, new implementation, changed budget or suspended-investigation retry is
authorized by this planning step.

Walletv7 final acceptance:69/69 remaining affected checks in12files94.38s pass
(`/tmp/resonance-wallet-v7-composed.log`), plus the unchanged reviewed24/24
proof/lifecycle checks:93 distinct checks across13files. All14 candidate file
hashes match the reviewed manifest. Workspace TypeScript passes; an attempted
nonexistent npm `build:server` command was corrected to the repository's actual
`npx tsc -p packages/app/tsconfig.server.json`, which passes. No application
source change or repeated heavy tests followed. Logs retain both command outcomes.
One correction round resolved three review P2s; the earlier efficiency correction
and parent mutable-input/API findings remain recorded above. This completes the
funded101-profile wallet prerequisite locally, not a complete K2/K3.

### Explicit next-line stop: all-role lifecycle qualification

Bounded read-only AstraMedium assessment, verified against current interfaces:
`history-ancestry-download.ts` refuses a65th unanchored continuation crossing
(depth>=64). An accepted compaction checkpoint may terminate traversal earlier.
`parseHistoryCompactionProposal` refuses policy-observer, admission-issuer and
admission-allocation-authority roles because existing ciphertext certificates
lack semantic ancestry evidence. Relay compaction alone does not establish
these roles' recovery guarantees. Existing composed consumer qualification
recovers generation0→1;100 signed policy transitions or101 wallet profiles are
not100 rotation/recovery/compaction cycles.

Therefore the all-role100-cycle/1000-fault qualification cannot honestly close
K2 with the accepted interfaces. This is stop condition4 for that line: a
missing semantic protocol/evidence decision, with the historical authority
retirement investigation still unavailable and suspended. No new safety loss
has been reproduced, no guard removed, no history/deadline/quota cap raised and
no suspended investigation retried. Historical effort/alternatives are retained;
an unknown earlier total is not zero. The completed wallet and quorum-fixture
work is retained independently; hosted qualification is still separate.

Owner-facing decision: resolve how the required semantic evidence can be
established before authorizing a new all-role recovery design/qualification
block. Recommended direction is authenticated bounded recovery with preserved
original obligations, not increasing64 or declaring100 rotations sufficient.
If that evidence remains unavailable, suspend this qualification line rather
than run1000 tests of an incomplete contract. A one-cycle relay-only integration
oracle is possible but would explicitly leave issuer/observer/authority stages
blocked; do not present that extra helper as closing this decision. K3 also
still requires same-key replacement and emergency/reconnection measurements.

### Owner-approved semantic-evidence decision block

The owner approved resolving the evidence gap before the1000-fault campaign.
Same B-HISTORY-LIFECYCLE/K2,K3 blocker; no historical effort/alternative reset.
Entry shared quota74%, ordinary usage allowed. AstraHigh performs one bounded
constructive interface review: identify complete retained obligations, verifier
identity and the minimal executable non-authorizing evidence check available
under existing encrypted-history/four-of-five trust and resource assumptions.
No destructive compaction, guard removal, cap increase, plaintext disclosure or
retry/rephrasing of the suspended historical investigation. Outcome must be an
implementable acceptance contract or the exact unavailable trust/resource
decision, not another generic wrapper that reports already-known blocked stages.
Sol implementation follows only a concrete frozen contract. Existing Mac
CI39261276579 continues independently; no new suite or installer was started.

### Constructive review outcome: paged original-evidence replay (pending approval)

AstraHigh's bounded review found that existing genesis-to-selected-proposal
replay is already the semantic oracle. Another comparison/report wrapper would
not supply independently verifiable evidence for shortened history. Volunteers
authenticate ciphertext retention and chain selection; they cannot attest to
the encrypted semantic obligations. Keep all three semantic compaction guards.

Proposed versioned contract: retain all original encrypted proof and independent
genesis pins; reconstruct every obligation by complete replay at the authorized
recovering keyholder. Change the current lifetime depth64 bound to64 per page,
sharing existing total byte, block, funded-storage and applicable deadline
budgets across every page. Page-boundary state remains provisional and cannot
authorize restore or operations. Freshness/write readiness remains separate.
No deletion, released reservation, new trusted party or public plaintext.

This changes a resource contract and remains subject to owner approval under
stop condition4. The decision question has been sent; no dependent code is
authorized or implemented yet. Acceptance, if approved: histories exceeding64
continuations preserve exact obligations under unchanged aggregate budgets;
missing/reordered pages, boundary mismatch and aggregate exhaustion refuse;
serialized intermediate state cannot authorize; existing bounded histories
remain compatible. If complete proof cannot fit existing aggregate resources,
retain the failed result and stop for decision rather than enlarge budgets.

Independent hosted evidence at de3840b: Mac durability completed328/329 tests;
the101-profile lifecycle failed with fetch failed/read ECONNRESET. This log does
not establish a deadline failure or its cause. Local-ownership and desktop
boundaries passed; general tests were still running at this observation.
Log: /tmp/resonance-de3840b-durability.log. One bounded SolMedium read-only
diagnosis examines the real HTTP fixture/request lifecycle before any correction
experiment. No retry of the full suite or installer was started.

### Owner approval and first correction experiment (October19)

Owner explicitly approved64 generations per page with unchanged aggregate
resources. Approval resolves the resource-decision gate only, not K2/K3 or
semantic compaction. Retain the three guards and complete original evidence.
Entry account counter76% weekly used (shared, ordinary usage permitted).

First bounded deliverable: isolate the wallet101 HTTP fixture from idle pooled
connection reuse, preserving the real app/private route and all resource and
timing assertions. SolMedium owns only wallet-policy-proof.test.ts: label
HTTP/JSON failures with method/path and original cause, and request explicit
Connection: close. Run the exact failing lifecycle once. Hypothesis: an idle
pooled socket can reset between the initial unlock and99 transitions; existing
CI lacks path evidence, so passing the isolated fixture does not prove historical
causation. Any new failure is retained and diagnosed without retries, limit
increases or broad reruns. Parent reviews the small fixture diff. This is a
necessary hosted-validation correction under the same B-HISTORY-LIFECYCLE,
not a new architectural alternative. Paged-replay implementation follows it.

Fixture correction accepted by parent review: single targeted lifecycle passes
1/1 (23 unselected),58.37s total on Node24.19.0. Private update4736.68ms,
reopen2554.21ms under unchanged3000ms;148 page reads,2 peak handles,
242 records/3,170,439 bytes. Log /tmp/resonance-wallet-ci-reset-focused.log;
measurement /tmp/resonance-wallet-ci-reset-measurement.json. Test file SHA256
a24cfacc2715b7275f8803a8f73ddef34cb1d5eb40fc8e2d693ac5f9adf6cabc.
No production change, retries or extra suite. Original reset cause unproven.

### Frozen implementation: original-evidence ancestry paging v2

Same B-HISTORY-LIFECYCLE/K2,K3. SolHigh implements one coherent download/replay
change, with scoped AstraHigh review before acceptance. Observable improvement:
an authenticated encrypted history crossing64 continuations can download and
replay all issuer, observer and allocation-authority obligations from original
independent genesis pins, without a semantic compaction certificate.

Use an explicit versioned paging contract shared by downloader and three replay
paths. Page boundaries carry chain continuity, never trusted semantic anchors.
All existing aggregate blocks/bytes/funding and applicable operation deadlines
cover every page; page transitions never reset them. Legacy within64 evidence
remains valid; persisted download compatibility must be explicit and tested.
Do not reinterpret an explicit resumable download attempt as an unlimited
single operation, or let internal paging replenish an attempt's time budget.
Original encrypted evidence remains funded and retained. Keep compaction guards,
freshness gates, local pending/applied evidence checks and restore capabilities.

Focused evidence before review: >64-continuation authentic chains for each role
with independently expected retained obligations, download/reopen across a page
boundary, missing/reordered/misbound boundary rejection, aggregate block/byte/time
exhaustion across pages, partial/serialized page state unable to authorize.
Then one affected composed regression plus workspace compilation after review.
No1000-fault campaign, installers, resource increases, semantic pruning or
suspended historical investigation. Any inability to fit existing resources is
a recorded decision gate, not permission to enlarge them. Historical effort and
alternative counts remain attached to the same blocker.

Pre-edit operational inspection found a necessary prerequisite omitted by the
download/replay contract. history-checkpoint-store.ts charges two2MiB manifest
reserves for every retained generation (requireContinuation), plus actual
ciphertext, against MAX_ANCESTRY_BYTES256MiB (validateParent/fits). Thus64 retained
generations already consume256MiB before positive ciphertext; at most63 fit,
and only if their ciphertext fits the remaining4MiB. Additional lifetime64
depth guards exist in the store. All three semantic roles still reject the
existing compaction-frontier route. This is reservation arithmetic, not measured
proof size, data loss or an investigation of historical retirement.

SolHigh paused before any code/test changes at0ca9ebb. Downloader/replay-only
qualification would not establish operational feasibility and is not proceeding.
One bounded AstraHigh review evaluates whether a versioned shared metadata
representation can retain all original encrypted proof, ownership/activation/
freeze/pending evidence and truthful reserves under unchanged aggregate limits.
This is the same blocker/prerequisite, not a reset of alternatives or effort.
No larger limits, smaller unbacked reserves, guard removal or suspended
investigation is authorized. If no concrete compatible representation exists,
report the exact resource/trust decision rather than implement an unused helper.

### Frozen prerequisite: shared original-evidence storage v2

AstraHigh constructive review identifies a representational route with no new
trust/resource assumption: explicitly selected shared storage for one pinned
genesis/context/replica; unchanged original signed ciphertext blocks; immutable
encrypted full generation manifests and provisioning records, including all
superseded versions; authenticated descriptor pages of at most64 generations;
one bounded atomic encrypted catalog under shared ownership. This supersedes
the downloader-only implementation scope above; Sol made no edits to that scope.

Preserve durable parent activation → creating intent → complete child → ready
publication. Handles share one owner; a second representation cannot independently
write the same generation. Before creation reserve all objects, old versions,
staged/interrupted files, catalog replacement/ownership peaks and controls.
Existing monotone reservation authority remains authoritative. All aggregate
byte/block/funding/deadline limits remain unchanged across pages. No evidence
reclamation. Legacy stores remain readable; migration, if supported, charges
overlap and never credits old reservations. Exhausted migration may refuse.

One bounded SolHigh implementation/correction block, followed by one scoped
AstraHigh protocol review and affected composed regression. No parallel
implementation or broad1000-fault run. Shared weekly counter77% at expansion
(entry76%; account-wide, not agent attribution). Review/design and implementation
effort remain on B-HISTORY-LIFECYCLE; prior unknown hours remain unknown.

Falsifying qualification is a real-store100-transition/recovery workload for the
three semantic roles, independently expected obligations, checkpoints at65 and
101 generations, original-genesis reopen/replay, and durable reservation plus
peak-file measurement including interrupted publication. No fabricated chain
bypassing the store can establish this acceptance. Missing/altered/reordered
objects, competing ownership, interrupted creating/ready publication and
aggregate exhaustion must refuse without accepting partial state. Legacy
compatibility/overlap need explicit tests if migration is included. Any evidence
mismatch, unreserved output or exceeded unchanged resource/deadline bound
rejects this candidate and triggers the existing stop-policy assessment.
The implementation must expose an actual operational path through the volunteer
service/provisioner, not merely a standalone unused pool. This prerequisite does
not itself satisfy K2's1000 diverse faults or authorize semantic compaction.

Prior candidate de3840b hosted CI finished: general3350/3352 in362files;
wallet101 repeats the same ECONNRESET, and protected-admission-consumers-v3's
65-archive integration reports Archive operation cancelled or timed out while
admission-policy-history-proof.images charges its budget. The trace alone does
not locate the owning operation. Both owner-loss collection receipts pass
(issuer3269ms,relay85ms, allowance30000ms). Thus this is not the former collection
timeout. Durability328/329, ownership and desktop pass. Full logs retained at
/tmp/resonance-de3840b-general.log and /tmp/resonance-de3840b-durability.log.
No repeat CI or increased deadline; isolate the additional hosted proof deadline
after the active shared-storage candidate, preserving its existing allowance.

### Shared-storage candidate review: rejected, stop condition1

Frozen source/test manifest /tmp/resonance-original-pool-v2-candidate-manifest.json
SHA256fb3da37fe49a065b4f2a9c095da886ecc3f77c87684345738459080bb05a0db5
contains17 files on0ca9ebb. First focused run69/71 in514.67s: all three real
five-replica100-generation-transition workloads pass original-genesis semantic
replay at65/101, but two error-message assertions fail. Those assertions and
new bounds/expiry checks form one correction bundle;3/3 narrow reruns pass.
The observer's amended cross-page download budget cases run separately; do not
count this as full K2 owner/readiness/compaction qualification. Voting replica
accounted peaks at101 are27.71–27.81MB within268,435,456bytes; process RSS snapshots
include all five replicas/test overhead and are not single-relay K7 qualification.

Scoped AstraHigh review matched the frozen hashes and REJECTED this candidate:

1. Zero-additional capacity checks do not hold all activation/creating/child/ready/
   successor-journal output. Capacity exhaustion after durable ready can leave
   every reopen unable to create the child's routing journal.
2. Retained immutable ciphertext published before its generation manifest cannot
   be reused by exact append retry; repeated reopen does not fix the orphan.
3. Per-generation checkpoint promises are not charged against aggregate pool
   bytes/blocks plus immutable publication metadata, allowing promises that the
   pool cannot fulfill.

These are structural counterexamples to the frozen recovery/publication contract,
so stop condition1 applies even though nominal101-generation tests pass. Source
implementation/integration/composed testing stopped. Sol may finish the running
observer test and add only minimal distinguishing contract regressions; no source
repair is authorized by this receipt. Preserve the failed candidate and evidence.
Owner decision will be a bounded repair of whole-publication reservations and
idempotent retained-block reuse, or suspension of this shared-storage candidate.
No budget increase, guard removal, release, merge or KPI completion is implied.

Stop evidence is now executable: history-shared-pool-stop.test.ts fails all three
intended safe-contract assertions in2.23s (command2.67s). Publication calibration
reaches durable ready with60,392 arena bytes plus4,202,496 control bytes, but the
same-bound successor journal fails before/after reopen. Exact interrupted append
retries fail on two reopens with old manifest head still sequence0. A pool with
four block slots accepts its fourth delta despite a4096-byte future checkpoint
promise, then refuses that checkpoint. Encrypted directories and receipts remain
at the paths recorded in /tmp/resonance-pool-stop-{publication,orphan,checkpoint}.json;
full log /tmp/resonance-original-pool-v2-stop-repros.log. No production correction.

The running observer correction completed1/1 in189.63s with cross-page download
block/byte/time refusal checks. Final retained18-file manifest
/tmp/resonance-original-pool-v2-stop-manifest.json has SHA256
0a29a9f7864ae0b1d34a0c61384c09d2e18220285ac3dca5879f7e18d34a05a7;
the17 reviewed candidate files remain byte-identical, only the stop test was
added. Core/relay/node compilation passes. No composed regression or candidate
commit/push/merge/release followed. The rejected candidate remains local and
uncommitted for review, with intentionally failing regressions.

Recommended concrete repair decision: one bounded SolHigh correction of durable
whole-publication capacity holds, idempotent authenticated orphan adoption and
aggregate future-checkpoint promises; same limits and retained evidence. First
turn the three counterexamples green, then scoped AstraHigh re-review of changed
invariants and one affected regression. Do not repeat100-transition workloads
without a relevant changed path. Alternative: suspend this storage representation.
Exit shared weekly counter82% vs entry76%, expansion77%, pre-review80%; these
are account-wide counters, not a cost attribution. Historical active effort and
alternatives are not reset; exact past totals remain unavailable.

### Owner-authorized bounded repair

Owner explicitly approved the proposed repair after the three reproduced stop1
counterexamples. Entry shared weekly counter82%, ordinary usage permitted.
One SolHigh repair of full-publication durable capacity holds, authenticated
retained-block adoption and aggregate future-checkpoint promises; unchanged
resource/trust limits, original evidence retained, same B-HISTORY-LIFECYCLE.
First run the three existing stop regressions with their safe expectations
preserved, adding only distinguishing crash/reopen/capacity cases required by
the repair. Then scoped AstraHigh re-review and one affected composed regression.
Do not remove guards, reset historical effort, relax thresholds, run installers
or merge. The additional hosted policy-proof deadline remains a separate pending
validation issue. No new architecture alternative or complete KPI is implied.

Repair first check: the three original stop regressions now pass3/3 in2.41s
(command2.78s), /tmp/resonance-pool-repair-three.log. Low-capacity publication
refuses before activation; a separately funded publication includes its child
routing journal. Exact orphan retry persists its new head, subsequent retry is
idempotent, and the fourth-slot delta refuses before acknowledgment. The orphan
test correctly expects the new head after its first successful retry, rather
than the original failing candidate's unchanged head on every reopen.
Core/relay/node compilation passes. Extra distinguishing hold/reopen/interference
and promised-checkpoint byte/metadata cases are pending before frozen re-review.
No composed regression, repeated101-generation workload or acceptance yet.

Repair expanded boundary check first returned4/9: five failures were one
allowlist implementation mismatch (array versus canonical encoded sequence
index). Corrected using readHistorySequenceIndex with exact root/sequence/count;
same nine cases now9/9 in5.79s, command6.26s, log
/tmp/resonance-pool-repair-canonical-nine.log. Includes early publication-hold
SIGKILL, provably unstarted append cancellation, same-root interference, retained
checkpoint capacity/metadata, partial and complete orphan metadata retries.
Frozen18-file manifest /tmp/resonance-pool-repair-review-manifest.json SHA256
64557aad635867b58f47492f04ab6d308ac9e47ad26b053a682165aea56f67f0.
Only pool/store/provisioner and two related tests differ from rejected baseline.
Core/relay/node and whitespace checks pass; no heavy/composed tests or push.

Scoped AstraHigh re-review is active. Sol explicitly flagged fresh authorization
after expiry during selected transfer: the exact target digest currently binds
request fields; review must resolve whether an interrupted logical operation can
retry with a fresh valid frame. Do not hide this concern behind the9 passing
cases. Shared weekly counter84% vs repair entry82%, account-wide.

### Bounded repair re-review: acceptance withheld

AstraHigh matched the frozen18-file manifest and found two remaining P1
selected-transfer defects. First, the final predecessor of a descending
sequence3→2→1 recovery is present in the accepted index but is neither its
head nor in the now-null transfer; append-hold admission and release reject
it. Second, ciphertext retained before manifest publication pins the expired
authorization in the target digest, rejecting a fresh valid equivalent request
and preventing cancellation because physical output exists. The review
structurally accepts the original three repair areas, not the overall candidate.

Stop1 assessment: these are reachable recovery correctness counterexamples
in the new hold mechanism. Production edits and composed regression are frozen.
SolHigh has one tests-only task to retain minimum distinguishing reproductions;
no heavy workloads, new protocol design, commit, push or release. No additional
repair loop is implicitly approved. Shared weekly counter85% used versus82%
at repair entry, account-wide and not attributable to individual agents.
Historical budgets and alternatives remain unchanged.

Both review counterexamples are now reproduced with real five-replica signed
view/proposal/authorization frames. Filtered run:2 failed expected-contract
assertions,9 skipped,1.63s Vitest /1.93s command. Log:
/tmp/resonance-pool-stop-selected-transfer-final.log. Receipts:
/tmp/resonance-pool-stop-selected-predecessor.json and
/tmp/resonance-pool-stop-selected-expiry.json. Errors match the review exactly:
`Append hold omits its target reference` and `Wrong held append target`.
Reopening preserves the original sequence0 accepted head and no prepare vote;
the expiry case preserves ciphertext and held resources, but cannot resume.
No data-loss claim follows from these availability/recovery failures.

Final18-file manifest /tmp/resonance-pool-selected-stop-manifest.json SHA256
531a24c2c5803a9e1323f6e1110c0d9243d995ffa62785d070dffea216d95da9.
Parent inspected tests/receipts and verified only the stop-test file differs
from the frozen reviewed manifest. No production edits or broad reruns.

Stop1 is confirmed. Recommended next owner decision: one correction restricted
to selected-transfer hold identity and completion, with these two regressions,
negative different-target authorization checks, scoped review and then the
already-declared affected regression if accepted. Preserve exact immutable
output adoption and all funding/retention/authentication bounds; renewed valid
authorization must not authorize a different operation. Alternative: suspend
this storage candidate. Do not integrate the rejected repair or claim K2/K3.

### Owner-authorized selected-transfer correction

Owner explicitly authorized the proposed two-case correction. Entry shared
weekly counter86%, ordinary usage allowed. Same B-HISTORY-LIFECYCLE / K2,K3;
no reset of historical effort or alternatives. SolHigh owns only selected
transfer hold identity/completion and distinguishing tests. Acceptance: both
retained regressions pass; renewed authorization is validated live, changes
only authorization freshness for the same immutable operation, and cannot
redirect a held target or bypass immutable staged-output identity. Include
negative different-target cases and interrupted metadata adoption as required.
Preserve all retention, capacity, legacy and semantic compaction guards.
Then scoped AstraHigh review and one affected composed regression if accepted;
no installer, release or merge.

Post-review composed regression is preselected from changed paths (one serial
worker to avoid competing workload): shared-pool and stop regressions;
checkpoint-store; agreement-data and agreement-data-crash integration;
provision, provision integration and provision reservations; volunteer-service;
ancestry-download unit/integration; issuer and allocation-authority replay;
original-pool observer101. This covers storage/transfer/provision shared paths,
legacy service/download behavior and all three real101-generation workloads.
It runs once after acceptance of the corrected frozen candidate. Compilation
uses core/relay/node plus desktop server if integration reaches that stage.
A failure is classified before another run; no automatic full-suite repetition.

Selected-transfer correction first focused run14/14 passes8.74s (9.30s command),
/tmp/resonance-pool-selected-repair-focused.log; core/relay/node compilation
and diff-check pass. First handoff manifest3a227ee8ca0ce092b438c2ee7f904f31724a51b78ebe762b8a420d3018a0d269
was withdrawn before integration: implementer identified the same exact-operation
binding must cover complete selected commits (transfer:null), not just staging.
Reviewer was notified to pause pending corrected frozen candidate. This is an
in-scope completeness correction, not accepted evidence or a new architecture.
Only pool/store/stop-test differ from the rejected baseline. No composed run.

Final selected-transfer candidate15/15 passes9.04s (9.55s command),
/tmp/resonance-pool-selected-repair-final-focused.log; core/relay/node compile
and whitespace checks pass. Frozen manifest
/tmp/resonance-pool-selected-repair-final-manifest.json SHA256
7fa1ed0497769b919b3dfba794b6bfd3f451cdbf846529c09ba84636e436dbeb.
AstraHigh verified hashes and gives limited acceptance with no actionable
findings: exact sequence→block identity, live equivalent authorization including
complete/one-block transfers, unchanged immutable metadata digest/nonces, and
expanded hold capacity preflight. No tests repeated by reviewer. Parent verified
source hashes before starting the preselected14-file serial composed regression.
This is repair acceptance, not K2/K3 qualification.

Affected composed regression completed219/221,13/14files pass in886.99s,
/tmp/resonance-pool-reviewed-composed.log. All three real101-generation role
workloads finish: issuer197.9s, authority193.3s, observer234.4s; maximum recorded
replica peak27,820,978B under268,435,456B. Original full-lifecycle/KPI limits
remain unqualified. Only failures are the two pre-repair shared-pool primitive
object-interruption tests: first-write injection now hits catalog preflight
rather than immutable object output, and asserts old random temporary names
rather than deterministic pending paths. Assigned tests-only correction to
SolHigh preserving0/17-byte retention accounting and original authenticated
state. No production modification or repeated101 workloads authorized by this
fixture correction. Full passing composed claim withheld until it is checked.

Fixture correction reviewed by parent: only actual version2 object ciphertext
is interrupted, exactly one deterministic pending file has0/17bytes, and prior
authenticated state, exact extra-byte accounting and later successful publication
assertions remain. Two cases pass1.41s /1.99s command,
/tmp/resonance-pool-object-fixture-correction.log. Manifest
/tmp/resonance-pool-post-composed-fixture-manifest.json SHA256
02ceb963f1008fe6e65349579cef6416bc47c4adb57ab240a8552dfc2840801f.
Parent hash check confirms only that test differs from reviewed production.
Combined evidence covers221 distinct checks:219 in the composed run plus the
two corrected fixtures; this is not a claimed fresh221/221 single execution.
No heavy rerun is justified by this tests-only change.

Selected-transfer block used SolHigh implementation and AstraHigh scoped review.
One initial handoff was withdrawn for complete-transfer auth binding before
review acceptance; final focused15/15 and scoped review pass. The composed run
required one tests-only correction, no further production changes. Entry shared
weekly86%, exit88%; this is account-wide, not per-agent attribution. Earlier
repair costs, alternatives and unknown historical active effort remain retained.
No complete KPI:101 generation transitions and original-genesis replay do not
replace100 full lifecycle/compaction cycles or1000 diverse fault scenarios.
Next independent validation issue remains hosted protected-consumer restoration
archive deadline; previous CI error lacks a precise restoration substage.

Workspace TypeScript build including desktop server passes: `node node_modules/typescript/bin/tsc -b`, log /tmp/resonance-pool-reviewed-workspace-compile.log. No installer was built.

### Hosted restoration deadline diagnosis

Reviewed shared-pool prerequisite committed8f62671, following local wallet-fixture
commit0ca9ebb; neither pushed yet to avoid duplicate CI. Next bounded work under
B-HISTORY-LIFECYCLE is the already-observed protected-consumer restoration
archive timeout in hosted run39261276579. Goal: identify exact owning operation
and deadline contract, then make only a supported correction or retain precise
instrumentation if local evidence cannot distinguish cause. Existing3s protected
decision,30s approved offline reconstruction and all storage/read limits remain.
Start from retained CI log and restoration call graph; no broad suite, speculative
timeout increase or historical retirement investigation. Any local reproduction
is the single existing65-archive case with fixed settings. SolHigh bounded
diagnosis; parent owns integration. Shared entry88%; historical counts persist.

Read-only diagnosis found a concrete budget distinction but no proven failing
caller: issuer/relay replay30s outer bounds contain proof-reference3s traversal;
issuer open selects30s offline startup, protected observation stays3s. Parent
added only before-operation stages splitting both recoveries, preparations,
open/ready and issuer approval. The existing65-archive case passes1/1 with26
skipped in88.59s, /tmp/resonance-protected-restoration-stages.log. No deadline,
production code or test assertion changed. This local pass does not resolve
the hosted failure; retained stage labels will identify its caller if repeated.
The next push contains the stable reviewed storage repair, earlier wallet fixture
correction and these test-only diagnostics; routine CI remains Mac-only and
installer workflow is tag/manual only.

### Hosted qualification blocked by unavailable failure evidence

Push confirmed de3840b→63007164c995c1a997c22811a9da0ce1a38c1b45
on feature/v0.4-private-transport. CI39306434650 started on that exact SHA:
https://github.com/Planetary-e/resonance/actions/runs/39306434650 .
Mac TypeScript build passed. Last successful API snapshot: desktop-boundaries
job118244619362 completed failure; test, admission-durability and local-ownership
still in progress. No inference about their later outcome is justified.

Failure evidence is unavailable: gh run watch lost api.github.com connection;
gh run view --job --log refuses logs until whole-run completion; direct job-log
API then failed connecting to productionresultssa3.blob.core.windows.net; job
step-detail API also failed connecting to api.github.com. No test failure cause
or timeout cause was obtained. Local log targets
/tmp/resonance-6300716-ci-watch.log and
/tmp/resonance-6300716-desktop-ci.log retain only available output (the latter
is empty because the download failed). No workflow was restarted or cancelled.

Stop4 applies to hosted qualification: exact failure evidence requires restored
GitHub API/log access. Reviewed local correction and221 distinct checks are
retained; do not certify CI, K2/K3 or release. Next action is one status/log fetch
for this same run once access returns, classify its actual failure before edits
or reruns. Last available shared quota88%; later consumption is not inferred.
This receipt/checkpoint remains local to avoid triggering another CI merely for
documentation while the candidate's CI is unfinished.

### Resume: observer retained-archive version compatibility

User requested continuation. API remained unavailable, but read-only IAB access
to CI39306434650 exposed job annotations: desktop observer recovery3 failures
and local-ownership observer archive/config/CLI/outbound failures consistently
throw `Encrypted outbox state is invalid` at policy-observer-archive.ts:29.
Run still in progress at observation; no general/durability outcome inferred.
Source identifies a version integration mismatch: new downloads initialize
State.version2, while openRetainedPolicyObserverArchive accepts only version1.
This is a necessary compatibility correction under B-HISTORY-LIFECYCLE, not
a changed trust/resource assumption or evidence of data loss. No authentication
relaxation, semantic compaction or replay deadline increase is authorized.

Bounded SolMedium task: reproduce one existing observer recovery failure,
accept exact v1/v2 original-evidence manifests in the read-only retained archive
reader, preserve all other schema/pin/size/integrity checks and no writes/network.
Test both supported versions and unknown/extra-field rejection without weakening
existing corruption/conflict tests. Scoped review then affected observer archive,
CLI, desktop and outbound checks only; no101-generation repetition. Entry shared
weekly90%; historical limits and unknown effort remain.

Coverage correction: the prior14-file regression covered writer/download/replay
but omitted the independent retained observer archive reader used by desktop
and CLI recovery. This omission explains why a version integration regression
escaped local qualification; generation101 replay alone is insufficient. The
affected composed selection for this fix is policy-observer-recovery-command,
policy-observer-outbound and desktop policy-observer-recovery integration files,
plus focused reader format cases. Existing issuer/relay ancestry source uses
createHistoryAncestryDownload itself, which already accepts versions1/2; no
second independent version-restricted reader was found in the scoped search.
Do not push again until the existing run's useful remaining evidence is captured.

Compatibility correction: unchanged reader reproduced exact CI failure in2.33s,
/tmp/resonance-observer-archive-version-before.log. Two-line production fix plus
focused validation passes4/4 in10.95s. Scoped AstraHigh review gives limited
acceptance with no actionable findings: exactfields/context/proposal/blocks,
complete replay, legacy read-only behavior and compaction refusal remain.
Affected composed regression passes22/22 in3files75.95s,
/tmp/resonance-observer-archive-version-composed.log. Entire workspace TypeScript
including desktop server passes, /tmp/resonance-observer-archive-version-workspace-compile.log.
No101-generation repetition or deadline adjustment. SolMedium implementation
and first-pass AstraHigh review accepted, no production rework. Entry shared90%,
implementer exit91%, account-wide; no per-agent cost attribution.
Candidate packages/relay/src/policy-observer-archive.ts: SHA256 3469d41c2cc2dfd04c1c2dffac8d2d52df16013486f7699933f0da9216313428.
Candidate packages/relay/src/__tests__/policy-observer-recovery-command.integration.test.ts: SHA256 87c19eab58d7143cab9c39fdef0ddd614f60291b088c62da60b6148405912e6e.
