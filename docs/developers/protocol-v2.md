# Resonance Discovery Protocol v2

Status: draft implementation contract for `v0.2 — Protocol v2 and Unlinkable Activity`.

## Objective

Protocol v2 makes a publication independently authenticatable, replicable, renewable, and withdrawable without attaching the user's root identity. A relay may correlate the replicas and lifecycle of one publication. Protocol identifiers do not give it a way to connect that publication to the user's other publications, searches, mailboxes, or relationships.

## Threat Model

The protocol considers four observers:

1. **A curious relay** follows the protocol while recording identifiers, fingerprints, connections, timing, searches, and matches.
2. **A malicious relay** may drop, replay, delay, alter, invent, or selectively forward operations.
3. **A network observer** sees endpoints, timing, direction, and message sizes. Encryption alone does not conceal this metadata.
4. **A matched peer** receives information intentionally disclosed during matching and conversation.

Several relays may collude. Protocol v2 removes stable application identifiers but does not yet provide transport anonymity against colluding relays or a global network observer. That work belongs to the private transport milestone.

## Identity Boundaries

| Scope | Lifetime | Visible to relays | Purpose |
| --- | --- | --- | --- |
| Root identity | User controlled | Never | Recovery and device authorization |
| Relay identity | Relay installation | Yes | Authenticate infrastructure operations |
| Publication key | One publication | Yes | Sign publication revisions and tombstones |
| Mailbox key | One publication | Public half only | Receive encrypted match envelopes |
| Search key | One request | Yes | Authenticate a request without establishing history |
| Relationship key | One accepted match | Counterparty and relays carrying that relationship | Pairwise conversation |
| Relationship mailbox key | One accepted match | Public half and mailbox ID only | Asynchronous encrypted conversation delivery |

A device that operates a relay and a personal node uses independently generated key material for the two roles. No root signature, derivation path, shared identifier, or protocol field connects them.

### Relay identity implementation findings

The first relay implementation generated an independent key, but stored it as unchecked JSON with a non-atomic write and ambient filesystem permissions. Independence at key generation was therefore insufficient: a torn or malformed file could make the relay fail unpredictably, while silent replacement would break the audit chain for every relay-signed match.

The v2 relay identity store now gives this boundary concrete properties:

- The store accepts only a versioned Ed25519 relay schema and verifies key lengths, the public/secret key relationship, and the DID derived from the public key.
- Creation writes and fsyncs a private temporary file before publishing it atomically. The identity file has mode `0600`; a permissive existing mode is repaired on load.
- Corruption, unexpected fields, and symbolic links fail closed. The relay never treats unreadable identity state as permission to rotate its key.
- A valid pre-v2 number-array identity is migrated to the versioned format without changing the key or DID.
- The storage API receives only the relay data directory. It neither imports the personal identity manager nor receives the root identity or a root-derived storage key.

Relay stability is intentional: the relay identity connects infrastructure operations from one installation so clients and replicas can audit their origin. It does not identify the device owner's protocol activity. Running both roles on one host can still reveal a common IP address, timing patterns, and local filesystem ownership to network or host observers; cryptographic key separation does not provide transport anonymity.

The relay key must be available for unattended background startup, so this version protects it with the operating system account and file permissions rather than the personal-node password. Moving it into a platform keystore can improve theft resistance later without joining its lifecycle to the user's root identity.

## Publication Operation

A publication is a canonical signed object containing:

- Protocol version and operation kind
- Opaque publication identifier bound to the publication public key
- Monotonic sequence number
- Publication-scoped Ed25519 public key
- Publication-scoped mailbox identifier and X25519 public key
- Matching group
- Fingerprint algorithm, size, epoch, and value
- Need or offer type
- Creation and expiry timestamps
- Ed25519 signature over every preceding field

The signed object contains no user DID. Relays verify it without contacting an identity provider. Exact copies intentionally retain the same publication identifier so replicas can deduplicate and repair them.

Canonical serialization sorts object keys recursively and uses a domain prefix before signing. This prevents field insertion order from changing the signed meaning and prevents a signature for one operation type from being reused as another.

## Revisions and Tombstones

The publication owner retains its publication-scoped private key. A renewal or update keeps the publication identifier and increments its sequence number. Relays select the highest valid operation sequence according to the conflict rules that will accompany the durable record store.

A tombstone:

- Identifies the publication and its public key
- Uses a sequence greater than the record it replaces
- States `withdrawn`, `expired`, or `superseded`
- Is signed by the publication key

