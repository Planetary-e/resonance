# Planetary Resonance — Pilot PRD

**Version:** 0.1
**Date:** March 2026
**Author:** Marcos Cuevas / Planetary Project
**Status:** Ready for implementation
**Target:** Claude Code input for building the minimum viable protocol

---

## Problem Statement

Centralized platforms (LinkedIn, Airbnb, Craigslist, dating apps) extract value from matching people with complementary needs. Users surrender their data — what they need, what they offer, where they are, who they know — and the platform monetizes it through ads, algorithmic manipulation, and data brokerage. There is no way today for two people to discover that they can help each other without a corporation sitting in the middle, reading everything, and taking a cut.

Planetary Resonance solves this by enabling **privacy-preserving matching via vector embeddings**. Users describe needs and offers in natural language; the system converts them to embeddings locally, sends only noisy (perturbed) versions to the network, and notifies both parties when a match is found. Raw data never leaves the user's device.

**Who is affected:** Anyone who uses a platform to find work, housing, services, education, or human connection — and pays for it with their data and autonomy.

**Impact of not solving it:** The centralized matching economy continues to concentrate power. The World Order analysis documents how each crisis cycle strengthens extraction. AI will accelerate this unless a distributed alternative exists.

---

## Goals

1. **Prove the protocol works end-to-end:** A user on Node A publishes a need, a user on Node B publishes a matching offer, both receive a match notification, open a direct encrypted channel, and confirm the match — all without any central server seeing raw data.

2. **Demonstrate privacy-preserving matching:** Perturbed embeddings sent to the relay cannot be used to reconstruct the original text. Empirically validate recall vs. privacy tradeoff at different epsilon values.

3. **Run on consumer hardware:** Personal node runs on a laptop or Raspberry Pi. Relay runs on a €10/month VPS. No GPU required. Embedding inference <100ms on CPU.

4. **Support both async and real-time matching:** Persistent embeddings match passively (bulletin board), live queries match actively (search mode).

5. **Establish the codebase foundation:** Clean, modular code that future contributors can extend to add relay rotation, sharding, geo-routing, and governance without rewriting.

---

## Non-Goals (Pilot Scope)

1. **Relay rotation / VRF selection** — Pilot uses static relay(s) operated by the Planetary team. Rotation is a scaling feature for later.
2. **Index sharding / LSH routing** — Pilot uses a single shard. All embeddings go to all relay replicas. Sharding is added when the index exceeds ~100K embeddings.
3. **NAT traversal for direct channels** — Pilot assumes nodes can reach each other (same network or public IPs / port forwarding). ICE/STUN/TURN added in v0.2.
4. **Mobile app** — Pilot is CLI + optional web UI. Native apps are a future phase.
5. **Multi-model projection layers** — Pilot uses a single embedding model (Nomic-embed-text). Cross-model support deferred.
6. **Reputation system** — Pilot has no review/reputation mechanism. Added after the protocol is stable.
7. **Network credits / compensation** — Pilot has no economic layer. Added when there are enough participants to justify it.

---

## User Stories

### As a person with a need (Seeker)

- **US-1:** As a seeker, I want to describe my need in natural language ("I need a plumber in Barcelona who speaks Spanish") so that the system can find matches without me filling out structured forms.
- **US-2:** As a seeker, I want to control my privacy level (low/medium/high) when publishing, so that I can choose how much matching accuracy I trade for privacy.
- **US-3:** As a seeker, I want to receive notifications when someone matching my need appears on the network, so that I don't have to actively search.
- **US-4:** As a seeker, I want to perform a live search for immediate needs, so that I can find matches right now without waiting.
- **US-5:** As a seeker, I want to open a secure channel with a matched person and progressively share details, so that I control what information I reveal and when.

### As a person with an offer (Provider)

