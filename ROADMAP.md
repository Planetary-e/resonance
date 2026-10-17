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
  - [x] Sign zero available capacity on the next descriptor request after the coarse storage bucket is exhausted; keep nonzero bucket changes rate-limited and treat signed write refusals as authoritative for peers with stale descriptors
  - [x] Distinguish configured forwarding capability from current paths in authenticated owner status: count live inbound links, outbound links, and group-compatible connected query peers without exposing their identities
  - [x] Bind the dialed URL to the signed relay-link request and report a direct endpoint as peer-confirmed only after recent authenticated connections from two distinct public source-network ranges; never count loopback or private-network tests as Internet evidence
  - [ ] Validate the peer-confirmation path across independent real networks before presenting it as measured Internet reachability; signed peers can misreport what they dialed, and distinct IP ranges do not prove independent operators
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
- [x] Return signed durability receipts for accepted replicas and track whether the minimum receipt-confirmed set has been reached
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
  - [x] Exercise the v0.3 completion path: verify five signed receipts, stop the controller and two volunteers, search from an unseeded relay through a surviving volunteer, decrypt its replicated notice, then reconnect and confirm acknowledgement and tombstone convergence

The five-target placement goal remains conditional on enough eligible volunteers being connected. The relay reports a receipt shortfall when that condition is unmet; a local passing test cannot establish continuous availability across independent volunteer devices.

**Current replication boundary:** outbound-only volunteers can receive replica placements across their authenticated reverse link only when the controller explicitly approves their infrastructure IDs. Signed descriptors and current receipts establish protocol state, not independent ownership or continuous availability. A receipt proves that a named relay fsynced one exact operation at one point in time. Receipt-authorized checks batch up to 64 exact operations for one target into a canonical signed request; the target returns one signed presence bitmap, and a missing bit schedules repair when that relay returns with the same infrastructure identity. The request still carries every target-signed receipt, so it amortizes signatures and response bytes rather than offering constant-size set reconciliation. New placements prefer authenticated relay connections in different observed network failure domains: IPv4 `/24`, IPv6 `/48`, or exact DNS hostname. This reduces obvious shared-network fate but does not prove different machines, operators, autonomous systems, or physical locations. A signed `stale`, `conflict`, or `terminal` refusal is also a capability for one read-only request to that same target and exact operation; an unambiguous valid successor is adopted locally without becoming a new outbound placement intent. Other mismatches remain quarantined. Volunteer relays now enforce retained-publication, encrypted-mailbox, and journal byte budgets, reserving journal room for existing live withdrawals and pending mailbox acknowledgements. The journal budget includes its temporary compaction copy, but does not cap other files or guarantee free filesystem space. Safe compaction now discards obsolete publication revisions except those referenced by retained matches, expires old match generations, checkpoints current match decisions after encrypted notices expire, retains only current placement intents and selected receipts, folds resolved reconciliation adoption into owner-signed publication state, and removes expired mailbox history. Active matches, placements, unexpired deliveries, and tombstones remain charged to the finite journal and can halt new writes. New journal rows carry explicit `local`, `replica`, or `legacy` provenance, preserving local accounting through relay identity recovery; old unmarked rows share one conservative legacy per-relay bucket rather than being guessed. A reachable relay attempts graceful handoff before shutdown by sending each original controller a signed list of the exact operations it hosts. The controller accepts only entries backed by its matching target receipt, durably excludes the retiring relay, selects a connected spare, queues repair, and signs an acknowledgement that also states whether the minimum receipt count was already met elsewhere. Shutdown waits up to two seconds per reachable controller; it does not delay until a replacement receipt arrives. After an abrupt loss or partition, the controller preserves the selected target through a configurable grace period so a brief outage can heal. If the target stays offline and a connected eligible spare can preserve the placement size, the controller journals a new intent without marking the old relay as permanently rejected and then repairs the spare. A controller restart conservatively starts a fresh grace period because outage observations are not durable. Neither a receipt, a capacity hint, nor a distinct observed network domain proves independent ownership or continuous availability. Searches now consult up to five authenticated, group-compatible relays per hop, for at most two relay-link hops and three seconds. Each forwarded frame is signed, target-bound, and tied to the one-use search request; duplicate search IDs are suppressed, and replies are merged by publication ID. A relay that has no route or times out returns its available local results. These signed peer assertions are not independent proofs of similarity or complete network coverage. Owner resource budgets pause new admissions but cannot cap accepted obligations; the controlled churn harness measures repair on local test relays, not Internet-wide availability. Tombstones must remain with the predecessor publication state and allocation provenance needed for replay and accounting.

**Mailbox boundary:** A publication controller periodically exchanges up to eight encrypted envelopes or acknowledgement tombstones per direction with each receipt-confirmed replica. Each receiving relay fsyncs new state before its signed reply; reconnect and publication repair resume exchange from bounded pages. Any acknowledgement removes the same envelope ID when it reaches another replica, including when the acknowledgement arrives before that envelope. Relationship mailboxes use a separate bounded exchange of the original relationship-signed deposits and acknowledgements. The relay chooses up to the configured replica target count among its connected, authenticated mailbox-capable volunteers, preferring distinct observed network domains. Those volunteers fsync accepted operations before signing a sync response, and repair resumes after reconnect or storage loss. A personal node merges and acknowledges across its explicitly configured relay and fallback URLs; it cannot discover a lost original relay's volunteer targets from a single dead URL. Relationship sync has no durable placement intent, receipt minimum, or independent availability proof. Both mailbox exchanges are eventual convergence, not a guarantee that an envelope reached three relays before the original relay shut down.

**Completion test:** Publish through one relay, collect at least three signed durability receipts, stop the publisher and two relays, search through a relay that did not originally receive the record, and retrieve one encrypted match notification. A desktop behind NAT contributes through outbound connections, and its enabled background relay continues while the graphical interface is closed. After reconnection, records and tombstones converge without duplicate notifications.

