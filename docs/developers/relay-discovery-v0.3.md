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

An authenticated link can carry `relay_replica_put` requests for owner-signed publication records and tombstones. The sending relay signs the complete request with its infrastructure identity, including a one-use request ID and short validity window. The receiver requires that identity to match the authenticated link, verifies the nested publication-owner signature, rejects request replays, applies a separate per-relay rate limit, and enforces its advertised matching groups.

An accepted operation passes through the same append-only journal and materialized publication store as a direct client submission. The receiver fsyncs a new journal record before returning a `relay_replica_receipt`. The receipt is signed by the receiving relay and binds the sender, request, publication ID, operation kind, sequence, and owner signature. Exact retries receive an `already-stored` receipt; stale, conflicting, terminal, expired, unsupported, or failed writes receive a signed rejection and do not count as durable copies.

The outbound manager retains the latest verified durability receipt per publication and receiving relay. The `/stats` response exposes the aggregate as `durability_receipts`. Receipts are currently memory-resident placement evidence; persistent receipt state, target selection, quorum policy, retry queues, and inventory repair remain later v0.3 work.

## Next integration step

Connection management will refresh known contacts, add local discovery, and select link targets from independently observed peers under an explicit dialing policy. The next replication step will persist placement intent and receipt state, choose a five-relay target set, and retry until at least three independently verified copies are healthy.