Natural expiry is derived from the signed publication record; a relay does not forge an owner tombstone when the clock reaches `expiresAt`. The Hamming index carries that exact timestamp, excludes the record before limiting match or search results, and removes it with a timer scheduled for the earliest individual expiry. Startup rebuilds the index only from records active at replay time. A higher signed sequence may renew a naturally expired publication.

Owner-signed tombstones remain terminal and are retained indefinitely in the authoritative journal. In a volunteer network, a fixed garbage-collection deadline is unsafe because an offline replica may return after that deadline with a stale publication. Tombstone compaction must therefore wait for a future convergence proof, such as replica acknowledgements or a stable-set watermark, rather than assuming elapsed time means every replica observed the deletion.

## Match Operation

A match is a canonical relay-signed operation rather than mutable index state. It contains the stable logical match identifier, the two sorted publication identifiers, sequences, and publication signatures, the matching group and fingerprint parameters, the exact similarity, its validity interval, and the relay infrastructure identity and public key. The publication signatures bind the decision to the exact two revisions used by the matching engine.

Every relay derives the same logical match identifier for the same publication pair. Each relay attestation has its own operation identifier because it also binds the deciding relay, decision time, and expiry. Replaying the same operation is idempotent. A second relay may attest to the same publication generation without creating another logical match, while a match for newer publication sequences supersedes the older generation.

Relays audit a match operation against the two signed publications before accepting or replaying it. They recompute compatibility and Hamming similarity and apply their minimum threshold. Signature validity remains independent of wall-clock expiry so historical operations can be audited.

## Relay Operation Journal

The authoritative relay state is an append-only newline-delimited operation journal. Publication changes, mailbox deposits, and mailbox acknowledgements each become durable records. A match operation and its two encrypted recipient envelopes occupy one record, so restart recovery cannot expose half of a match delivery.

Before returning a successful acknowledgement, the relay appends the complete record and calls `fsync` on the file. It also syncs the containing directory when the journal is first created. Every record has a contiguous sequence and a digest over its canonical contents. Startup rejects a corrupt completed record, truncates only an incomplete final record caused by a torn write, replays the journal into materialized publication, match, and mailbox views, and rebuilds the Hamming index from active publications. Periodic JSON snapshots are no longer part of relay correctness.

## Encrypted Match Mailboxes

When two complementary publications match, the match identifier is the SHA-512-derived digest of the two sorted publication identifiers. Every conforming relay therefore derives the same logical match identifier without learning a user identity.

The relay creates a separate signed notice for each participant. A notice contains the signed match operation, the recipient publication, the partner publication and mailbox public data, the similarity score, and its expiry. It is encrypted to the recipient's publication-scoped X25519 mailbox key using a fresh ephemeral sender key. The stored outer envelope exposes its destination mailbox, expiry, and an envelope identifier derived from the match operation and destination; it does not expose the partner publication or logical match identifier.

Mailbox fetch and acknowledgement requests are signed by the publication's Ed25519 key. Fetching does not delete envelopes. A client first decrypts and verifies each relay-signed notice, persists it in its encrypted local database, and then acknowledges the corresponding envelope identifiers. Each recipient acknowledges independently, so one participant cannot delete the other's copy.

V2 matches do not enter the legacy plaintext DID notification queue. Match comparisons are scoped by group, fingerprint algorithm, bit length, and epoch.

## Pairwise Consent and Channel Establishment

Accepting a match creates a fresh Ed25519 relationship identity and X25519 channel key pair. These keys are random and are neither derived from nor signed by the root identity. The initiator persists them locally, signs a consent offer with the publication key, encrypts the offer to the partner's publication mailbox, and submits the opaque envelope over a short connection.

The recipient checks the message against its stored match notice, including the exact partner publication key. It then creates and persists its own relationship and channel keys, derives the X25519 shared secret, and returns a publication-signed acceptance through the initiator's encrypted mailbox. The initiator derives the same secret and both sides derive the same channel identifier from the match and two relationship identities.

The relay validates that the deposit is signed by an active publication and targets the active partner publication's mailbox. The encrypted payload hides relationship identities, channel public keys, and consent contents. Delivery is idempotent by envelope identifier. A recipient persists channel state and a delivery receipt before acknowledging the relay, so restarts cannot force it to rotate keys or lose an accepted channel.

## Pairwise Messaging

Each consent message also carries a fresh relationship mailbox ID and X25519 public key inside the publication-mailbox ciphertext. The relationship mailbox is separate from both publication mailboxes. Once consent completes, neither publication identifier nor publication mailbox appears in channel traffic.