---

## Planned

### v0.4 — Private Transport and Anonymous Admission

**Goal:** Prevent protocol identifiers from being reconnected through network metadata or abuse controls.

- [ ] Send publish, search, and mailbox requests through two independently selected volunteer hops
  - [x] Select an ordered pair from fresh, signed, directly reachable relay descriptors and authenticated transport observations; fail closed when identities or observed network domains overlap
  - [x] Carry encrypted publish, search, and mailbox operations over two local relay sockets, with a signed entry-to-destination forward and an encrypted return reply
  - [x] Connect the personal client to explicit experimental entry and destination roles; fail closed if their signed descriptors or observed IP domains overlap, and never use a configured destination as a direct entry contact
  - [x] Preflight the exact entry-to-destination forwarding endpoint: the entry fetches the destination's signed key over a live socket and signs its observed IP for the client; the client never dials that destination during the operation
- [ ] Encrypt requests so the entry relay sees the source address but not the operation, while the destination sees the operation but not the source address
  - [x] Define bounded HPKE entry and destination layers with signed relay encryption keys, short expiry, authenticated metadata, and replay rejection
  - [x] Advertise a signed relay encryption key in discovery and carry both encrypted request and reply through live local relay sockets
  - [x] Observe entry and destination sockets in separate relay processes; verify the entry wire omits the operation ID and the destination's operation connection originates from the entry process
  - [x] Fsync private request replay evidence before forwarding or applying a request, restore unexpired entries before listening after a restart, and fail closed on complete-record corruption or exhausted capacity
  - [x] Stop direct client-to-destination key discovery; verify the destination's signed response and the entry's fresh signed socket observation before encrypting the operation
  - [x] Resolve DNS-named destinations independently and require the entry's reported IP to be in the answer set, with every answer outside the entry's observed network domain. This depends on the client's DNS resolver: it does not authenticate DNS, prove the exact destination socket IP when there are multiple answers, or prove distinct operators
- [ ] Use authenticated encrypted transport for every Internet-facing peer connection
  - [x] Reject public `ws://` endpoints at client, discovery, relay-link, and advertised-endpoint boundaries; retain cleartext only for loopback and private-LAN development
  - [ ] Provide and verify TLS termination for reachable volunteer relays, then audit every inbound and outbound connection path
    - [x] Support a direct HTTPS/WSS relay listener using operator-supplied PEM credentials and verify its TLS handshake in tests
    - [x] Check direct-listener certificate validity and advertised hostnames at startup; reject public-source connections to a cleartext listener
    - [x] Inventory production inbound/outbound socket paths and their remaining deployment checks in `docs/developers/v0.4-connection-audit.md`
    - [x] Verify 110 IPv4/IPv6 TLS boundary cases, complete private WSS delivery across certificate renewal/restart, and actual loopback TLS proxy rotation; correct Node IPv6 SAN validation without bypassing trust or date checks (`docs/developers/v0.4-connection-audit.md`)
- [ ] Add challenge-response connection authentication with nonces and replay protection
  - [x] Bind each signed relay-link opening to a fresh nonce issued on that receiving socket; reject a captured opening on a second socket
- [ ] Verify relay and peer signatures on acknowledgements, matches, inventories, receipts, and forwarded operations
  - [x] Replace permissive Ed25519 verification with native canonical verification, preserve valid key/message formats, pass 151 pinned adversarial vectors and protocol/recovery regressions, and remeasure cold protected-role startup (`docs/developers/v0.4-native-signature-verification.md`)
  - [x] Profile durable match creation and remove repeated signature checks within individual constructors/store calls while retaining authentication at every public boundary; retain tampering coverage and the unchanged <500 ms evaluation gate in `docs/evals/publication-match-2026-10-01.md`
- [ ] Apply strict schemas, bounded collections, message-size limits, and request timeouts before processing untrusted input
  - [x] Validate direct/private client ACK and mailbox payloads, reject binary replies, cancel connecting/open one-use sockets, bound direct concurrency and share a deadline across fallbacks; remove obsolete root-DID sessions and test actual malicious responses, cancellation and private routes (`docs/developers/v0.4-connection-audit.md`)
  - [x] Isolate desktop HTTP origins/hosts and static assets, bound event sockets, revoke them with session tokens and preserve lock across pending identity operations; verify actual local API and private-delivery regressions (`docs/developers/v0.4-desktop-http-security.md`)
  - [x] Bound all inbound relay TCP sockets and HTTP/TLS openings, reject binary application frames, and wait for in-flight admission on idempotent shutdown; verify slow connections, capacity reuse and durable replay (`docs/developers/v0.4-connection-audit.md`)
  - [x] Bound signed reply envelopes to 1 MiB, reject extra envelope fields, and cap personal-client WebSocket replies at the same limit
  - [x] Contain socket-accounting callback failures in discovery, relay-link and witness clients; prevent post-failure sends and verify real socket closure, cancellation and disabled compression (`docs/developers/v0.4-connection-audit.md`)
  - [x] Enforce monotonic discovery/link-opening deadlines, terminate failed short sockets without peer cooperation, snapshot bounded witness requests before dialing, and contain opening send failures; test elapsed-time stalls and uncooperative peers (`docs/developers/v0.4-connection-audit.md`)
- [ ] Protect relay private keys with operating-system storage or an encrypted keystore
  - [x] Add an scrypt/AES-GCM encrypted infrastructure keystore, atomic plaintext migration, and mandatory passphrase for a reachable WSS relay
  - [x] Serialize infrastructure-key creation/migration across processes, recover exact complete candidates, preserve ambiguous interrupted writes, and test SIGKILL/concurrent writers plus funded storage (`docs/developers/v0.4-relay-key-durability.md`)
  - [x] Validate encrypted personal identities and persist account creation/password replacement under cross-process ownership; preserve originals and exact pending writes through process death, refuse ambiguous recovery, and retain legacy compatibility (`docs/developers/v0.4-account-identity-durability.md`)
