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

- [x] Discover relays through configured contacts, invitations, local discovery, and signed peer exchange
  - [x] Define signed relay descriptors, untrusted contact hints, and bounded signed peer-exchange frames
  - [x] Serve signed descriptors and peer exchange from relays with replay protection, rate limits, and a bounded verified cache
  - [x] Resolve configured and invitation hints with one-use requester keys, optional relay-ID pins, and endpoint binding
  - [x] Offer opt-in LAN beacons that supply only a sender IP and port; query the resulting endpoint for an independently signed descriptor before caching it
- [x] Treat bootstrap contacts as discovery hints rather than trusted authorities
  - [x] Keep `RELAY_BOOTSTRAP_CONTACTS` out of the authenticated placement-link set; query them only for independently verified descriptors
- [x] Run desktop relay mode as an independently supervised background service when the user enables persistent participation
  - [x] Install a user-level launchd, systemd, or Task Scheduler job with restart-on-failure behavior; bundle a standalone relay entry point that survives GUI shutdown
- [x] Maintain several outbound peer connections so relays behind NAT and firewalls can participate without accepting unsolicited inbound connections
  - [x] Establish mutually authenticated links to configured relays with heartbeats, descriptor renewal, bounded fanout, and reconnect backoff
  - [x] Let desktop volunteers configure multiple contact endpoints and run the service as outbound-only on loopback
- [ ] Detect and advertise relay capabilities such as inbound reachability, storage capacity, supported groups, and forwarding availability
  - [x] Enforce retained-publication and per-relay allocations; persist explicit local, replica, or legacy provenance across forwarded updates and relay identity recovery, reserve bounded first-seen tombstone space, migrate unmarked journals into one conservative legacy bucket, and return signed `capacity-exhausted` refusals
  - [x] Atomically compact superseded publication journal revisions on restart and during maintenance, retaining tombstone predecessors and original allocation provenance while preserving histories needed by signed matches or reconciliation
  - [x] Bound the relay journal and retained encrypted mailboxes with configurable byte budgets; reserve journal room for live-publication withdrawals and pending mailbox acknowledgements, reject over-capacity writes before acknowledgement, suppress acknowledged-envelope retries until expiry, and compact expired mailbox history
  - [x] Compact expired match deliveries into signed deduplication checkpoints, discard obsolete match generations, retain only current placement intents and selected receipts, and fold resolved reconciliation adoption into owner-signed publication state while preserving exact match-referenced publication revisions
- [x] Publish to a remote placement set even when the personal node also operates a local relay
  - [x] Carry relay-signed publication and tombstone placement requests over authenticated links, fsync accepted operations before replying, and retain signed durability receipts per relay
  - [x] Persist placement intent before a local publication commit, retain prior targets for updates and tombstones, and replay intent plus receipts after a restart
  - [x] Select from live, direct, configured or explicitly invited authenticated links only; peer-exchange observations never trigger an automatic connection
  - [x] Support replica placement, receipt checks, mailbox repair, and reconciliation over an inbound link initiated by an outbound-only volunteer, so a device behind NAT can be selected as a target
  - [x] Require the controller to explicitly approve each inbound replica target's infrastructure ID; an unknown signed peer may connect for discovery or queries but does not receive stored publications
- [ ] Replicate every active publication to a target of five relays with a minimum receipt-confirmed set of three
  - [x] Grow a configured authenticated placement set toward five live eligible relays and retry unfinished placements on reconnect and on a bounded repair interval
  - [x] Preserve the placement set and receipt-confirmed copies across restart; a five-relay integration test starts with three relays and repairs to five
  - [x] Persist a capacity-only target exclusion and choose another live configured target after signed `capacity-exhausted`; durably quarantine `stale`, `conflict`, `terminal`, `unsupported-group`, and `invalid` exact operations until a newer local revision or reconciliation can resolve them
- [ ] Return signed durability receipts for accepted replicas and track whether the minimum receipt-confirmed set has been reached
  - [x] Count only positive receipts bound to the current owner-signed operation, local sending relay, and selected target; expose per-publication placement status and aggregate metrics
  - [x] Bound receiver replay state and resend the same signed receipt for an exact retry instead of treating a lost receipt as a protocol violation
