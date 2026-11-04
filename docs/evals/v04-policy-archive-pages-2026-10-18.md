# Authenticated policy archive pages: prerequisite

Parent: **B-HISTORY-LIFECYCLE / K2 and K3**. This continues the existing blocker,
not a new alternative or budget. Entry shared weekly usage: **5%**.

## Contract and acceptance before implementation

Hypothesis: immutable, content-addressed pages can preserve the exact permanent
archive derived from independently authenticated policy history, while bounding
individual page parsing and aggregate traversal. This supplies a prerequisite
for a future signed policy format; it does not activate that format or compact
any original history. Existing v2 cannot authenticate a 65th archived entry.

Keep existing policy versions, signatures, limits and consumers unchanged. Add
an isolated `@resonance/core/admission-policy-archive` module. Pages contain a
version/kind, context ID, previous page digest, consecutive index, first-entry
offset and 1–64 normalized `AdmissionPolicyKey` entries. Fixed page ceiling:
512 KiB. A descriptor binds version/kind, context ID, root (null iff empty),
page count, entry count and aggregate canonical page bytes. Domain-separate
page digests. Deterministic chunking respects both count and byte limits;
appending never rewrites a previous page, even if partially filled.

Expose bounded page encoding/decoding/digests, verification, authenticated append
and archived-key lookup. Verification accepts independently pinned observer
context, original signed genesis, complete immediate signed advances, an explicit
selected terminal head, descriptor, reader, limits and cancellation. Use existing
policy signature, advance, head and successor validators. Derive the expected
archive from that history and compare the complete supplied archive. A hash root
alone establishes neither authenticity nor freshness. Return an opaque runtime
handle that rejects forged/cloned/serialized capabilities; historical verification
is not authorization to serve current traffic.

Append accepts that handle and an authenticated immediate successor, returns
staged immutable pages plus a new descriptor/handle, and publishes nothing.
Lookup validates required content before returning either a match or absence;
reader changes cannot inherit earlier verification. Snapshot caller inputs before
awaiting. Preserve exact profiles, witness pins and cutoffs, permanent archives,
global issuer uniqueness, final retry cutoffs and fresh-period rotation semantics.
Reject missing/extra/reordered/substituted pages, gaps/forks, wrong original pins,
stale/conflicting selected heads and incomplete provenance.

Explicit cumulative limits cover pages, entries, archive bytes, input-history
bytes, transitions, page reads and timeout; cancellation and exhaustion refuse
without mutating accepted state. Count rescans; do not hide an unbounded in-memory
index behind bounded pages. This first verifier's retained authenticated policy
metadata is bounded by existing v1/v2 limits and the explicit history budget.

Acceptance: canonical page round trips/count and byte boundaries; real signed
v1→v2 conversion, append and reopen with identical roots; invalid signatures,
pins, heads, semantics and archive data refuse; reader changes and forged handles
refuse; cancellation and every aggregate limit are covered. Exercise mechanical
page chains beyond 64 entries separately and label them unauthenticated mechanics,
not a valid v2 migration. Existing v1/v2 regression and 64-entry refusal must pass.
A failure preserving accepted semantics invokes the existing stop policy; do not
weaken a test or silently claim that page mechanics complete K2.

## Required next integration

A future policy must sign the archive descriptor, and observers must authenticate
its policy digest. Durable page replication and funded reservation must precede
publication. Wallet profiles, role retirement fences (currently 72), recovery
ancestry limits, exact denial lookups and protected history replay need explicit
migration. Pages never replace original policy/role ancestry in this prerequisite.
Finite funded storage supports a declared horizon, not infinite rotation.

## Review receipt

Astra High reviewed the contract at 18:29:07–18:29:57 UTC (50 seconds), with a
brief initial inventory not precisely timed. It approved the prerequisite within
these limits; no code/tests or retirement investigation were performed. Shared
usage observed during that review stayed at 5%; this is not exact attribution.

## Implemented prerequisite

Sol High implemented the isolated module and package export, with no live policy
format/consumer changes. Its active interval was approximately 18:30–18:36:38 UTC
(6.6 minutes). One focused run passed **35 tests in four files** in 1.42 seconds:
new archive-page tests and existing policy archive, trust and rotation regressions.
TypeScript build and whitespace validation passed. The 129-entry mechanical test
is explicitly unauthenticated; v2 still refuses a 65th archived configuration.

Astra High independently approved the frozen implementation at
18:36:57–18:37:30 UTC (33 seconds), with no corrective cycle or repeated test run.
The coordinator verified the reviewed file identities:

- Module: `5682b6cc05833fd343ce290f05a394774fe6ded0965a97e0fe4d15d2b75af9ad`.
- Test: `1d2f9903ef038502d88350651da31351baa91a2a7832aaaf2de5a4550b73fd22`.
- Package export: `824cbaabadf5f47f69ea3bcc09a05875f2dc9b48f1c05ad49e00f78348b05c95`.

The last shared quota observation during review was **6%**, compared with 5% at
block entry; it does not attribute cost to this task or establish savings.
First implementation review passed. No live migration, funded replication,
current authorization, retirement safety or complete K2/K3 result is claimed.

Independent CI maintenance adds the four new authority recovery/resumption and
CLI/crash suites to the explicit three-OS admission-durability job. All 26 listed
paths exist and are unique, with the same three OS targets and 15-minute cap.
This corrects missing explicit cross-platform coverage; local results for those
four suites are retained from the previous block instead of repeated here.