- **US-6:** As a provider, I want to publish what I offer ("freelance Python developer, available remote, €50/h") and be discovered by people who need it.
- **US-7:** As a provider, I want to see match quality (similarity score) before opening a channel, so that I can prioritize the most relevant matches.

### As a node operator

- **US-8:** As a node operator, I want to install and bootstrap my personal node with a single command, so that the barrier to entry is minimal.
- **US-9:** As a node operator, I want to optionally run a relay that contributes to the network's matching capacity.

### As a developer

- **US-10:** As a developer, I want clear module boundaries (embedding engine, perturbation, relay client, channel manager) so that I can contribute to one component without understanding the entire system.
- **US-11:** As a developer, I want a local development mode where I can run multiple nodes and a relay on the same machine for testing.

---

## Architecture Overview

Three-tier architecture, built from scratch (no dependency on existing P2P protocols):

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Personal    │  │ Personal    │  │ Personal    │
│ Node A      │  │ Node B      │  │ Node C      │
│ (your data) │  │ (your data) │  │ (your data) │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │ perturbed       │ perturbed       │
       │ embeddings      │ embeddings      │
       ▼                 ▼                 ▼
┌─────────────────────────────────────────────────┐
│              Relay (HNSW Index)                  │
│        Receives embeddings, finds matches,      │
│        sends notifications. Sees NOTHING else.  │
└──────────────────────┬──────────────────────────┘
                       │ match notification
                       ▼
              ┌─────────────────┐
              │ Direct Channel  │
              │ A ↔ B (E2E)     │
              │ Confirm + Share │
              └─────────────────┘
```

---

## Requirements

### Component 1: Personal Node (P0 — Must Have)

The personal node is a single binary/process that runs on the user's machine. It is self-contained and fully functional even without network connectivity (for local embedding and storage).

#### 1.1 Local Data Store

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-DS-1** Encrypted SQLite database | Store needs, offers, embeddings, match history | Data encrypted at rest with user's key (libsodium secretbox). Survives restart. |
| **P0-DS-2** Schema | Tables: `items` (id, type[need/offer], raw_text, embedding, perturbed, created_at, privacy_level, status), `matches` (id, item_id, partner_did, similarity, relay_id, status, created_at), `channels` (id, match_id, partner_did, shared_key, status) | Schema created on first run. Migrations supported for future versions. |
| **P0-DS-3** Data never leaves local store | Raw text and true embeddings are never transmitted over the network | Audit: grep codebase for any network send of raw_text or true embedding fields. Zero hits. |

#### 1.2 Embedding Engine

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-EM-1** Local inference | Run Nomic-embed-text (768 dim, 137MB) via ONNX Runtime | Embedding generated in <100ms on modern CPU (M1/i7 or better). No network call. |
| **P0-EM-2** Model download | First-run downloads model from HuggingFace, caches locally | Model cached in `~/.resonance/models/`. Subsequent runs use cache. Checksum verified. |
| **P0-EM-3** Embedding output | Produce normalized float32 vectors, 768 dimensions | All output vectors have L2 norm of 1.0 (±0.001). Cosine similarity between identical inputs = 1.0. |

#### 1.3 Perturbation Engine

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-PE-1** Differential privacy noise | Add calibrated Laplace noise to each dimension based on epsilon | At ε=1.0, noise magnitude sufficient to make cosine similarity between true and perturbed embedding < 0.95. At ε=0.1, < 0.80. |
| **P0-PE-2** Re-normalization | After noise addition, re-normalize vector to unit sphere | All perturbed vectors have L2 norm of 1.0 (±0.001). |
| **P0-PE-3** Privacy budget tracking | Track cumulative epsilon spend per item. Warn on re-publish. | If user re-publishes same item, warn that privacy degrades. Block if cumulative ε exceeds configured max (default: 10.0). |
| **P0-PE-4** Configurable privacy level | CLI flag: `--privacy low|medium|high` mapping to ε=5.0, 1.0, 0.1 | Flag accepted and correctly mapped. Default: medium (ε=1.0). |

#### 1.4 Identity Manager

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-ID-1** DID generation | Generate ed25519 keypair on first run. Store in encrypted keystore. | Keypair persists across restarts. DID format: `did:key:z6Mk...` |
| **P0-ID-2** Signing | Sign all outgoing messages (embeddings, consent signals) with private key | All messages include signature field. Relay verifies signature before accepting. |
| **P0-ID-3** Key export/backup | User can export their DID keypair for backup/migration | Export command produces encrypted file. Import on new device restores identity. |

#### 1.5 Relay Client

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-RC-1** WebSocket connection to relay | Connect to relay via WebSocket (wss://) | Connection established, authenticated via DID signature challenge. Auto-reconnect on disconnect. |
| **P0-RC-2** Publish embedding | Send perturbed embedding + DID + signature to relay | Relay accepts and indexes the embedding. Confirmation received by node. |
| **P0-RC-3** Receive match notifications | Listen for match notifications from relay | Notification received within 1s of relay finding a match. Contains: matchId, partnerDID, similarity score, expiry. |
| **P0-RC-4** Live search | Send ephemeral query embedding, receive results | Results returned within 500ms. Relay does NOT index the query embedding (ephemeral flag). |
| **P0-RC-5** Relay address configuration | Configure relay address(es) via config file or CLI flag | Default: `ws://localhost:9090`. Override with `--relay wss://relay1.planetary.es`. Multiple relays supported. |