- [ ] Use short sessions, route rotation, fixed-size padding, batching, and timing jitter
  - [x] Use one request per private connection and vary the first entry attempted when multiple entry relays are configured
  - [x] Pad encrypted destination requests and replies into bounded 8–256 KiB buckets; test equal entry-frame lengths within a bucket and a 190 KiB operation under the 512 KiB frame cap
  - [x] Queue private client work before discovery and token reservation, release bounded shuffled batches with random delay, and cancel pending work and active sockets on disconnect
  - [x] Share a bounded 750 ms collection queue across private entry clients, shuffle forwarding batches, enforce count/byte/concurrency/wait limits, and cancel queued forwards on client disconnect or relay shutdown
  - [x] Collect encrypted replies in an independent bounded 750 ms queue, release shuffled batches to the original clients, retain byte/count accounting through socket writes, and cancel replies on disconnect, expiry, or shutdown without undoing accepted destination operations
- [ ] Replace per-DID limits with standardized blind, one-use capability tokens
  - [x] Implement Privacy Pass Blind RSA issuance, scoped redemption, and a restart-safe single-relay spent-token log; verify a real publication through the relay and reject a conflicting reuse
  - [x] Redeem a manually issued blind token over a real two-hop local client route without a client account identifier in the capability
  - [x] Add an experimental encrypted client wallet that verifies manually issued tokens, durably reserves a token for one exact request and destination before network I/O, and restores that reservation after restart; verify its two-hop redemption locally
  - [x] Integrate the encrypted wallet into the desktop private-transport pilot: pin an issuer key/scope and destination list, authenticate manual token imports, show available/reserved balances, and supply capabilities for immediate and held operations; retain reservations through lock/restart/crash and fail closed on exhaustion or missing private routing
  - [x] Add offline desktop blinded requests and signed-response import with an explicit volunteer approval command; cancel unfinished blinding state on lock/restart, replenish within bounded storage, and retain old reservations through issuer-key/period changes
  - [x] Enforce an offline invitation policy: one-use random permits, fixed cohort batches and a bounded issuer-wide allowance, encrypted durable reservations before signing, exact response recovery, and no permit/member identifier in redemption
  - [x] Authenticate shared issuer configuration with an independently pinned community authority; persist signed revisions across desktop/issuer/relay restarts and enforce issuance, new-spend, and recorded-retry deadlines without deleting history
  - [x] Specify challenge-bound four-of-five policy-head observations, test the finite intersection model and counterexamples, and implement strict signed vote/certificate primitives; keep live freshness disabled pending durable activation, recovery and transport (`docs/developers/v0.4-policy-freshness-decision.md`)
  - [x] Add an experimental encrypted policy observer with signed immediate successors, retained conflict evidence, exact retries and fail-closed reopen; test actual interruption, flush failures and four-observer certificates, leaving protected recovery and live activation open (`docs/developers/v0.4-policy-freshness-decision.md`)
  - [x] Add bounded experimental observer transport and four-member collection/activation; bind observations to transition chains after reproducing a contradictory-predecessor counterexample, test partitions/cancellation/expiry, and extend the TLS matrix to 120 cases (`docs/developers/v0.4-policy-freshness-decision.md`)
  - [x] Back experimental observer heads/conflict fences with four-copy retained history, require fresh current-head confirmations for every observation, reserve terminal conflict capacity and test five-device partitions, stale concurrent backups and process death; lost-state generation recovery/compaction and production integration remain open (`docs/developers/v0.4-policy-freshness-decision.md`)
  - [ ] Define automated Sybil-resistant eligibility and fair invitation distribution; resolve authority rotation, conflicting signed policies across devices, emergency-update distribution, and safe history compaction
- [ ] Support community or quorum issuance without requiring a permanent issuer service
  - [x] Implement explicit offline volunteer batch approval without a permanent issuer service; one authoritative permit ledger enforces local budgets, while distributed issuance and automated eligibility remain open
  - [x] Document offline volunteer issuance and the need for an audited threshold scheme before splitting one issuer key among volunteers