- [x] Exchange compact inventories and continuously repair missing replicas
  - [x] Exchange receipt-authorized signed point checks for an exact operation and repair a target that reports it missing
  - [x] Resolve a signed `stale`, `conflict`, or `terminal` refusal through a target-authorized, read-only current-state response without turning the learned operation into new fan-out
  - [x] Batch up to 64 target-signed receipts into one canonical request and return one signed presence bitmap, without exposing a relay's full publication set or permitting arbitrary-ID probes
- [x] Prefer replicas across distinct observed network failure domains where possible, using authenticated contact endpoints as a limited signal without claiming independent ownership
- [x] Attempt graceful handoff before a relay shuts down: notify each reachable original controller with a signed, bounded exact-operation batch; durably exclude the retiring target, select a connected spare, queue repair, and return a signed acknowledgement before the shutdown grace period ends
- [x] Recover automatically from abrupt shutdowns, restarts, partitions, and stale peers
  - [x] Preserve selected targets through short outages and repair same-identity relays after reconnect or controller restart
  - [x] After a bounded outage grace period, durably replace an offline target only when a connected eligible spare preserves the placement size; do not permanently reject the offline volunteer
- [x] Replicate publication-mailbox encrypted envelopes and acknowledgement tombstones across the publication's receipt-confirmed placement set; exchange bounded signed pages on authenticated links and repair missing mailbox state after reconnect or replica storage loss
- [x] Give pairwise relationship mailboxes, which are not attached to a publication, an explicit volunteer placement and recovery policy: send signed client deposit and acknowledgement operations over authenticated relay links to up to five connected, diversity-preferred volunteers; repair after reconnect or replica storage loss, and merge configured client fallback reads
- [x] Forward searches when the local relay lacks sufficient index coverage through authenticated outbound or inbound relay links
- [x] Bound forwarding by signed request ID, a two-link hop limit, a three-second deadline, five peers per hop, replay suppression, and result deduplication
- [x] Generate deterministic match IDs so different relays converge on one result
- [x] Merge duplicate replies and prevent duplicate match notifications
  - [x] Merge signed relay replies by publication ID and retain at most the requester's top-k results
  - [x] Derive each recipient's match-notice envelope ID from the stable publication-pair match ID; converge acknowledgement tombstones across relays with differing notice expiries, and persist one visible match per recipient publication on the personal node
  - [x] Exercise two independent relays matching the same pair through client fetch, decryption, local insertion, and acknowledgement; show one visible match
- [x] Apply owner-configured storage, bandwidth, CPU, power, and schedule limits without violating already-issued durability promises
  - [x] Let desktop owners set publication storage, new-work ingress and CPU budgets, local active hours, and a charging-only condition; refuse new publications, searches, and first-time replicas when limits bind while continuing acknowledgements, withdrawals, and retained repairs
  - [x] Report aggregate HTTP/WebSocket ingress and egress, process CPU, data-file, retained-mailbox, and journal bytes; expose publication, mailbox, and journal commitment floors and refuse a storage quota below accepted state on restart
  - [x] Pause discretionary work when measured total traffic or process CPU reaches the owner's budget while continuing already-accepted obligations; include LAN-discovery UDP payloads and carry resource counters and budget windows across process restarts. These budgets are admission thresholds, not hard caps on obligations.
- [x] Expose local contribution and aggregate replica-health metrics without exposing peer activity
  - [x] Show connected-relay count, active-publication count, publication storage use, and placements at the receipt minimum in the authenticated desktop view; never return peer IDs or exact publication records there
- [x] Add a five-relay churn and partition test harness
  - [x] Use five outbound-only volunteers connected to a direct controller; isolate one live link, abruptly lose another, restore its empty journal, and verify mailbox availability, publication repair, and eventual acknowledgement convergence across all five replicas
  - [x] Restart the controller and verify a volunteer can still search its retained copy during the outage, then re-establish all five authenticated links and receipt-confirmed placements
  - [x] Log partition detection, the three-receipt outage minimum, empty-journal repair, full repair, controller restart, and search latencies; run the controlled harness with `npm run test:churn`