Every disclosure and close operation contains the channel ID, sender and recipient relationship IDs, a sender-local monotonic sequence, creation and expiry times, and an Ed25519 relationship signature. Disclosure contents are encrypted with the X25519 shared channel secret. The complete signed operation is then encrypted again to the recipient's relationship mailbox with a fresh ephemeral X25519 key. The outer relay envelope reveals only the relationship mailbox, expiry, size, and deterministic envelope ID; it hides the channel ID, sequence, operation kind, and disclosure contents.

The sender commits the exact operation and advances its sequence before attempting delivery. A failed request can therefore retry the same operation without creating a second message. The recipient verifies the relationship binding and sequence, decrypts and commits the message or close state, records the envelope receipt, and only then acknowledges deletion at the relay. Sequences are independent in each direction. Duplicate envelopes are idempotent, while a sequence gap remains unacknowledged until the missing operation arrives.

Relays authenticate relationship mailbox fetch and acknowledgement requests with the relationship Ed25519 key. They authenticate deposits with the sender relationship key and durably store only the opaque outer envelope. A relay can correlate traffic within one relationship and can observe transport metadata, but protocol fields do not connect that relationship to the publications that established it or to the user's root identity.

## One-Use Search

Every live search generates a new Ed25519 key pair. The public key becomes a one-use search identifier and signs the complete query: group, fingerprint algorithm and epoch, query type, result limit, similarity threshold, and a validity window of at most 60 seconds. The request uses a short connection and contains no root identity or publication identity belonging to the searcher.

Open relays rate-limit the transport source; relays with an admission verifier additionally require a one-use capability. They reject an already-seen search identifier during its validity window and return a relay-signed response bound to that identifier. Queries are never added to the matching index. Results identify matching publications, not user accounts. Repeating the same query creates unrelated search identifiers, although a relay or network observer can still correlate requests by source address, timing, and identical fingerprints until private transport is implemented.

## Anonymous Admission Boundary

Every protocol v2 relay frame may carry an optional admission presentation with a scheme identifier, issuer verification-key identifier, opaque token, and request proof. It contains no account, root DID, publication owner, or other user identifier. The application operation remains unchanged so the same signed publication or mailbox request can be replicated independently of the admission system.

The client and relay compute the same canonical digest over the exact request and one of five resource actions: publication write, search, mailbox fetch, mailbox acknowledgement, or mailbox deposit. A token wallet receives this digest when producing the request proof. The relay passes the presentation, digest, action, and current time to a configured verifier.

The verifier owns the cryptographic scheme and spent-token database. Its `verifyAndSpend` operation must atomically verify the presentation and record its use. It returns:

- `accepted` for the token's first valid request
- `replay` only when the same token is retried with the same action and exact request digest
- `rejected` when the token is invalid, expired, or reused for different content

Allowing an exact replay is necessary for crash safety. A relay may spend a token and then fail before committing the corresponding publication or mailbox operation. The client must be able to retry those exact bytes without gaining authority for a second operation.

Relays without a configured verifier remain open, preserving the current volunteer development flow. Once a verifier is configured, every protocol v2 operation requires a capability before relay state is read or changed. The interface deliberately does not select an issuer or token cryptosystem. Blind issuance, community or quorum verification, spent-token replication, and partition handling remain part of the private admission milestone; introducing any of those now would prematurely create a permanently available authority.

Admission credentials remove the need for a stable user identifier in abuse controls, but they do not conceal the transport source. IP safety limits and the metadata caveats in the threat model still apply until private transport is implemented.

## Security Invariants

- The root identity never appears in a discovery operation.
- Publication and mailbox identifiers are deterministically bound to their scoped public keys, preventing one key from being presented under several identifiers.
- Every field that affects storage, matching, routing, or expiry is signed.
- Unknown fields are rejected until a protocol version defines their meaning.
- Signatures remain valid across JSON object key reordering.
- Expiry is checked separately from signature validity, allowing replicas to audit historical operations.
- Mailbox private keys never leave user-controlled devices.
- Relay identity keys and personal identity keys are generated and stored independently.
- Admission tokens are bound to one exact relay request and never carry a root or scoped activity identity.

## Known Information Leakage

Relays still see the publication fingerprint, group, type, timestamps, TTL, record size, and replication identifier. Similar fingerprints within one group and epoch can be correlated because similarity comparison is the purpose of the service. Replication also reveals that exact copies represent the same publication.

