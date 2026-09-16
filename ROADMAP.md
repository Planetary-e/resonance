# Resonance Roadmap

> Private, decentralized matching on infrastructure contributed by its users.

## Product and Protocol Principles

The roadmap is governed by these constraints:

- **Volunteer infrastructure only.** Resonance must remain useful while every individual relay is temporary and may disappear without warning.
- **Aggregate availability.** Records survive through replication, repair, and forwarding rather than dependence on an always-on machine.
- **Scoped identities.** A relay may recognize one publication and its replicas, but must not be able to connect a user's unrelated publications, searches, mailboxes, or conversations through a permanent protocol identifier.
- **Local private data.** Raw text, true embeddings, root identity keys, and conversation contents stay on user-controlled devices.
- **Explicit leakage boundaries.** The protocol documents what a relay, network observer, and matched counterparty can learn.
- **Protocol before interfaces.** Desktop, mobile, CLI, and web clients share the same tested protocol and failure model.
- **Separate user and relay roles.** A device may perform both roles, but its relay identity, data, lifecycle, and network activity remain separate from the user's private identity and personal store.
- **Resource consent.** Volunteer relay participation stays within limits chosen by the device owner for storage, bandwidth, CPU, power, and operating schedule.

### Target Desktop Node Architecture

The desktop package contains two cooperating services:

- **Personal node:** private store, root and publication keys, embedding engine, matches, and conversations
- **Optional background relay:** peer manager, signed record store, replication controller, matching index, query router, encrypted mailbox store, and resource governor

The graphical interface controls and observes these services. When persistent participation is enabled, the relay is supervised independently of the interface and can continue running while the interface is closed. It makes outbound mesh connections so a device behind NAT can still store, repair, and forward data. Publicly reachable peers may additionally advertise an inbound role.

---

## Completed

### v0.1 — Pilot (March 2026)

The pilot proves the original flow end-to-end. Two nodes can find each other through one relay, open an encrypted channel, confirm a match with true embeddings, and exchange information without the relay receiving raw text.

- Core library: DID, Ed25519 and X25519 cryptography; Nomic 768-dimensional embeddings; Laplace perturbation; 17 wire message types
- Personal node: encrypted SQLite store, CLI, relay client, and channel manager
- Relay server: authenticated WebSocket connections, HNSW matching, rate limiting, persistence, and offline notification queues
- Channels: consent handshake, X25519 key exchange, end-to-end encrypted messaging, match confirmation, and progressive disclosure
- Evaluation suite: 35 metrics passing
- User and developer documentation

The pilot uses one persistent DID per user and one relay-local index. The next milestones replace those assumptions.

---

## In Progress — First-Month Foundation

### v0.2 — Protocol v2 and Unlinkable Activity

**Goal:** Remove permanent user identifiers from relay-visible activity and define records that can safely be replicated.

- [x] Write the protocol v2 threat model and privacy guarantees for relays, network observers, and matched peers
- [x] Keep the root identity encrypted locally and use it only for recovery and device authorization
- [x] Generate an independent Ed25519 key and opaque identifier for every publication
- [x] Use independent ephemeral identities for each search request
- [x] Use fresh pairwise relationship identities and X25519 keys for accepted matches
- [x] Give every publication a separate encrypted mailbox and X25519 key for asynchronous notifications
- [x] Define canonical, signed publication envelopes with version, group, fingerprint epoch, TTL, and owner-authorized updates
- [x] Define signed tombstones for withdrawal and expiry
- [x] Persist publication signing and mailbox secrets encrypted in the personal store
- [x] Accept self-authenticating publication operations over short connections without root-DID authentication
- [x] Accept signed one-use search requests over short connections and reject replayed search identities
- [x] Reject legacy root-DID publication, withdrawal, and search messages; there is no deployed network requiring dual-protocol migration
- [x] Reject legacy root-DID authentication, consent, and channel messages and remove those flows from the desktop and CLI
- [x] Apply idempotent sequence, conflict, stale-update, and terminal-tombstone rules at relays
- [x] Persist accepted publication operations before acknowledging them
- [x] Remove the root DID from relay indexes, notification queues, rate-limit keys, and logs
- [x] Add a protocol interface for anonymous, one-use admission capabilities
- [x] Give relays an infrastructure identity that cannot be derived from or connected to the local user's root identity
- [x] Replace relay-local mutable match state with signed, idempotent operations that survive restarts and can be replicated
- [x] Replace periodic JSON snapshots with an atomic durable store and append-only operation log
- [x] Enforce each publication's declared TTL independently and retain tombstones long enough for replica convergence
- [x] Make mailbox delivery independently acknowledgeable by each recipient
- [x] Persist the state needed to consent to a delivered match after a relay restart
- [x] Deliver publication-signed consent offers and acceptances as opaque encrypted mailbox envelopes
- [x] Persist pairwise identities and derived channel keys locally before acknowledging consent delivery
- [x] Give every accepted relationship a separate encrypted mailbox unrelated to either publication mailbox
- [x] Send signed, sequenced, end-to-end encrypted disclosures and close operations through short relationship-mailbox requests
- [x] Persist outgoing operations before delivery and incoming plaintext before acknowledgement so retries and restarts are safe
- [x] Document and implement the clean local-data upgrade from v0.1 items to fresh v2 publication identities