- [ ] Replicate spent-token identifiers and define deterministic handling of double spends during partitions
  - [x] Specify fail-closed four-of-five witness certificates for one-malicious-witness tolerance; local spent-ID copying is explicitly insufficient
  - [x] Implement signed, fsynced witness votes with issuer-key-pinned five-member sets, four-signature certificates, bounded real relay exchanges, and partition/concurrency/crash/restart tests
  - [x] Model independent and correlated volunteer schedules and measure the authorization phase with five local relay processes: 80 attempts covering unavailable witnesses, delayed/lost replies, recovery, and persisted-certificate retries; retain traces and limits in `docs/evals/witness-availability-2026-10-01.md`
  - [ ] Measure real volunteer overlap, Internet/TLS delay and total traffic, device energy, and near-capacity/concurrent costs; the local authorization benchmark and synthetic schedules do not establish these
  - [x] Specify and validate conservative cohort rotation: new issuer key for new witnesses, original membership/history for old tokens, no automatic conversion or refund; exhaustively check certificate intersections and retain the successive-replacement counterexample in `docs/developers/v0.4-witness-replacement-decision.md`
  - [x] Add offline rotation preparation, review and digest-approved signing: verify the signed predecessor and successor rules, retain old cohorts, report cutoffs and policy capacity, and explicitly leave remote readiness/history capacity unverified; operator guide in `docs/developers/v0.4-admission-rotation-tool.md`
  - [x] Add reviewed local retirement for expired, non-active issuer keys: atomically retain permanent denial markers while compacting their witness votes/coordinator certificates; preserve other keys, reject clock/configuration reactivation, and test legacy snapshots, flush failures and SIGKILL recovery in `docs/developers/v0.4-admission-history-retirement.md`
  - [x] Extend reviewed retirement to signed-policy relays’ local spend histories: encrypt key-attributed records, retain unattributed legacy spends, atomically persist denial markers with compaction, and verify real-token retries, failed flushes, offline maintenance and SIGKILL recovery
  - [x] Add reviewed permanent issuer-ledger retirement after the final key cutoff: atomically remove per-permit evidence, preserve lifetime allowance counters, cancel unused allowance, and refuse signing/recovery/reactivation; verify CLI, interrupted issuance, failed flushes and SIGKILL in `docs/developers/v0.4-issuer-retirement.md`
  - [x] Add reviewed desktop wallet retirement after the final retry cutoff: remove bearer tokens and raw reservation details atomically with a permanent key fence and encrypted retry-denial digests; prevent old retries from consuming fresh tokens, retain current balances, and verify UI, authenticated API, failed flushes and SIGKILL recovery in `docs/developers/v0.4-wallet-retirement.md`
  - [x] Advance beyond eight current configurations using signed policy v2: preserve up to 64 immutable archived configurations, deny all archived-key use, retain local evidence and retry denials, and verify ninth-key issuance/redemption, restart, cleanup and offline CLI review in `docs/developers/v0.4-policy-archives.md`
  - [x] Recover proven unattributed legacy spends through reviewed offline token verification after the final cutoff: atomically retain issuer-key fences, preserve all unproven rows, and test bounded batches, malformed proofs, stale approval, failed flushes, CLI and SIGKILL in `docs/developers/v0.4-legacy-spend-recovery.md`; keep missing/empty/corrupt state fail-closed
  - [x] Investigate the follow-up CI reconnection failure: fence late messages after rejected handshakes, reduce completion-test maintenance contention, require both ends to connect, and add opt-in real-crypto load coverage in `docs/developers/v0.4-relay-load-validation.md`
  - [x] Evaluate recovery freshness with an executable fixed-volunteer model: expose stale backups, unsafe three/three quorums, recovery regression without write-back, and stale-writer races; specify four/five encrypted incremental evidence and generation barriers in `docs/developers/v0.4-history-checkpoint-decision.md` without enabling operational restore
  - [x] Implement bounded owner-signed encrypted checkpoint/delta blocks, incremental payload persistence and a durable one-way generation barrier on a pinned volunteer; test corruption, capacity, failed writes/flushes/renames and SIGKILL without enabling live recovery (`docs/developers/v0.4-history-checkpoint-storage.md`)
  - [x] Add owner-authenticated checkpoint append/read exchange, member-signed durable receipts, and a bounded sequential writer that persists exact pending payloads and four-member certificates; test five real loopback services, partitions, lost replies, maximum payloads, stale evidence and SIGKILL (`docs/developers/v0.4-history-checkpoint-exchange.md`)
  - [x] Prepare frozen recovery evidence with authenticated barriers, four complete compatible histories, retained partial tails, persisted intent/results, and explicit fresh retries; verify lost replies, forks, incomplete copies, local regression, racing writes, higher barriers, real sockets and SIGKILL without authorizing a successor writer (`docs/developers/v0.4-history-checkpoint-recovery.md`)
  - [x] Persist one successor proposal, copy the selected frozen suffix to four volunteers and collect durable reservation certificates; verify restart, lost replies, SIGKILL, conflicting proposals and the known split-vote blocking case without activating another writer (`docs/developers/v0.4-history-checkpoint-successor.md`)
  - [x] Evaluate a replacement for split successor reservations: exhaustively check two-view prepare/confirm agreement, preserve hidden certificates, expose unsafe resets/late confirmations, and verify conditional honest-quorum progress in `docs/developers/v0.4-successor-view-change-decision.md`; keep existing one-shot reservations unchanged
  - [x] Implement signed v2 view reports and prepare/confirm certificates with atomic replica barriers, retained proofs, complete-local-history checks and an opt-in fence that refuses existing legacy reservations; test hidden decisions, tentative splits, failed fsync and nine SIGKILL boundaries (`docs/developers/v0.4-history-agreement.md`)
  - [x] Connect view-change agreement to bounded network exchange and a durable owner coordinator: persist each phase before sending, resume explicitly with fresh requests, catch up a different fourth volunteer, and test real sockets, partitions, hidden decisions, failed flushes, deadlines and SIGKILL (`docs/developers/v0.4-history-agreement.md`)
  - [x] Compose selected complete-history download/write-back with network agreement: verify frozen ancestry before transfer, stage missing ciphertext backwards, atomically install only compatible suffixes, resume after restart/lost replies, and test five real sockets plus replica/owner SIGKILL (`docs/developers/v0.4-history-agreement.md`)
  - [x] Bound repeated history-signature verification with a 1,024-entry success-only cache; retain per-operation authorization/expiry checks and test carried-decision repair with separate owner/relay processes, without extending the production deadline (`docs/developers/v0.4-history-agreement.md`)
  - [x] Add explicit certificate-controlled local activation and cross-generation ancestry: derive one continuation root per decided proposal, retain/validate parents on reopen, require four fresh root-write receipts before new deltas, and test two generations plus interrupted parent activation; preserve incompatible tails and legacy reservations (`docs/developers/v0.4-history-agreement.md`)
  - [x] Compose activation with bounded remote generation provisioning and resumable child-store creation: persist owner intent, publish only a complete staged child, preserve accepted records through retries/restart, and require separate fresh root-write receipts; verify five real sockets, failed flushes and nine SIGKILL boundaries (`docs/developers/v0.4-history-provisioning.md`)
  - [x] Add resumable owner download across certified generation roots and service routing across a complete locally enrolled chain: verify every selected hash and frozen anchor, retain durable progress through restart, and test three generations, one surviving source and five owner SIGKILL boundaries (`docs/developers/v0.4-history-ancestry.md`)
  - [x] Persist agreement selection before resumable download, consume verified retained ciphertext during fresh prepare/confirm, and refuse incomplete caches or an obsolete promised view; verify a returning fourth member over real sockets (`docs/developers/v0.4-history-ancestry.md`)
  - [x] Repair live missing suffixes from an explicitly retained complete current-generation prefix before collecting fresh target-write receipts; preserve pending writes across lost replies/reopen and refuse frozen, divergent or newer histories (`docs/developers/v0.4-history-checkpoint-exchange.md`)
  - [x] Retain the writer's complete current-generation ciphertext before transmission, validate its encrypted index on reopen and repair through authenticated indexed reads; verify four flush failures, nine SIGKILL boundaries, local corruption/capacity and volunteer turnover (`docs/developers/v0.4-history-writer-retention.md`)
  - [x] Require four durable history copies before configured protected admission can acknowledge new work; fence local-only reopening, replicate policy/spend/retirement/legacy-recovery mutations, and test the real relay response, failed flushes and process death (`docs/developers/v0.4-protected-admission.md`)
  - [x] Carry valid policy updates larger than a 64 KiB delta in bounded full checkpoints; authenticate the successor and refuse any changed spend, binding, attribution or permanent denial before applying it
  - [x] Reconstruct complete authenticated policy/spend/denial ancestry and review atomic restoration into a new directory under a certified successor; require four fresh exact-head acknowledgements before every open can serve admission, and test two generations, stale backups, append races and nine restore SIGKILL boundaries (`docs/developers/v0.4-admission-history-restore.md`)
  - [x] Wire explicit direct protected-history configuration into relay startup; wait for fresh quorum before listening, account outbound history sockets, and test the real entry point refusing three-copy startup, missing history and local-only fallback (`docs/developers/v0.4-protected-admission-operations.md`)
  - [x] Add owner configuration/preparation/export and digest-reviewed volunteer enrollment/serve commands; retain and route complete certified generation chains across restart, resume only provably unactivated empty slots, and test five separate volunteer processes plus corruption/capacity/SIGKILL (`docs/developers/v0.4-volunteer-history-operations.md`)
  - [ ] Complete operator restore/maintenance and desktop integration, quorum-safe compaction and complete policy/spend/witness recovery before enabling protected admission by default
    - [x] Inspect certified activated successors from independently backed-up genesis pins with bounded owner-authenticated reads; distinguish an observed leaf from current writer authorization and preserve confirmed but unactivated decisions
    - [x] Compose reviewed freeze, actual agreement selection, resumable ancestry download/provisioning and separately approved restoration in operator commands; preserve spends and permanent denials after three lost-owner generations, require fresh readiness and test workflow SIGKILL (`docs/developers/v0.4-owner-history-recovery.md`)
    - [x] Add offline protected retirement/legacy-recovery review and explicitly approved four-copy mutations; refuse implicit policy changes and preserve pending work, unproven rows and permanent denials across lost replies and subsequent owner recovery (`docs/developers/v0.4-protected-maintenance.md`)
    - [ ] Carry history exchange over authenticated reverse relay links for outbound-only volunteers and integrate its lifecycle with the desktop background service; pinned direct endpoints alone do not complete NAT participation
      - [x] Add explicitly pinned, bounded history streams on authenticated inbound/outbound relay links; preserve four-copy admission and complete lost-owner recovery through five outbound-only local volunteers (`docs/developers/v0.4-history-reverse-links.md`)
      - [x] Reopen an explicitly configured enrolled volunteer in the ordinary relay process and desktop service definitions; retain controller pins across GUI restarts, apply new-storage resource controls and verify real-process restart, missing-state refusal and silent-contact shutdown (`docs/developers/v0.4-history-volunteer-runtime.md`)
      - [x] Start explicitly pinned protected-owner relay transport before history readiness; keep all user admission and witness votes closed, bound connection waiting, expose readiness and preserve exact credentials/history across fourth-copy arrival and restart (`docs/developers/v0.4-history-owner-runtime.md`)
      - [x] Support a configured volunteer bridge when both endpoints are outbound-only; preserve five distinct members, four-copy progress with a missing first target, bounded forwarding and lost-owner recovery (`docs/developers/v0.4-history-volunteer-bridge.md`)
      - [x] Retain protected-owner/bridge configuration in desktop service definitions, load identity passphrases from bounded private files, and distinguish listening from admission readiness; verify generated environments with real owner/bridge processes (`docs/developers/v0.4-history-desktop-service.md`)
      - [x] Expose authenticated aggregate owner/volunteer/bridge health and local storage/transfer accounting without payloads, private identifiers or a false live-quorum claim (`docs/developers/v0.4-history-health.md`)
      - [x] Carry operator recovery and protected maintenance over explicitly pinned outbound/bridged links, using retained encrypted infrastructure identity, lazy offline adapters and bounded cancellation (`docs/developers/v0.4-history-operator-transport.md`)
      - [x] Share reviewed operator commands with the desktop and persist an authenticated maintenance pause; exclude competing runtime/control operations, verify stopped state and retain histories through cancellation, corrupt settings and forced process death (`docs/developers/v0.4-desktop-history-maintenance.md`)
      - [x] Support separately prepared protected spend/writer locations while retaining policy, witness and infrastructure state; bind the history context in encrypted policy storage to refuse local fallback and preserve it across policy updates (`docs/developers/v0.4-history-desktop-service.md`)
      - [x] Review prepared/recovered owner activation offline, require four fresh exact-head copies before preparing the bound policy, and save approved desktop service paths while paused; preserve tokens/denials through three restored generations, settings failures, cancellation and six policy SIGKILL boundaries (`docs/developers/v0.4-desktop-history-activation.md`)
      - [x] Expose bounded reviewed freeze, workspace resumption and separate restore approval in the desktop; retain progress through missing quorum, lock/cancel/disconnect and failed settings writes, then activate the recovered owner separately (`docs/developers/v0.4-desktop-owner-recovery.md`)
      - [x] Review retained restorations against authenticated recovery ancestry and resume readiness with four fresh copies; retain exact state through six process-death boundaries and allow only explicitly reviewed pristine writer/archive setup (`docs/developers/v0.4-restoration-readiness.md`)
      - [x] Add reviewed desktop initial owner configuration, preparation/resumption/export and volunteer enrollment; separately require four fresh copies of the independently pinned initial history before activation, and preserve setup through eight process-death boundaries (`docs/developers/v0.4-desktop-history-setup.md`)
      - [x] Review and activate an existing enrolled volunteer while paused; retain controller/member/genesis/directory pins, bind complete retained history to approval, edit per-generation capacity without discarding records and preserve coexisting owner/volunteer roles (`docs/developers/v0.4-desktop-volunteer-activation.md`)
      - [x] Resume interrupted volunteer enrollment only from an authenticated empty genesis manifest or a fully validated retained chain; preserve the original genesis through enrollment/resumption process death, reject missing accepted history and retain desktop progress after settings failures (`docs/developers/v0.4-desktop-history-setup.md`)
      - [x] Review owner ciphertext archive limits offline, retain accepted and unarchived pending records, save a new configuration and require separate fresh-readiness activation (`docs/developers/v0.4-desktop-history-setup.md#owner-archive-limits`)
      - [x] Finish combined history/runtime/recovery-workspace storage budgets
        - [x] Add a bounded explicit filesystem inventory, preserve previously saved history/workspace locations and refuse unknown storage; keep byte observations distinct from write reservations (`docs/developers/v0.4-combined-storage-budget.md`)
        - [x] Durably retain approved desktop history/recovery directories before apply, including previous selections; preserve them after settings failure and process death without claiming a shared byte quota
        - [x] Bound structured diagnostics for new managed-service definitions to two 1 MiB files, preserve startup errors and expose private health without unlimited supervisor stream capture (`docs/developers/v0.4-relay-diagnostics.md`)
        - [x] Bound resource-counter checkpoints to 4 KiB each plus replacement headroom; refuse uncertain writes, unsafe counters and clock rollback without resetting allowance
        - [x] Retain exact desktop configuration/enrollment output files before creation, preserve them across settings failure and process death, and inventory them without scanning unrelated parent folders
        - [x] Account for control metadata and explicit operator output files; retain the distinction between relay-data and whole-device budgets (`docs/developers/v0.4-storage-writer-map.md`)
        - [x] Implement a durable shared reservation authority and optional encrypted-snapshot leases; reserve lifetime replacement peaks, retain allocations through process death and bind limit changes to current review
        - [x] Add optional shared leases to journals, counters, diagnostics, history ciphertext, identity and manual spend writers; reserve block and manifest peaks before initialization and preserve existing work at full capacity
        - [x] Reserve operator outputs, bounded settings/registry replacements, standalone ownership and pause headroom; preserve interrupted files and reuse scoped temporary allocations
        - [x] Bound and atomically publish generated macOS/Linux/Windows service files; reserve the complete output set before writes and run native commands only afterwards (native execution remains mocked)
        - [x] Preserve generation allocations through fixed child paths, authenticated legacy location migration and captured provisioning scopes; reserve child and next-slot peaks before parent activation and test full-budget SIGKILL recovery
        - [x] Retain the opening authority in recovery, readiness, activation and enrollment apply methods; reject scope switching and test later-writer exhaustion before output
        - [x] Add bounded reviewed adoption of existing/unknown files with monotone byte floors, stale-review refusal and v1-ledger preservation; test retained history and real SIGKILL recovery before product integration
        - [x] Permit only already funded maintenance controls while another process owns the authority; revalidate committed metadata, preserve output exclusion and test full-budget pause/SIGKILL without a second ledger writer
        - [x] Split durable native-service preparation from start; reject changed definitions and stale start handles, and test a real child acquiring the released full authority before mocked native startup
        - [x] Require adopted scopes for managed writers, review absent new locations separately from missing history, and compose runtime/stopped ownership; verify actual Node publication, full-budget pause, SIGKILL and restart before product selection is enabled
        - [x] Review and export bounded immutable storage selections under stopped ownership; preflight scope/capacity without mutation and reject stale approval, partial/changed pins and authority-metadata output
        - [x] Use one pinned selection in the actual Node entry, serving CLI and desktop lifecycle; require a closed configured listener, retain ownership through deferred shutdown, fund pause/settings beside a live owner and release it before native startup
        - [x] Hold bounded existing/new-scope reviews through approval under runtime/ledger exclusion; cancel or expire abandoned reviews, require fresh approval after SIGKILL and support independently retained authority IDs before initial creation
        - [x] Persist desktop bootstrap intent and a separate creation-attempt fence before ledger initialization; bind bounded approvals to the authenticated session and stopped runtime, retain pause on interruption and reopen only the independently pinned primary
        - [x] Enumerate known retained roots, exact desktop/native outputs and unknown namespaced sidecars; distinguish missing history from future native parents and test composition with scoped adoption, selection export and native-file preparation
        - [x] Compose authenticated desktop adoption with reviewed limits, existing byte floors and new scopes; retain allocations across interrupted commits, compare independent metadata between stages and refuse missing reserved registries or roots containing desktop account data
        - [x] Retain bounded immutable selection attempts, reuse only complete matching outputs after durability confirmation and preflight combined writer peaks; test partial/complete SIGKILL recovery and include the native diagnostics sibling in adoption
        - [x] Compose authenticated selection/native-file/settings handoff under stopped ownership; require checked native supervision removal, retain pause and recover published selections after failures or SIGKILL; verify the generated settings with real Node publication/restart
        - [x] Expose opt-in bootstrap/adoption/activation reviews, stopped limit changes and read-only aggregate reservation health in the desktop; distinguish unavailable accounting from zero and reserved capacity from disk use
        - [x] Refuse unreserved materialized-view and native HNSW exports for managed state, including after its construction scope exits; preserve independent exports and verify the live runtime still uses its reserved journal
        - [x] Review and retain later role/output locations for an already selected desktop budget without resetting authority or declaring missing history new; verify actual protected-owner preparation through the authenticated app API
        - [x] Complete the production writer/retained-root audit across selected runtime, desktop and CLI, including role changes and interrupted output; keep unmanaged application/device data outside the named budget (`docs/developers/v0.4-storage-writer-map.md`)
        - [x] Persist cross-role reservations before writes, include replacement/repair headroom and prove recovery of interrupted reservations across runtime and CLI; pass 440 storage regressions and interactively verify desktop reviews with native commands mocked
    - [x] Publish reviewed complete spend-state checkpoints on four volunteers without changing policy, spends or permanent denials; retain exact pending ciphertext through reply loss and process death, and verify actual owner recovery (`docs/developers/v0.4-history-compaction.md`)
    - [x] Authenticate checkpoint ancestry against the independently enrolled genesis with four distinct volunteer endorsements; collect bounded evidence over direct, outbound and bridged transports while preserving later accepted records and frozen generations
    - [x] Reconstruct and review a protected owner from its original genesis, certified full-state checkpoint and complete selected suffix; authenticate intervening continuation barriers, preserve later spends and require four fresh copies before serving
    - [x] Persist monotone checkpoint certificates in each volunteer's encrypted authoritative manifest under current local review; preserve suffixes, barriers and reservations through uncertain writes, five SIGKILL boundaries and cross-generation reopen
    - [x] Authorize bounded remote certificate retention/read with fresh owner signatures and member-signed responses over direct, outbound and bridged transports; retain committed proof after expiration during persistence without issuing a late success
    - [x] Download a complete selected suffix across continuation barriers using explicit independently pinned checkpoint evidence; retain its original genesis locally, resume after crashes and verify actual protected restoration while omitted-prefix network reads fail
    - [x] Prepare frozen recovery from an explicitly certified checkpoint and complete later suffix; preserve partially replicated tails, require four fresh freeze replies, pin exact evidence on reopen and reject regression of retained selections
    - [x] Install a certified checkpoint and selected suffix on a lagging frozen replica while retaining its earlier accepted blocks and agreement barriers; verify bounded proof binding, reply loss, restart and five SIGKILL installation boundaries
    - [x] Compose compacted freeze, selection, download, repair, provisioning and reviewed restoration with explicitly pinned proof; exercise current/ancestor anchors and real CLI commands through restored four-copy readiness
    - [x] Review and certify the latest complete protected checkpoint, export its proof without overwriting prior output, and separately retain it on four volunteers through real CLI commands; preserve partial retention, cancellation and original-genesis pins across restoration
    - [x] Retain certified checkpoints in the live owner's encrypted archive and repair lagging unfrozen volunteers through a separately authenticated installation; preserve accepted segments, survive lost replies/restart/SIGKILL, and still require four fresh target append receipts
    - [x] Review and atomically retire ciphertext before a durably certified checkpoint in owner and volunteer archives; preserve genesis, suffixes, pending-work guards and recovery barriers, resume cleanup after crashes and verify real CLI maintenance and restoration after physical deletion
    - [x] Bound owner/replica indices and recovery work by retained payloads instead of absolute sequence positions; preserve legacy manifests and demonstrate repeated four-payload cycles plus certified high-sequence live repair and restoration
    - [x] Reserve one complete prospective checkpoint in the owner archive before new mutation intent, including encrypted size and safe-counter headroom; preserve exact existing pending work and verify refusal/checkpoint/retirement/resume cycles
    - [x] Bind volunteer checkpoint space to signed new envelopes, require four replicas with that headroom, preserve it on reopen and consume it only through subsequent authenticated history or a durable freeze; use coarse byte ceilings and preserve older pending records
    - [x] Explicitly authorize certified prefix reclamation during live checkpoint repair, persist that permission, preserve old opt-in boundaries and exercise returning fourth-member repair, lost replies and installation/retirement process death within four-payload budgets
    - [x] Start fresh generation discovery from an explicitly supplied checkpoint certificate rooted in independent genesis, preserve old recovery workspace formats, and restore over real sockets with older generation routes unavailable
    - [x] Discover retained checkpoint evidence from four fresh authenticated volunteers using the original genesis pin; save the exact proof before recovery, with direct, outbound and bridge transport coverage
    - [x] Reopen an existing non-genesis replica through an explicitly selected certified frontier, preserving its actual checkpoint, accepted suffix, freeze/agreement/activation and original genesis pin; reject incomplete or regressed evidence before cleanup
    - [x] Export four authenticated durable certificate-retention acknowledgements, commit an encrypted service frontier before retiring ancestor directories, and preserve original genesis/current barriers through restart, actual CLI maintenance and process-death tests
    - [x] Bind a fixed child destination in provisioning journals, preserve existing formats, refuse occupied/unfunded/missing pool capacity before activation, and resume the same destination through eight process-death boundaries
    - [x] Replace future generation-specific allocations with reviewed bounded reusable slots; retain existing lifetime reservations and fund interrupted successors without inferring free capacity from missing history
      - [x] Select a funded fixed pool before genesis activation, durably finish cleanup before reusing a location, preserve accepted genesis work and verify repeated recovery, full-budget refusal and process-death boundaries
      - [x] Migrate a certified current legacy generation through a reviewed, authoritative same-filesystem relocation and resumable cleanup; preserve pending successors until completion and prevent stale-layout fallback
    - [x] Resolve interrupted local ownership claims that lack a complete PID without guessing that another writer is dead; preserve single-writer exclusion across supported platforms
      - [x] Publish complete PID/nonce directory claims atomically, reclaim only known-dead owners, preserve incomplete legacy files and verify ten process-death boundaries, concurrent processes and integrated history/desktop recovery (`docs/developers/v0.4-local-ownership.md`)
      - [x] Pass the focused Linux/macOS/Windows ownership, encrypted-state and reservation CI matrix; run `39063197304` passes all three jobs without packaging applications
    - [x] Bound retained generation ancestry with certified frontiers and reusable funded locations; preserve original genesis and recovery barriers through repeated signed recoveries and retirement, with explicit safe-counter and capacity refusal (`docs/developers/v0.4-history-compaction.md#bounded-ancestry-audit`)
    - [x] Capture intact witness/coordinator state behind same-file fences, replicate decisions before responding, and restore the same keys and permanent denials through owner loss; preserve version-one images and test seven migration SIGKILL boundaries (`docs/developers/v0.4-protected-role-recovery.md`)
    - [x] Add reviewed desktop creation/capture controls for new and existing protected roles, and measure near-capacity signing/replication costs
      - [x] Review and capture existing local roles from authenticated desktop maintenance; retain both locations through settings failure, bind source/policy/transport to approval, expose capacity and preserve local decisions on cancellation
      - [x] Generate genuinely new role keys behind encrypted preparation journals, expose only public keys before policy enrollment/capture, and export usable keys only with retained fences and four fresh copies; test seven process-death boundaries
      - [x] Measure signing/replication near capacity and address repeated/cold verification costs; retain separate-process application traffic, CPU/RSS and concurrent refusal evidence without extending deadlines (`docs/developers/v0.4-native-signature-verification.md`)
  - [ ] Resolve authenticated policy freshness and migration beyond the bounded 64-configuration archive; never treat missing records as unused capacity or discard permanent denial evidence
  - [ ] Resolve same-key witness replacement, membership governance/freshness, and history compaction before enabling admission by default; fresh-key cohort rotation does not rescue stranded old tokens or remove finite history limits
