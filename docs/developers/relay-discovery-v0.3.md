# Relay Discovery for v0.3

The first v0.3 network primitive separates **where a relay might be** from **what a relay has cryptographically proved about itself**.

## Trust model

A configured URL, invitation, local-network result, or peer-exchange result is a contact hint. A hint is not an authority and does not become trusted because it appeared in a bundled list. A connection must obtain a signed relay descriptor and verify its stable relay infrastructure identity. An invitation may pin the expected relay ID; an unpinned hint learns that identity only after verification.

Every descriptor is short-lived and signed by the relay identity. It binds:

- canonical WebSocket endpoints, or an explicit `outbound-only` reachability state;
- publication, mailbox, query, forwarding, and replica-exchange capabilities;
- supported matching groups;
- configured and currently available storage capacity;
- a monotonic sequence and a validity window of at most 24 hours.

These fields are claims, not measurements. Later connection management will combine them with direct observations such as successful handshakes, reachability checks, latency, and fulfilled durability receipts.

## Signed peer exchange

Peer requests use a fresh one-use signing key so discovery does not expose a personal identity or create a stable requester identifier. Requests expire within 60 seconds and cap responses at 32 descriptors.
An empty requested-group list accepts relays from any group; otherwise, every returned relay must advertise at least one requested group.

The responding relay signs the complete response, including the request ID and descriptor set. Each returned descriptor must also carry its own valid relay signature and be active at response time. Response verification rejects duplicate relay identities, stale descriptors, unsorted or non-canonical data, extra fields, responses larger than the request allowed, and discovery frames over 1 MiB.

This exchange provides discovery, not consensus. A malicious relay can still advertise Sybil identities that it controls. Replica placement therefore must use independently observed peers and diversity signals, and must treat signed durability receipts and subsequent repair checks as stronger evidence than a peer recommendation.

## Relay-server integration

When discovery is enabled, a relay exposes its current signed descriptor at `GET /relay-descriptor` and answers `relay_peer_request` WebSocket frames with a signed, bounded `relay_peer_response`. Requests are one-use, short-lived, replay-protected, and rate-limited by transport address.

The relay directory accepts only active, independently verifiable descriptors. A higher signed sequence replaces an older descriptor for the same relay. Same-sequence conflicts and lower sequences are rejected. The directory is bounded, does not evict established entries merely to accept a new identity, and removes expired descriptors. These controls limit memory use and make simple cache-filling attacks less effective; they do not solve Sybil discovery.

The standalone relay enables discovery when `RELAY_DISCOVERY=true` or `RELAY_PUBLIC_ENDPOINTS` contains a comma-separated list of public `ws://` or `wss://` endpoints. `RELAY_SUPPORTED_GROUPS` defaults to `public`. `RELAY_STORAGE_CAPACITY_BYTES` and `RELAY_STORAGE_AVAILABLE_BYTES` control the signed capacity claim and default to 1 GiB when discovery is enabled. A relay with discovery enabled and no public endpoint advertises itself as `outbound-only`.

## Outbound discovery

The outbound discovery client accepts configured, invitation, or local contact hints and creates a fresh request identity for every connection. It verifies the complete signed response, requires an invitation's relay-ID pin to match, and requires the responder's independently signed descriptor to bind the exact endpoint contacted. Only then does the server merge returned descriptors into its bounded directory.

`RELAY_CONTACTS` can provide a comma-separated set of configured contact endpoints to the standalone relay. They are queried in parallel after the relay starts. The contacts remain hints: they do not become authorities, and every descriptor they return must verify independently. Peer-exchange descriptors are cached but are not dialed automatically, preventing an untrusted relay from turning discovery into an unrestricted connection or local-network scanning mechanism.

## Authenticated outbound links

A discovery-enabled relay maintains authenticated WebSocket links to configured `RELAY_CONTACTS`. This lets an `outbound-only` volunteer establish a route through a directly reachable community relay without opening a listening port to the Internet.

The initiator signs a short-lived, one-use link request with its relay infrastructure key and includes its current signed descriptor. The responder verifies both signatures, rejects replays and duplicate connections, applies per-address rate limits and a bounded inbound-link limit, and returns a signed acceptance bound to the request and initiator. Invitation pins and exact endpoint binding still apply on the outbound side. Personal-node identities are never part of the handshake.