**Completion test:** One device publishes two records, searches, opens a channel, exchanges a disclosure, and closes the channel without exposing a shared protocol identifier across those activities. Each record can be independently renewed and withdrawn. A relay can crash after accepting a record or match, restart, and recover the accepted state without duplicate or missing mailbox delivery.

### v0.3 — Volunteer Replication and Query Routing

**Goal:** Keep records discoverable despite relay churn, without an operator-run VPS or other required permanent server.

- [ ] Discover relays through configured contacts, invitations, local discovery, and signed peer exchange
  - [x] Define signed relay descriptors, untrusted contact hints, and bounded signed peer-exchange frames
  - [x] Serve signed descriptors and peer exchange from relays with replay protection, rate limits, and a bounded verified cache
  - [x] Resolve configured and invitation hints with one-use requester keys, optional relay-ID pins, and endpoint binding
- [ ] Treat bootstrap contacts as discovery hints rather than trusted authorities
- [ ] Run desktop relay mode as an independently supervised background service when the user enables persistent participation
- [ ] Maintain several outbound peer connections so relays behind NAT and firewalls can participate without accepting unsolicited inbound connections
- [ ] Detect and advertise relay capabilities such as inbound reachability, storage capacity, supported groups, and forwarding availability
- [ ] Publish to a remote placement set even when the personal node also operates a local relay
- [ ] Replicate every active publication to a target of five relays with a minimum healthy set of three
- [ ] Return signed durability receipts for accepted replicas and track whether the minimum healthy set has been reached
- [ ] Exchange compact inventories and continuously repair missing replicas
- [ ] Select replicas across independently observed peers where possible
- [ ] Attempt graceful handoff before a relay shuts down
- [ ] Recover automatically from abrupt shutdowns, restarts, partitions, and stale peers
- [ ] Replicate encrypted mailbox envelopes and tombstones with the publication
- [ ] Forward searches when the local relay lacks sufficient index coverage
- [ ] Bound forwarding by request ID, hop limit, timeout, and deduplication
- [x] Generate deterministic match IDs so different relays converge on one result
- [ ] Merge duplicate replies and prevent duplicate notifications
- [ ] Apply owner-configured storage, bandwidth, CPU, power, and schedule limits without violating already-issued durability promises
- [ ] Expose local contribution and replica-health metrics without exposing peer activity
- [ ] Add a five-relay churn and partition test harness

**Completion test:** Publish through one relay, collect at least three signed durability receipts, stop the publisher and two relays, search through a relay that did not originally receive the record, and retrieve one encrypted match notification. A desktop behind NAT contributes through outbound connections, and its enabled background relay continues while the graphical interface is closed. After reconnection, records and tombstones converge without duplicate notifications.

---

## Planned

### v0.4 — Private Transport and Anonymous Admission

**Goal:** Prevent protocol identifiers from being reconnected through network metadata or abuse controls.

- [ ] Send publish, search, and mailbox requests through two independently selected volunteer hops
- [ ] Encrypt requests so the entry relay sees the source address but not the operation, while the destination sees the operation but not the source address
- [ ] Use authenticated encrypted transport for every Internet-facing peer connection
- [ ] Add challenge-response connection authentication with nonces and replay protection
- [ ] Verify relay and peer signatures on acknowledgements, matches, inventories, receipts, and forwarded operations
- [ ] Apply strict schemas, bounded collections, message-size limits, and request timeouts before processing untrusted input
- [ ] Protect relay private keys with operating-system storage or an encrypted keystore
- [ ] Use short sessions, route rotation, fixed-size padding, batching, and timing jitter
- [ ] Replace per-DID limits with standardized blind, one-use capability tokens
- [ ] Support community or quorum issuance without requiring a permanent issuer service
- [ ] Replicate spent-token identifiers and define deterministic handling of double spends during partitions
- [ ] Measure protection against a curious relay, colluding relays, Sybil relays, and a network observer
- [ ] Define group-specific, rotating fingerprint epochs to limit correlation across communities and time
- [ ] Measure the matching-quality and privacy effects of fingerprint rotation