#### 1.6 Channel Manager

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-CH-1** Consent handshake | Signal interest in a match via relay (encrypted for partner only) | Consent message encrypted with partner's DID public key. Relay forwards but cannot read. |
| **P0-CH-2** Key exchange | X25519 Diffie-Hellman with ephemeral keys | Shared secret derived. Both parties have identical key. Forward secrecy: new keys per session. |
| **P0-CH-3** Direct TCP connection | Open encrypted TCP connection to partner | ChaCha20-Poly1305 encrypted stream. Relay not involved after introduction. |
| **P0-CH-4** Match confirmation | Exchange true (non-perturbed) embeddings over direct channel | True cosine similarity computed. If below threshold (default: 0.70), channel auto-closes with "match_not_confirmed". |
| **P0-CH-5** Structured messages | Send typed messages: `disclosure` (share more details), `accept`, `reject` | Message types enforced. Invalid types rejected. Each message signed. |

#### 1.7 CLI Interface

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-CLI-1** `resonance init` | Generate identity, download model, create local DB | All components initialized. Prints DID and status. |
| **P0-CLI-2** `resonance publish --type need\|offer "text"` | Create embedding, perturb, publish to relay | Confirmation printed with item ID and shard info. |
| **P0-CLI-3** `resonance search "text"` | Live search across relay | Top 5 results printed with similarity scores and partner DIDs. |
| **P0-CLI-4** `resonance matches` | List pending match notifications | Table of matches with similarity, partner DID, timestamp, status. |
| **P0-CLI-5** `resonance connect <matchId>` | Open direct channel for a match | Consent sent. Waits for partner. On mutual consent, opens channel and prints status. |
| **P0-CLI-6** `resonance status` | Show node status | DID, connected relays, published items count, active matches, active channels. |
| **P0-CLI-7** `resonance serve` | Run node as long-lived daemon | Listens for match notifications in background. Optional: expose REST API on localhost for web UI. |

---

### Component 2: Relay (P0 — Must Have)

The relay is a separate binary/process. For the pilot, it is a single-shard, non-rotating server. It holds ONLY perturbed embeddings and DID identifiers. It never sees raw data.

