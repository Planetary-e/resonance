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

The responding relay signs the complete response, including the request ID and descriptor set. Each returned descriptor must also carry its own valid relay signature and be active at response time. Response verification rejects duplicate relay identities, stale descriptors, unsorted or non-canonical data, extra fields, and responses larger than the request allowed.

This exchange provides discovery, not consensus. A malicious relay can still advertise Sybil identities that it controls. Replica placement therefore must use independently observed peers and diversity signals, and must treat signed durability receipts and subsequent repair checks as stronger evidence than a peer recommendation.

## Next integration step

Relays will expose the request/response frames on their WebSocket endpoint, maintain a bounded descriptor cache, and merge configured, invitation, local, and exchanged hints by relay ID and descriptor sequence. Connection management will then maintain several outbound peer links, including for relays that cannot accept unsolicited inbound connections.