- [ ] Measure protection against a curious relay, colluding relays, Sybil relays, and a network observer
  - [x] Capture entry and destination observations in separate local processes and demonstrate the original unpadded frame-length leak, then verify bucket padding removes exact-length differences within a bucket
  - [x] Run an eight-client local timing diagnostic across burst and sparse workloads: scheduling reduced burst action-order matches to 4/24, but inter-hop order still matched 24/24 in every condition; retain the report and traces without claiming Internet anonymity
  - [x] Compare shared entry mixing in separate relay processes over 192 completed searches: burst request-order matches fell from 20/24 to 2/24 on loopback and from 15/24 to 7/24 with simulated frame delays; sparse traffic and reply timing remain exposed, with latency and traces retained in `docs/evals/private-mix-2026-09-29T14-09-59-545Z.md`
  - [x] Isolate reply batching in a second 192-search comparison: loopback burst reply-order matches fell from 24/24 to 2/24, but delayed bursts changed from 5/24 to 6/24 and sparse traffic remained exposed; retain the added latency and negative results in `docs/evals/private-reply-2026-09-29T14-30-17-612Z.md`
  - [x] Decide the quiet-period resource policy: no automatic cover traffic, crowd polling, or longer quiet queues; specify bounded interactive delivery and an explicit local hold with no automatic release, with costs and limits in `docs/developers/v0.4-quiet-period-decision.md`
  - [x] Enforce one ten-second operation deadline across client scheduling, discovery, DNS, and all private route attempts; cancel pending sockets, preserve timely partial mailbox replies and unknown outcomes, and verify exact-operation/wallet retry after a lost reply
  - [x] Add bounded encrypted local hold/release controls; never send held work or reserve capabilities on restart, expiry, cancellation, or outbox overflow
    - [x] Publications: encrypted 64-entry / 16 MiB outbox, explicit desktop Send/Cancel, pinned private routes, crash recovery without replay, and exact retry after an uncertain delivery; exclude held publications from mailbox sync
    - [x] Searches and per-mailbox checks: encrypted 24-hour intents, fresh signed requests only on explicit Run, persistent pause across all automatic mailbox paths, bounded releases, and uncertain-outcome recovery without automatic retry; a selected mailbox run includes its required acknowledgements, connection responses, and pending messages
  - [x] Replace heap-delta HNSW memory evidence with isolated native-process absolute/peak RSS; retain reproducible 10K/100K measurements and explicit full-application exclusions (`docs/evals/hnsw-process-memory-2026-10-17.md`)
  - [ ] Measure stronger observers, total traffic, and CPU/energy costs before selecting production timing defaults; quiet-period observer protection remains unresolved
  - [ ] Run colluding-operator, multi-domain Sybil, and timing-correlation adversaries with quantitative privacy targets
- [ ] Define group-specific, rotating fingerprint epochs to limit correlation across communities and time
  - [x] Derive deterministic group/month-specific public projection matrices and verify cross-scope hashes do not directly match; live v2 still uses the static pilot matrix
- [ ] Measure the matching-quality and privacy effects of fingerprint rotation
  - [x] Add a reproducible synthetic probe for within-scope quality and cross-scope correlation; real-text recall and epoch-boundary migration remain open

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