#### 2.1 HNSW Index

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-RL-1** In-memory HNSW index | Use hnswlib or usearch for ANN index. 768 dimensions, cosine distance. | Index supports insert and search. Search returns top-K results with similarity scores in <5ms for 100K vectors. |
| **P0-RL-2** HNSW parameters | M=16, ef_construction=200, ef_search=100 | Parameters configurable via config file. Defaults as specified. |
| **P0-RL-3** Persistence | Serialize index to disk periodically (every 60s) and on shutdown | Relay restarts without losing indexed embeddings. Index reload <2s for 100K vectors. |
| **P0-RL-4** Capacity | Handle up to 500K embeddings per instance | Memory usage <4GB at 500K embeddings. Tested with synthetic data. |

#### 2.2 Matching Engine

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-ME-1** On-insert matching | When new embedding arrives, search index for neighbors with similarity ≥ 0.72 | Matches found and notifications sent within 100ms of insertion. |
| **P0-ME-2** Match notifications | Send notification to BOTH matched parties (the new arrival AND the existing indexed embedding's owner) | Both nodes receive notification with matchId, partnerDID, similarity, expiry (default: 7 days). |
| **P0-ME-3** Ephemeral queries | Process live search queries without indexing them | Query results returned. Verify query embedding is NOT in the index afterward. |
| **P0-ME-4** Similarity threshold | Configurable minimum similarity (default: 0.72) | Matches below threshold are not reported. Threshold adjustable via relay config. |
| **P0-ME-5** Deduplication | Don't send duplicate match notifications for the same pair | If A and B already matched on item X, don't re-notify when A re-publishes. Track by DID pair + similarity bucket. |

#### 2.3 Network Server

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-NS-1** WebSocket server | Accept connections from personal nodes on configurable port (default: 9090) | Handles 500+ concurrent connections. TLS optional for pilot (recommended for production). |
| **P0-NS-2** Authentication | Verify DID signature on connection and on each message | Reject unsigned or incorrectly signed messages. Log rejected attempts. |
| **P0-NS-3** Rate limiting | Per-DID rate limiting: max 10 publishes/minute, max 30 searches/minute | Rate-limited messages rejected with appropriate error. Prevents index poisoning. |
| **P0-NS-4** Consent forwarding | Forward encrypted consent messages between matched nodes | Relay cannot decrypt (encrypted for recipient's DID). Forward within 100ms. |
| **P0-NS-5** Admin API | Health check, index stats, connected node count | `/health` returns 200. `/stats` returns: indexed_embeddings, connected_nodes, matches_today, uptime. |
| **P0-NS-6** Logging | Structured JSON logs | Log: connections, disconnections, publishes (DID + timestamp, NOT the embedding), matches, errors. No raw embeddings in logs. |

---

### Component 3: Direct Channel (P0 — Must Have)

The direct channel is a module within the personal node, not a separate service. It handles everything after the relay introduces two nodes.

#### 3.1 Connection Establishment

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-DC-1** Mutual consent protocol | Both nodes must signal `accept` via relay before channel opens | Channel only opens on mutual consent. Unilateral acceptance does not open channel. Timeout: 24h. |
| **P0-DC-2** Ephemeral key exchange | X25519 DH with per-session ephemeral keys, sent via relay (encrypted for partner) | Shared secret derived independently by both parties. Secrets match. Ephemeral keys discarded after derivation. |
| **P0-DC-3** Direct TCP stream | Open encrypted TCP connection. ChaCha20-Poly1305. | Bytes in transit are indistinguishable from random. Authenticated encryption prevents tampering. |

#### 3.2 Match Confirmation

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-MC-1** Exchange true embeddings | Both nodes send full-fidelity (non-perturbed) embeddings over the encrypted channel | True cosine similarity computed by both parties independently. Values match (±0.001). |
| **P0-MC-2** Threshold check | If true similarity < 0.70, auto-close with `match_not_confirmed` | Channel closed gracefully. User informed: "Match was a false positive from privacy noise." |
| **P0-MC-3** Confirmation signal | If similarity ≥ 0.70, both send `confirmed` and channel enters exchange mode | Channel state transitions to `active`. Both parties notified. |

#### 3.3 Structured Exchange

| Requirement | Detail | Acceptance Criteria |
|---|---|---|
| **P0-SE-1** Message types | `disclosure` (share additional info), `accept` (agree to engage), `reject` (decline), `close` (end channel) | All message types supported. Unknown types rejected. |
| **P0-SE-2** Progressive disclosure | `disclosure` messages contain user-chosen text (category, then details, then contact — user decides) | No automatic sharing. Each disclosure is a deliberate user action. |
| **P0-SE-3** Graceful close | Either party can close the channel at any time | Close signal sent. Both parties' channel state updated. Resources freed. |

---

## Technical Decisions

### Language

| Component | Language | Rationale |
|---|---|---|
| Personal Node | **TypeScript (Node.js)** | Fast iteration, rich npm ecosystem for crypto (tweetnacl, noble-ed25519) and WebSocket. Easier for contributors. ONNX Runtime has Node.js bindings. |
| Relay | **TypeScript (Node.js)** | Same language as personal node for code sharing (wire protocol types, crypto utils). hnswlib-node for ANN index. |
| Alternative: Rust | If performance is critical | Consider Rust for relay if Node.js can't handle 500+ concurrent connections with HNSW search. Benchmark first. |

### Key Libraries

| Function | Library | Version | Notes |
|---|---|---|---|
| Embedding inference | `onnxruntime-node` | latest | Run Nomic-embed-text ONNX model locally |
| ANN index (relay) | `hnswlib-node` | latest | HNSW implementation with Node.js bindings |
| Encryption | `tweetnacl` / `@noble/ed25519` | latest | Ed25519 signing, X25519 DH, XSalsa20/ChaCha20 |
| WebSocket | `ws` | latest | Both client (personal node) and server (relay) |
| Local DB | `better-sqlite3` | latest | Synchronous SQLite with encryption via sqlcipher |
| DID | `did-key` / custom | — | did:key method, ed25519 keys |
| CLI | `commander` or `yargs` | latest | CLI argument parsing |
| Tokenizer | `@xenova/transformers` | latest | Alternative: use this for full embedding pipeline instead of raw ONNX |

### Wire Protocol

All messages are JSON over WebSocket, with a common envelope:

```typescript
interface Message {
  type: string           // message type
  from: string           // DID of sender
  timestamp: number      // unix ms
  signature: string      // ed25519 signature of JSON.stringify({type, from, timestamp, payload})
  payload: object        // type-specific content
}
```

#### Message Types (Node → Relay)

```typescript
// Publish an embedding
{ type: "publish", payload: {
  itemId: string,          // UUID
  vector: number[],        // 768-dim perturbed embedding
  itemType: "need" | "offer",
  ttl: number              // seconds until expiry (default: 604800 = 7 days)
}}

// Live search
{ type: "search", payload: {
  vector: number[],        // 768-dim perturbed query embedding
  k: number,               // max results (default: 5)
  threshold: number        // min similarity (default: 0.72)
}}

// Accept a match (consent signal, encrypted for partner)
{ type: "consent", payload: {
  matchId: string,
  accept: boolean,
  encryptedForPartner: string  // box-encrypted with partner's public key
}}

// Withdraw a published embedding
{ type: "withdraw", payload: {
  itemId: string
}}
```

#### Message Types (Relay → Node)

```typescript
// Match notification
{ type: "match", payload: {
  matchId: string,
  partnerDID: string,
  similarity: number,
  yourItemId: string,
  partnerItemType: "need" | "offer",
  expiry: number           // unix ms
}}

// Search results
{ type: "search_results", payload: {
  results: Array<{
    did: string,
    similarity: number,
    itemType: "need" | "offer"
  }>
}}

// Forwarded consent from partner
{ type: "consent_forward", payload: {
  matchId: string,
  fromDID: string,
  encrypted: string        // box-encrypted, only recipient can decrypt
}}

// Acknowledgments and errors
{ type: "ack", payload: { ref: string, status: "ok" | "error", message?: string }}
```

#### Direct Channel Messages (Node ↔ Node, over encrypted TCP)

```typescript
// After encrypted channel is established, messages are plaintext JSON inside the encrypted stream

{ type: "confirm_embedding", payload: { vector: number[] }}  // true embedding
{ type: "confirm_result", payload: { similarity: number, confirmed: boolean }}
{ type: "disclosure", payload: { text: string, level: "category" | "detail" | "contact" }}
{ type: "accept", payload: { message?: string }}
{ type: "reject", payload: { reason?: string }}
{ type: "close", payload: {} }
```

---

## Project Structure

```
resonance/
├── packages/
│   ├── core/                  # Shared types, crypto utils, wire protocol
│   │   ├── src/
│   │   │   ├── types.ts       # Message types, data models
│   │   │   ├── crypto.ts      # DID, signing, encryption, DH
│   │   │   ├── perturbation.ts # Differential privacy noise
│   │   │   └── protocol.ts    # Message serialization/validation
│   │   └── package.json
│   │
│   ├── node/                  # Personal node
│   │   ├── src/
│   │   │   ├── index.ts       # CLI entry point
│   │   │   ├── store.ts       # SQLite local data store
│   │   │   ├── embeddings.ts  # ONNX model loading + inference
│   │   │   ├── identity.ts    # DID key management
│   │   │   ├── relay-client.ts # WebSocket client to relay
│   │   │   ├── channel.ts     # Direct channel manager
│   │   │   └── api.ts         # Optional localhost REST API
│   │   └── package.json
│   │
│   └── relay/                 # Relay server
│       ├── src/
│       │   ├── index.ts       # Server entry point
│       │   ├── hnsw.ts        # HNSW index wrapper (insert, search, persist)
│       │   ├── matcher.ts     # On-insert matching logic
│       │   ├── server.ts      # WebSocket server + auth
│       │   └── admin.ts       # Health check, stats API
│       └── package.json
│
├── scripts/
│   ├── dev-cluster.sh         # Spin up 1 relay + 3 nodes locally for testing
│   └── benchmark-privacy.sh   # Test recall vs. epsilon tradeoff
│
├── package.json               # Monorepo root (npm workspaces)
├── tsconfig.json
└── README.md
```

---

## Success Metrics

### Leading Indicators (validate during development)

| Metric | Target | How to Measure |
|---|---|---|
| Embedding latency | <100ms on CPU | Benchmark script on M1 Mac and Intel i7 |
| Relay search latency | <5ms at 100K vectors | Load test with synthetic embeddings |
| Match recall at ε=1.0 | >75% | Compare matches with vs. without perturbation on test dataset |
| Match recall at ε=5.0 | >90% | Same benchmark, low privacy mode |
| False positive rate | <20% at ε=1.0 | Matches that fail confirmation (true similarity < 0.70) |
| End-to-end latency (publish → notification) | <2s | Timed test with 2 nodes and 1 relay |
| Node bootstrap time | <30s (excluding model download) | Time from `resonance init` to ready |

### Lagging Indicators (validate during pilot)

| Metric | Target | How to Measure |
|---|---|---|
| Matches that lead to confirmed channels | >50% | Ratio of match notifications to confirmed direct channels |
| User-reported match quality | >3.5/5 | Post-match survey in CLI |
| Pilot participants retained after 2 weeks | >60% | Active nodes count |
| Distinct use cases tested | ≥3 (skills, housing, services) | User-submitted categories |

---

## Open Questions

| # | Question | Owner | Impact |
|---|---|---|---|
| **OQ-1** | What is the empirical recall at ε=1.0 with Nomic-embed-text on real-world text (not just benchmarks)? | Engineering | If recall is <60%, we may need to adjust the default ε or the matching threshold |
| **OQ-2** | Should the relay support multiple embedding model families from day one, or force all pilot users onto Nomic? | Engineering | Single model simplifies relay massively. Multi-model requires projection layers or separate indexes. |
| **OQ-3** | How do we handle NAT in the pilot without STUN/TURN? Require port forwarding? Use relay as fallback forwarder? | Engineering | If most users can't establish direct connections, the direct channel feature is unusable for them |
| **OQ-4** | Should we use `@xenova/transformers` (full pipeline, easier API) or raw `onnxruntime-node` (lighter, more control)? | Engineering | Transformers.js is ~200MB installed but handles tokenization automatically. ONNX runtime is lighter but needs manual tokenizer. |
| **OQ-5** | First pilot community: Barcelona tech workers (Marcos's network) or broader Southern Europe? | Product | Affects language model choice (English-only vs. multilingual) and use case focus |
| **OQ-6** | What happens when a user's device is offline when a match notification arrives? Queue on relay? TTL? | Engineering | Relay needs a notification queue per DID with configurable retention (default: 7 days). Adds state to relay. |

---

## Timeline and Phasing

### Phase 1: Core Libraries (Week 1-2)

- `core/` package: types, crypto (DID, signing, encryption), perturbation engine, wire protocol
- Unit tests for all crypto operations and perturbation math
- **Milestone:** `npm test` passes in core package. Perturbation produces statistically valid noise.

### Phase 2: Embedding Engine + Local Store (Week 2-3)

- Model download and caching
- ONNX inference pipeline (tokenize → infer → normalize)
- SQLite encrypted store with schema
- **Milestone:** `resonance init` works. `resonance publish "text"` creates and stores embedding locally.

### Phase 3: Relay Server (Week 3-4)

- WebSocket server with DID auth
- HNSW index (insert, search, persist)
- Matching engine (on-insert search + notification)
- Admin API (/health, /stats)
- **Milestone:** Relay running. Can insert embeddings via WebSocket and get match notifications.

### Phase 4: Integration + Direct Channel (Week 4-5)

- Relay client in personal node connects to relay
- Full publish → match → notify flow
- Direct channel: consent handshake, key exchange, encrypted TCP, match confirmation
- Structured exchange messages
- **Milestone:** Two nodes find each other through the relay, open a direct channel, confirm the match, exchange a disclosure message.

### Phase 5: CLI Polish + Dev Tools (Week 5-6)

- Complete CLI (all 7 commands)
- `dev-cluster.sh` script for local testing
- Privacy benchmark script (recall vs. epsilon)
- Logging, error handling, graceful shutdown
- **Milestone:** A non-developer can run the pilot by following the README.

---

## Dependencies and Constraints

- **Node.js ≥ 20** (for native WebSocket, crypto, and ESM support)
- **ONNX Runtime** must support the target embedding model's ops
- **No cloud services** — everything runs on user hardware or self-hosted VPS
- **License:** All dependencies must be MIT/Apache-2.0/ISC compatible. No GPL in the dependency tree (to allow future licensing flexibility).
- **Platform support:** Linux and macOS for pilot. Windows support is nice-to-have.

---

## How to Use This Document with Claude Code

This PRD is structured as a direct input for Claude Code. The recommended approach:

1. **Start with Phase 1** — tell Claude Code to implement the `core/` package following the types, crypto, and perturbation specs above.
2. **Phase 2** — implement `node/` embedding engine and store module.
3. **Phase 3** — implement `relay/` server.
4. **Phase 4** — wire everything together.
5. **Phase 5** — CLI and dev tools.

For each phase, point Claude Code at the relevant Requirements section (P0-DS, P0-EM, etc.) and the Wire Protocol section. The acceptance criteria are written to be directly testable.

The project structure section defines the file layout. The technical decisions section specifies exact libraries to use. The wire protocol section defines exact message formats. Together, these three sections give Claude Code everything it needs to generate working code without ambiguity.
