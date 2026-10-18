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