**Current replication boundary:** outbound-only volunteers can receive replica placements across their authenticated reverse link only when the controller explicitly approves their infrastructure IDs. Signed descriptors and current receipts establish protocol state, not independent ownership or continuous availability. A receipt proves that a named relay fsynced one exact operation at one point in time. Receipt-authorized checks batch up to 64 exact operations for one target into a canonical signed request; the target returns one signed presence bitmap, and a missing bit schedules repair when that relay returns with the same infrastructure identity. The request still carries every target-signed receipt, so it amortizes signatures and response bytes rather than offering constant-size set reconciliation. New placements prefer authenticated relay connections in different observed network failure domains: IPv4 `/24`, IPv6 `/48`, or exact DNS hostname. This reduces obvious shared-network fate but does not prove different machines, operators, autonomous systems, or physical locations. A signed `stale`, `conflict`, or `terminal` refusal is also a capability for one read-only request to that same target and exact operation; an unambiguous valid successor is adopted locally without becoming a new outbound placement intent. Other mismatches remain quarantined. Volunteer relays now enforce retained-publication, encrypted-mailbox, and journal byte budgets, reserving journal room for existing live withdrawals and pending mailbox acknowledgements. The journal budget includes its temporary compaction copy, but does not cap other files or guarantee free filesystem space. Safe compaction now discards obsolete publication revisions except those referenced by retained matches, expires old match generations, checkpoints current match decisions after encrypted notices expire, retains only current placement intents and selected receipts, folds resolved reconciliation adoption into owner-signed publication state, and removes expired mailbox history. Active matches, placements, unexpired deliveries, and tombstones remain charged to the finite journal and can halt new writes. New journal rows carry explicit `local`, `replica`, or `legacy` provenance, preserving local accounting through relay identity recovery; old unmarked rows share one conservative legacy per-relay bucket rather than being guessed. A reachable relay attempts graceful handoff before shutdown by sending each original controller a signed list of the exact operations it hosts. The controller accepts only entries backed by its matching target receipt, durably excludes the retiring relay, selects a connected spare, queues repair, and signs an acknowledgement that also states whether the minimum receipt count was already met elsewhere. Shutdown waits up to two seconds per reachable controller; it does not delay until a replacement receipt arrives. After an abrupt loss or partition, the controller preserves the selected target through a configurable grace period so a brief outage can heal. If the target stays offline and a connected eligible spare can preserve the placement size, the controller journals a new intent without marking the old relay as permanently rejected and then repairs the spare. A controller restart conservatively starts a fresh grace period because outage observations are not durable. Neither a receipt, a capacity hint, nor a distinct observed network domain proves independent ownership or continuous availability. Searches now consult up to five authenticated, group-compatible relays per hop, for at most two relay-link hops and three seconds. Each forwarded frame is signed, target-bound, and tied to the one-use search request; duplicate search IDs are suppressed, and replies are merged by publication ID. A relay that has no route or times out returns its available local results. These signed peer assertions are not independent proofs of similarity or complete network coverage. Broader resource limits and measured repair behavior under churn remain required before Resonance can claim replica health. Tombstones must remain with the predecessor publication state and allocation provenance needed for replay and accounting.

**Mailbox boundary:** A publication controller periodically exchanges up to eight encrypted envelopes or acknowledgement tombstones per direction with each receipt-confirmed replica. Each receiving relay fsyncs new state before its signed reply; reconnect and publication repair resume exchange from bounded pages. Any acknowledgement removes the same envelope ID when it reaches another replica, including when the acknowledgement arrives before that envelope. Relationship mailboxes use a separate bounded exchange of the original relationship-signed deposits and acknowledgements. The relay chooses up to the configured replica target count among its connected, authenticated mailbox-capable volunteers, preferring distinct observed network domains. Those volunteers fsync accepted operations before signing a sync response, and repair resumes after reconnect or storage loss. A personal node merges and acknowledges across its explicitly configured relay and fallback URLs; it cannot discover a lost original relay's volunteer targets from a single dead URL. Relationship sync has no durable placement intent, receipt minimum, or independent availability proof. Both mailbox exchanges are eventual convergence, not a guarantee that an envelope reached three relays before the original relay shut down.

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
