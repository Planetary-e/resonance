# Planetary Resonance

**Privacy-preserving decentralized matching. Find who you need. Keep what's yours.**

Planetary Resonance is an open-source protocol that lets people discover each other based on complementary needs and offers — without surrendering their data to a platform.

You describe what you need or offer in natural language. The system embeds it locally on your device, adds calibrated noise for privacy, and sends only the noisy mathematical pattern to the network. When a complementary match is found, both parties open a direct encrypted channel to confirm and exchange details. No corporation sits in the middle reading your data.

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
Privacy layer:    Adds calibrated Laplace noise (differential privacy)
                          |
Network:          Relay indexes the noisy vector, finds complementary matches
                          |
Match found:      Both parties notified, open encrypted direct channel
                          |
You decide:       Confirm match, then progressively share details
```

The relay never sees your text, your name, or your location. It only sees noisy mathematical patterns — enough to find matches, not enough to reconstruct what you wrote.

## Key Properties

- **Private by design** — Raw data never leaves your device. Embeddings are computed locally. Only perturbed vectors reach the network.
- **Complementary matching** — Needs only match offers, never other needs. The system understands intent, not just keywords.
- **No account required** — Your identity is a cryptographic keypair (`did:key`). No email, no phone number, no tracking.
- **Runs on consumer hardware** — Embedding inference in 14ms on CPU. No GPU required. Relay runs on a 10/month VPS.
- **Fully open source** — MIT licensed. No proprietary components, no vendor lock-in, no platform tax.

## Current Status: Pilot Complete

All 5 phases are implemented. The protocol works end-to-end: publish, match, consent, confirm with true embeddings, progressive disclosure.

### Eval results (35/35 pass)

| Metric | Result |
|--------|--------|
| Embedding latency (p95) | **14ms** |
| HNSW search latency (p95) | **1.5ms** |
| Match recall at medium privacy (e=1.0) | **82-86%** |
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

# Run tests (119 tests)
npx vitest run

# Run eval suite (downloads embedding model on first run, ~137MB)
npm run eval:quick
```

### Run the protocol

**Terminal 1 — Start a relay:**
```bash
npx tsx packages/relay/src/main.ts
```

**Terminal 2 — Alice (provider):**
```bash
resonance init --password alice
resonance publish --type offer --password alice "Experienced Python developer available for Django projects"
resonance serve --password alice
```

**Terminal 3 — Bob (seeker):**
```bash
resonance init --password bob
resonance publish --type need --password bob "Looking for a Python developer for our Django backend"
resonance matches --password bob
resonance connect <matchId> --password bob
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
| `resonance search <text>` | Live search across the relay (ephemeral, not indexed) |
| `resonance matches` | List match notifications |
| `resonance connect <matchId>` | Open a direct channel (consent + confirm) |
| `resonance channel <channelId>` | Interactive encrypted session (/disclose, /accept, /reject, /close) |
| `resonance status` | Show node status: DID, items, matches |
| `resonance serve` | Long-running listener for match notifications |

All commands accept `--password <pw>` and `--relay <url>` (default: `ws://localhost:9090`).

## Architecture

```
+---------------+  +---------------+  +---------------+
| Personal      |  | Personal      |  | Personal      |
| Node A        |  | Node B        |  | Node C        |
| (your data)   |  | (your data)   |  | (your data)   |
+-------+-------+  +-------+-------+  +-------+-------+
        | perturbed         | perturbed         |
        | embeddings        | embeddings        |
        v                   v                   v
+-------------------------------------------------+
|              Relay (HNSW Index)                  |
|        Receives embeddings, finds matches,      |
|        sends notifications. Sees NOTHING else.  |
+------------------------+------------------------+
                         | match notification
                         v
                +-----------------+
                | Direct Channel  |
                | A <-> B (E2E)   |
                | Confirm + Share |
                +-----------------+
```

**Three tiers, three trust levels:**

| Tier | Sees | Doesn't see |
|------|------|-------------|
| Personal Node | Everything (your raw text, true embeddings, keys) | Other nodes' data |
| Relay | Perturbed vectors + DIDs | Raw text, true embeddings, channel contents |
| Direct Channel | True embeddings + disclosures (between two parties only) | Other channels |

## Project Structure

```
resonance/
├── packages/
│   ├── core/                  # Crypto, embedding, perturbation, wire protocol
│   ├── relay/                 # WebSocket relay server, HNSW index, matching engine
│   ├── node/                  # Personal node: CLI, local store, relay client, channels
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
6. **Relay-bridged channels** — Direct channel messages forwarded through relay, E2E encrypted with DH-derived shared secret. Avoids NAT traversal complexity for pilot.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (Node.js 20+, ESM) |
| Embedding | `@huggingface/transformers` (Nomic-embed-text, 768-dim) |
| ANN Index | `hnswlib-node` (M=16, ef=200/100, cosine distance) |
| Crypto | `tweetnacl` (Ed25519, X25519, XSalsa20-Poly1305) |
| Local Store | `better-sqlite3` (field-level secretbox encryption) |
| WebSocket | `ws` (relay server + node client) |
| CLI | `commander` |
| Testing | Vitest (119 tests) |
| Monorepo | npm workspaces |

## Contributing

```bash
git clone https://github.com/Planetary-e/resonance.git
cd resonance
npm install
npx vitest run              # 119 tests
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