Both sides monitor the connection with WebSocket ping/pong frames. Missed heartbeats close the link, and the outbound manager reconnects with exponential backoff. Links also close and reauthenticate when either signed descriptor expires, so a live socket cannot extend stale reachability, group, capability, or capacity claims. `connected_relays` reports the union of authenticated inbound and outbound relay identities.

## Replica placement and receipts

An authenticated link can carry `relay_replica_put` requests for owner-signed publication records and tombstones. The sending relay signs the complete request with its infrastructure identity, including a one-use request ID and short validity window. The receiver requires that identity to match the authenticated link, verifies the nested publication-owner signature, applies a separate per-relay rate limit, and enforces its advertised matching groups. It keeps a bounded global and per-sender replay cache after those checks. A duplicate of a cached exact signed request receives the same signed receipt, which makes a lost response safe to retry; a request-ID collision with a different signature closes the link.

An accepted operation passes through the same append-only journal and materialized publication store as a direct client submission. The receiver fsyncs a new journal record before returning a `relay_replica_receipt`. The receipt is signed by the receiving relay and binds the sender, request, publication ID, operation kind, sequence, and owner signature. Exact retries receive an `already-stored` receipt; stale, conflicting, terminal, expired, unsupported, or failed writes receive a signed rejection and do not count as durable copies.

The placement controller journals an intent before a locally submitted publication operation is committed. An intent records the exact owner-signed operation, an ordered set of relay IDs, a desired count (five by default), and a receipt-confirmed quorum (three by default). It journals each positive receipt before counting it. On restart, the relay first rebuilds publication state, then replays matching intents and receipts; an intent without its publication operation is ignored.

Only live, direct, authenticated links that were explicitly configured or invited are eligible in this first version. The controller checks the relay's advertised publication-storage, replica-exchange, group, and nonzero-capacity claims, then chooses a stable subset using the publication ID. It starts with fewer targets when fewer configured volunteers are online, grows toward five when they reconnect, retries pending targets on reconnect and at a bounded interval, and preserves previous targets when publishing an update or tombstone. Peer-exchange descriptors are still never auto-dialed.

`RelayServer.getReplicaPlacementStatus(publicationId)` returns the current intent, selected targets, receipt-confirmed targets, pending targets, recent inventory-present and inventory-missing targets, and quorum state. `/stats` exposes `durability_receipts`, `placement_intents`, and `minimum_confirmed_placements`. A receipt is evidence of a past fsync, not proof that a relay is currently reachable or independently operated. The status deliberately calls this **receipt-confirmed**, rather than healthy.

## Receipt-authorized point checks

After a relay has a positive durability receipt for a target, it can send a signed `relay_replica_inventory_request` over the existing authenticated link. The request includes that target-signed receipt and a fresh, short-lived request ID. This is authorization for one exact operation: a link peer cannot use the mechanism to ask whether arbitrary publication IDs are present.

The target validates the requester, its own relay ID, the embedded durable receipt, link capability, freshness, rate limit, and replay state. It replies with a signed `relay_replica_inventory_response` bound to the request and to the receipt's publication ID, sequence, kind, and owner signature. The result is `present`, `missing`, or a rate-limit rejection. `present` means the target's current operation exactly matches; a different revision, tombstone, expired record, conflict, or absent record is reported only as `missing`, so the target does not disclose what it stores instead.

Inventory answers are deliberately memory-only. A new write receipt clears an older observation, and a relay restart treats targets as unchecked and asks again on the next repair pass. A `missing` answer puts that target back into the repair set even though its old receipt remains durable historical evidence. If a target already holds a newer owner-signed operation, the normal replica-put rules reject the older repair request; point checks never permit rollback.

Repair can resume only when the target reconnects under the relay identity named in its receipt. A volunteer that loses both its stored data and its relay identity is a new target; automatic replacement and safe handoff are later work.

Storage capacity in a descriptor is still an unverified claim; this version does not enforce a relay-local quota. A receiver may be full despite a positive capacity claim. Operators must not use the five-target count as a Sybil-resistance or availability guarantee.

## Next integration step

Next work adds compact set reconciliation, actual byte and per-peer storage budgets, retry classification and backoff, diversity evidence, graceful handoff, and query forwarding. Those pieces are needed to turn receipt and point-check evidence into a measured availability claim under churn.