Direct connections reveal the user's network address and allow timing correlation. Protocol v2 therefore establishes application-layer unlinkability; two-hop transport, padding, batching, route rotation, and anonymous admission credentials are separate roadmap milestones.

## Clean Cutover

There is no deployed relay network that requires wire compatibility with protocol v1. Relays therefore reject the v1 root-DID `publish` and `withdraw` messages. New publications use v2 operations exclusively.

An existing local v0.1 item may be upgraded by creating fresh publication and mailbox keys and publishing a new v2 record. The replacement is never signed by the legacy root DID, because that would permanently link the two identity models. Relays reject legacy root-DID authentication, publish, withdraw, search, consent, and channel messages. The desktop and CLI expose the v2 flows exclusively.

The `resonance upgrade-v2` command performs this upgrade item by item. It backs up the identity and database before opening the old schema, preserves private item content locally, skips withdrawn items, and reuses a pending signed record on retry. See [Upgrading Local Data from v0.1 to v0.2](v0.1-to-v0.2-upgrade.md) for the operating procedure, recovery rules, and security invariants.

## First Implementation Slice

The implemented foundation provides:

- Independent publication signing and mailbox key generation
- Canonical record creation and signature verification
- Owner-authorized tombstone creation and verification
- Strict parsing of serialized publication operations
- Explicit expiry-policy checks
- Encrypted local persistence of publication signing and mailbox secrets
- A self-authenticating operation frame with no sender DID
- A short node-to-relay submission path that verifies signed relay acknowledgements
- Relay-side sequence, conflict, idempotency, and terminal-tombstone rules
- Fsynced append-only relay operations before successful acknowledgement
- v2 publication and withdrawal in the CLI and desktop server
- Deterministic match identifiers and independently encrypted recipient notices
- Relay-signed match operations bound to exact publication revisions
- Atomic match and two-recipient mailbox commits with restart replay
- Exact per-publication expiry in matching, search, cleanup, and restart recovery
- Indefinite terminal-tombstone retention pending a provable replica convergence point
- Publication-authenticated mailbox fetch and per-envelope acknowledgement
- Encrypted local match persistence before relay acknowledgement
- CLI mailbox synchronization and desktop match-list synchronization
- Fresh relationship identities and X25519 keys for each accepted match
- Publication-signed, end-to-end encrypted consent offers and acceptances
- Durable pairwise channel state and replay-safe mailbox processing
- Desktop and CLI channel initiation without opening a root-authenticated relay socket
- A one-use signed identity and short connection for every live search
- Replay rejection and relay-signed responses bound to the search identity
- Desktop and CLI search with no root-DID authentication
- A separate relationship mailbox for every accepted match
- Signed per-sender channel sequences and encrypted disclosure and close operations
- Durable outgoing retries and incoming message persistence before relay acknowledgement
- Desktop and CLI disclosure, inbox synchronization, history, and channel close over v2
- Rejection of root-DID authentication and removal of legacy discovery flows from user interfaces
- Optional anonymous capability presentations on every v2 relay request
- Canonical action/request bindings and a pluggable atomic verify-and-spend contract
- A validated, atomic relay infrastructure identity store independent of personal keys
- A backed-up, rerunnable local-data upgrade from v0.1 items to fresh v2 publication identities

The v0.2 protocol foundation and clean local-data upgrade are complete.

## Integration Validation

The integration suite exercises the v0.2 boundaries through real WebSocket relay connections and encrypted local stores:

- One personal node publishes two unrelated records, searches for each independently, renews one, and withdraws the other.
- The relay journal is checked to ensure that the node's root DID, local item IDs, and private text never enter durable relay state.
- A live search leads into encrypted match delivery, pairwise consent, a durable disclosure retry after local restart, and channel close.
- Publication, mailbox, search, relationship, and channel identifiers are checked as distinct scopes during the end-to-end flow.
- A relay restart restores publications and the signed match, keeps an unacknowledged recipient envelope available exactly once, and keeps an acknowledged envelope absent.
- A retained tombstone survives relay restart and prevents a later higher-sequence publication from resurrecting the record.

These tests validate application-layer unlinkability and single-relay crash recovery. Volunteer replication, forwarded queries, multi-relay convergence, and network-path unlinkability remain the explicit completion tests for v0.3 and v0.4.

## Standards Direction

- Pairwise and scoped identifier guidance: <https://www.w3.org/TR/did-core/#privacy-considerations>
- Anonymous admission architecture: <https://www.rfc-editor.org/rfc/rfc9576.html>
- Two-hop request privacy: <https://www.rfc-editor.org/rfc/rfc9458.html>
