# Planetary Resonance

**Privacy-preserving decentralized matching. Find who you need. Keep what's yours.**

Planetary Resonance is an open-source protocol that lets people discover each other based on complementary needs and offers — without surrendering their data to a platform.

You describe what you need or offer in natural language. The system embeds it locally and publishes only a compact locality-sensitive fingerprint under a fresh publication identity. When a complementary match is found, both parties establish a fresh pairwise identity and exchange end-to-end encrypted disclosures through asynchronous mailboxes. No corporation sits in the middle reading your data.

---

## Why

Centralized platforms — LinkedIn, Airbnb, Craigslist, dating apps — extract value from matching people. You surrender what you need, what you offer, where you are, and who you know. The platform monetizes it through ads, algorithmic manipulation, and data brokerage.

There is no way today for two people to discover that they can help each other without a corporation in the middle, reading everything, and taking a cut.

AI will accelerate this unless a distributed alternative exists. Resonance is that alternative.

## How It Works

```
You write:        "I need a plumber in Barcelona who speaks Spanish"
                          |
Your device:      Embeds text into a 768-dim vector (locally, no cloud)
                          |
Privacy layer:    Converts to compact binary hash (locality-sensitive hashing)
                          |
Network:          Relay indexes the binary hash, finds complementary matches
                          |
Match found:      Both parties receive encrypted mailbox notices
                          |
You decide:       Consent, then progressively share encrypted details
```

The relay never sees your text, your name, or your location. It only sees compact binary hashes — enough to find matches, not enough to reconstruct what you wrote.

## Key Properties

- **Private by design** — Raw data never leaves your device. Embeddings are computed locally. Only compact binary hashes reach the network.
- **Complementary matching** — Needs only match offers, never other needs. The system understands intent, not just keywords.
- **No account required** — Publications, searches, and relationships use independent cryptographic identities. No email or phone number is required.
- **Runs on consumer hardware** — Personal nodes and volunteer relays run on ordinary desktop hardware. No GPU is required.
- **Fully open source** — MIT licensed. No proprietary components, no vendor lock-in, no platform tax.

## Current Status: Protocol v2 foundation complete

The v0.1 pilot is complete. The v0.2 branch implements scoped publication identities, one-use search identities, an anonymous admission capability boundary, a hardened relay infrastructure identity independent of the user's root key, relay-signed match operations, an fsynced append-only relay journal, exact per-publication expiry, retained terminal tombstones, encrypted publication and relationship mailboxes, pairwise consent, durable encrypted disclosures, channel close without root-DID relay authentication, and a backed-up local-data upgrade from v0.1. See [the roadmap](ROADMAP.md), [protocol v2 contract](docs/developers/protocol-v2.md), and [v0.1 to v0.2 upgrade guide](docs/developers/v0.1-to-v0.2-upgrade.md).

### Eval results (35/35 pass)

| Metric | Result |
|--------|--------|
| Embedding latency (p95) | **14ms** |
| HNSW search latency (p95) | **1.5ms** |
| Match recall (LSH 512-bit) | **93.3%** |
| False positive rate | **<3%** |
| Match notification latency | **19ms** |
| Consent handshake latency | **16ms** |
| Channel message round-trip | **9.5ms** |
| Store encrypt/decrypt | **34us/op** |

## Quick Start

```bash
# Clone and install
git clone https://github.com/Planetary-e/resonance.git
cd resonance
npm install

# Run tests
npx vitest run

# Run eval suite (downloads embedding model on first run, ~137MB)
npm run eval:quick
```

### Desktop App