**Completion test:** The entry hop cannot read an operation, the destination cannot see its originating address, and two valid operations cannot be linked by an account identifier or rate-limit credential.

### v0.5 — Mobile Client and Intermittent Relay Participation

**Goal:** Put Resonance on frequently available personal devices while keeping correctness independent of any one phone's background lifetime.

- [ ] Build the mobile client for iOS and Android
- [ ] Run embedding inference on-device
- [ ] Store root, publication, mailbox, and channel keys in Keychain or Keystore
- [ ] Synchronize replicated mailboxes whenever the application wakes or receives background execution time
- [ ] Support opt-in relay participation when operating-system and power conditions permit
- [ ] Share the desktop relay's resource-governor policy model across supported mobile platforms
- [ ] Measure background duty cycle, energy consumption, data use, thermal impact, and delivery latency on real devices
- [ ] Support encrypted multi-device recovery and delegation without publishing links between devices
- [ ] Make notifications an acceleration mechanism rather than a dependency for delivery

**Completion test:** A phone can publish, leave the network, and later recover matches from volunteer replicas. Relay participation respects device power and background restrictions.

### v0.6 — Direct Peer-to-Peer Transport

**Goal:** Move conversations off relay storage after mutual consent whenever network conditions allow.

- [ ] Exchange ICE candidates through the encrypted match channel
- [ ] Add STUN-assisted NAT traversal for direct TCP or UDP connections
- [ ] Use volunteer relay bridging when direct traversal fails
- [ ] Select transport automatically using connection quality and privacy policy
- [ ] Preserve pairwise identities and end-to-end encryption across transport changes

### v0.7 — Accessible Interfaces and Community Pilot

**Goal:** Make the volunteer network usable by non-technical communities.

- [ ] Provide a local web interface shared by desktop packaging
- [ ] Create and manage needs, offers, matches, mailboxes, and channels
- [ ] Explain progressive disclosure and privacy boundaries in the interface
- [ ] Show replica health and volunteer relay contribution without exposing peer activity
- [ ] Run a consent-based community pilot and use measured reliability and privacy results as release gates

### v0.8 — Scale and Index Distribution

**Goal:** Scale matching while retaining replication guarantees and measurable search coverage.

- [ ] Benchmark 100K, 500K, and 1M active publications under realistic churn
- [ ] Evaluate LSH-based routing and topic-specific relay groups
- [ ] Define coverage proofs or estimates that tell a client when forwarding is required
- [ ] Partition indexes without making rare interests easier to identify
- [ ] Balance storage, computation, bandwidth, diversity, and availability in replica placement

### v0.9 — Private Trust and Governance

**Goal:** Improve interaction quality without creating a global user-tracking identifier.

- [ ] Collect post-match feedback through pairwise encrypted channels
- [ ] Evaluate unlinkable credentials for statements such as membership or completed exchanges
- [ ] Keep reputation scoped to a community or relationship unless broader disclosure is explicitly chosen
- [ ] Design appeal, revocation, abuse response, and key-compromise recovery
- [ ] Define community governance for protocol versions, admission policy, and relay behavior

### v1.0 — Sustainable Volunteer Network

**Goal:** Operate a production network whose incentives remain aligned with its participants.

- [ ] Measure the real storage, bandwidth, power, and maintenance costs of relay participation
- [ ] Support community-funded relay pools and transparent resource policies
- [ ] Evaluate privacy-preserving credits for contributed resources
- [ ] Prevent payment or reward identifiers from becoming activity-tracking identifiers
- [ ] Publish interoperability, security, privacy, and operational specifications

---

## Future Exploration

- **Private similarity computation** — MPC, private set intersection variants, trusted execution environments, or other techniques that reduce fingerprint visibility
- **Multi-model interoperability** — Projection layers between compatible embedding models
- **Group matching** — Match several parties with complementary needs and capabilities
- **Local mesh** — Bluetooth and local Wi-Fi discovery and synchronization
- **Delay-tolerant transport** — Opportunistic store-and-forward across intermittently connected communities
- **Resilient discovery** — DHT and peer-sampling designs resistant to eclipse and Sybil attacks

---

## How to Contribute

See [CONTRIBUTING](docs/developers/contributing.html) for development setup. Issues tagged with `good first issue` are a good starting point.

Track progress on the [GitHub Project Board](https://github.com/orgs/Planetary-e/projects).
