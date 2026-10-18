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