Download the desktop app from the [GitHub Releases](https://github.com/Planetary-e/resonance/releases) page. Available for macOS (`.dmg`), Windows (`.msi`), and Linux (`.AppImage`).

Or build from source:
```bash
npm install && cd packages/app && npx tauri build
```

### Run the protocol

**No centralized server needed.** Any user can act as a relay.

**User A — Start the app and enable relay mode:**
```bash
cd packages/app && npx tauri dev
# Starts Vite + Tauri window + backend
# In the app: toggle "Act as Relay" on the dashboard
# Other users can now connect to your relay
```

**User B — Connect and publish:**
```bash
cd packages/app && npx tauri dev
# The app auto-discovers relays via the bootstrap list
# Publish needs/offers, see matches, open channels
```

**Or use the CLI:**
```bash
resonance init --password alice
resonance publish --type offer --password alice "Experienced Python developer available for Django projects"
resonance inbox --password alice
```

Or run the automated demo:
```bash
bash scripts/dev-cluster.sh
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `resonance init` | Create identity, download model, create local database |
| `resonance publish <text>` | Embed text and publish to relay |
| `resonance withdraw <itemId>` | Withdraw a publication with its publication key |
| `resonance upgrade-v2` | Back up and upgrade v0.1 items to fresh v2 publication identities |
| `resonance inbox` | Synchronize encrypted matches, consent, and channel messages |
| `resonance search <text>` | Live search across the relay (ephemeral, not indexed) |
| `resonance matches` | List match notifications |
| `resonance connect <matchId>` | Establish a pairwise channel through encrypted consent |
| `resonance channel <channelId>` | Interactive encrypted session (`/disclose`, `/sync`, `/close`) |
| `resonance status` | Show node status: DID, items, matches |

Networked commands accept `--relay <url>` (default: `ws://localhost:9090`). Commands that unlock local state accept `--password <pw>`.

## Architecture

```
+---------------+  +---------------+  +---------------+
| Personal      |  | Personal      |  | Personal      |
| Node A        |  | Node B        |  | Node C        |
| (your data)   |  | (your data)   |  | (your data)   |
+-------+-------+  +-------+-------+  +-------+-------+
        | signed scoped     | signed scoped     |
        | fingerprints      | fingerprints      |
        v                   v                   v
+-------------------------------------------------+
|             Volunteer Relay (Hamming Index)      |
| Journals signed matches and opaque mailbox data. |
| Never receives a user's root identity or text.   |
+------------------------+------------------------+
                         | encrypted mailbox envelopes
                         v
                +-----------------+
                | Pairwise Channel|
                | A <-> B (E2E)   |
                | Consent + Share |
                +-----------------+
```

The desktop app uses **Tauri** — a system WebView for the UI with a Node.js sidecar for the backend (embedding, relay client, local store). No bundled browser engine; lightweight and native on each platform.

**Three tiers, three trust levels:**

| Tier | Sees | Doesn't see |
|------|------|-------------|
| Personal Node | Everything (your raw text, true embeddings, keys) | Other nodes' data |
| Relay | Fingerprints and scoped publication or relationship identifiers | Root identity, raw text, embeddings, channel contents |
| Pairwise Channel | Disclosures chosen for that relationship | Publications and other relationships |

## Project Structure

```
resonance/
├── packages/
│   ├── core/                  # Crypto, embedding, perturbation, wire protocol
│   ├── relay/                 # WebSocket relay server, HNSW index, matching engine
│   ├── node/                  # Personal node: CLI, local store, relay client, channels
│   ├── app/                   # Tauri desktop app (React + Vite + Node.js sidecar)
│   └── eval/                  # 14 benchmarks, 35 metrics
├── scripts/
│   └── dev-cluster.sh         # Local development cluster
├── docs/                      # Documentation website
└── PRD-resonance-pilot.md     # Full product requirements
```

## Key Design Decisions

Validated empirically through the eval suite:

1. **Index-only perturbation** — Only published embeddings are perturbed. Ephemeral queries use true embeddings. Double perturbation reduced recall from 82% to 48%.
2. **Relay threshold: 0.50** — True need/offer similarity averages 0.634. At the PRD's 0.72, recall was 4%.
3. **Confirmation threshold: 0.55** — Lowered from 0.70. With average true similarity at 0.634, a 0.70 threshold rejected half of genuine matches.
4. **MatchingIndex** — Separate HNSW indexes for needs and offers. Eliminated 65% same-type noise, brought FPR from 82% to 2%.
5. **Query rewriting** — Strip demand framing ("I need", "Looking for") before embedding. +1.5pp similarity improvement.
6. **LSH matching** — Relay sees only 64-byte binary hashes (512-bit LSH), not embedding vectors. Irreversible 96:1 compression. Benchmarked at 93.3% recall.
7. **Relationship mailboxes** — Signed, sequenced channel operations are encrypted with a DH-derived shared secret and delivered as opaque, independently acknowledged envelopes.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (Node.js 20+, ESM) |
| Embedding | `@huggingface/transformers` (Nomic-embed-text, 768-dim) |
| Relay Index | In-memory complementary Hamming index over 512-bit fingerprints |
| Crypto | `tweetnacl` (Ed25519, X25519, XSalsa20-Poly1305) |
| Local Store | `sql.js` SQLite (field-level secretbox encryption) |
| WebSocket | `ws` (relay server + node client) |
| Desktop App | Tauri 2 (system WebView + Node.js sidecar), React, Vite |
| CLI | `commander` |
| Testing | Vitest |
| Monorepo | npm workspaces |

## Contributing

```bash
git clone https://github.com/Planetary-e/resonance.git
cd resonance
npm install
npx vitest run
npm run eval:quick          # Eval suite (35 metrics)
bash scripts/dev-cluster.sh # Demo the full flow
```

See [docs/developers/contributing.html](docs/developers/contributing.html) for guidelines.

## Documentation

Open `docs/index.html` in a browser, or browse:

- [How It Works](docs/how-it-works.html) — Visual explanation
- [Privacy Model](docs/privacy.html) — Three layers of privacy
- [Architecture](docs/developers/architecture.html) — Three-tier design, data flow, trust boundaries
- [Wire Protocol](docs/developers/protocol.html) — All message types with TypeScript interfaces
- [Core Library API](docs/developers/core-library.html) — Complete API reference
- [Eval Results](docs/developers/eval-results.html) — Benchmark results

## License

MIT — free to use, modify, and distribute. No proprietary components.

## About

Planetary Resonance is part of the [Planetary Project](https://github.com/Planetary-e), building decentralized infrastructure that returns power to people.

Created by Marcos Cuevas. Built in Barcelona.
