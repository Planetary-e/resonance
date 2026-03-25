# Resonance Roadmap

> Privacy-preserving decentralized matching — from pilot to production.

## Completed

### v0.1 — Pilot (March 2026)

The protocol works end-to-end. Two nodes can find each other through a relay, open an encrypted channel, confirm a match with true embeddings, and exchange information — all without the relay seeing any raw data.

- Core library: crypto (DID, Ed25519, X25519), embedding (Nomic-embed-text, 768-dim), perturbation (Laplace noise), wire protocol (17 message types)
- Personal node: encrypted SQLite store, 8 CLI commands, relay client, channel manager
- Relay server: WebSocket with DID auth, HNSW matching engine, rate limiting, persistence, offline notification queuing
- Direct channels: consent handshake, X25519 key exchange, E2E encrypted messaging, match confirmation, progressive disclosure
- Eval suite: 35 metrics, all passing
- Documentation: 13-page website for users, developers, organizations, and press

---

## In Progress

### v0.2 — Real-World Hardening

**Goal:** Run a public relay and onboard the first 50 real users in Barcelona.

- [ ] Deploy relay to VPS (Hetzner/OVH, EU)
- [ ] Background daemon mode (`resonance serve` as systemd service)
- [ ] Persistent relay client with auto-reconnect and exponential backoff
- [ ] Item expiry and garbage collection (TTL enforcement on relay)
- [ ] Error recovery: handle relay restarts, network drops, partial handshakes
- [ ] Notification history: store all past match notifications, not just pending
- [ ] Logging improvements: structured logs for node CLI, log levels
- [ ] Security audit: review crypto usage, input validation, rate limit tuning

---

## Planned

### v0.3 — Multi-Relay Federation

**Goal:** No single point of failure. Users can choose or rotate relays.

- [ ] Relay discovery: bootstrap nodes + DNS SRV records
- [ ] Publish to multiple relays simultaneously
- [ ] Relay-to-relay gossip protocol for perturbed embedding replication
- [ ] Relay rotation: periodic relay switching to prevent profiling
- [ ] VRF-based relay selection (verifiable random function)
- [ ] Relay reputation: track uptime and match quality

### v0.4 — Direct P2P Channels

**Goal:** Remove the relay from the data path after consent.

- [ ] NAT traversal: STUN/TURN for direct TCP/UDP between nodes
- [ ] ICE candidate exchange via relay during consent
- [ ] Fallback: relay-bridged mode when direct connection fails
- [ ] Connection quality metrics and automatic mode selection

### v0.5 — Web Interface

**Goal:** Non-technical users can use Resonance from a browser.

- [ ] Local web UI served by `resonance serve` on localhost
- [ ] Publish needs/offers from browser
- [ ] View matches and manage channels
- [ ] Progressive disclosure UI with clear privacy indicators
- [ ] Mobile-responsive design

### v0.6 — Mobile

**Goal:** Resonance in your pocket.

- [ ] React Native or native mobile app (iOS + Android)
- [ ] Background matching notifications (push via relay)
- [ ] On-device embedding inference (ONNX on mobile)
- [ ] Secure key storage (Keychain/Keystore)

### v0.7 — Index Sharding & Scale

**Goal:** Support 100K+ concurrent users.

- [ ] LSH-based routing: embeddings routed to topic-specific relay shards
- [ ] Geographic sharding: region-aware relay selection
- [ ] Index partitioning: split HNSW across multiple relay instances
- [ ] Load balancing and horizontal relay scaling
- [ ] Benchmark at 100K, 500K, 1M embeddings

### v0.8 — Reputation & Trust

**Goal:** Quality signals without centralized ratings.

- [ ] Post-match feedback (anonymous, encrypted)
- [ ] Reputation scores derived from match outcomes
- [ ] Sybil resistance: proof-of-unique-human or social graph verification
- [ ] Relay operator reputation

### v0.9 — Economic Layer

**Goal:** Sustainable relay operation without platform extraction.

- [ ] Network credits for relay operators (compute compensation)
- [ ] Optional micropayments for premium matching (priority indexing)
- [ ] Community-governed relay funding
- [ ] No ads, no data sales — economics aligned with users

---

## Future Exploration

- **Multi-model support** — Cross-model projection layers for interoperability between different embedding models
- **Semantic categories** — Optional category tags for coarse-grained routing before vector matching
- **Group matching** — Match N parties with complementary skills/needs (teams, projects)
- **Offline-first mesh** — Bluetooth/local WiFi P2P for matching without internet
- **Governance** — Community governance for protocol upgrades and relay policies

---

## How to Contribute

See [CONTRIBUTING](docs/developers/contributing.html) for development setup. Issues tagged with `good first issue` are a great starting point.

Track progress on the [GitHub Project Board](https://github.com/orgs/Planetary-e/projects).
