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
- **Runs on consumer hardware** — Embedding inference in 23ms on CPU. No GPU required. Relay runs on a 10/month VPS.
- **Fully open source** — MIT licensed. No proprietary components, no vendor lock-in, no platform tax.

## Current Status: Phase 1 Complete

The core library and evaluation suite are built and validated. The protocol's fundamental assumptions have been empirically tested.

### What's built

| Package | What it does |
|---------|-------------|
| `packages/core` | Embedding engine, differential privacy perturbation, Ed25519/X25519 crypto, DID identity, wire protocol (14 message types) |
| `packages/relay` | HNSW index wrapper, MatchingIndex (separate indexes for needs vs offers) |
| `packages/eval` | 9 benchmarks, 100 English test pairs, 18 multilingual pairs, console + JSON + markdown reporters |

### Eval results (18/18 pass)

| Metric | Result |
|--------|--------|
| Embedding latency (p95) | **23ms** |
| HNSW search latency (p95) | **1.8ms** |
| Match recall at medium privacy (e=1.0) | **82-86%** |
| False positive rate | **<2%** |
| Same-language ES/CA similarity | **0.650** (on par with English) |
| Cross-language similarity | **0.476** (usable for pilot) |

### What's next

- **Phase 2** — Embedding engine + encrypted local store (SQLite)
- **Phase 3** — Relay server (WebSocket, DID auth, MatchingIndex integration)
- **Phase 4** — Personal node, direct encrypted channels, match confirmation
- **Phase 5** — CLI, dev tools, pilot deployment

## Quick Start

```bash
# Clone and install
git clone https://github.com/Planetary-e/resonance.git
cd resonance
npm install

# Run unit tests (74 tests)
npx vitest run

# Run the eval suite (downloads embedding model on first run, ~137MB)
npm run eval:quick    # Quick mode (~2 min, 10K vectors)
npm run eval          # Full mode (100K vectors)

# Run the smoke test
npx tsx packages/eval/src/smoke.ts
```

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
│   ├── core/                  # Shared types, crypto, perturbation, embedding, protocol
│   │   └── src/
│   │       ├── types.ts       # Protocol constants, shared types
│   │       ├── vectors.ts     # Cosine similarity, normalization
│   │       ├── perturbation.ts # Laplace noise, privacy levels
│   │       ├── embedding.ts   # Nomic-embed-text via @huggingface/transformers
│   │       ├── crypto.ts      # DID identity, Ed25519 signing, X25519 DH, encryption
│   │       ├── protocol.ts    # Wire protocol: 14 message types, signed envelopes
│   │       └── __tests__/     # 74 unit tests
│   │
│   ├── relay/                 # HNSW index wrapper
│   │   └── src/
│   │       ├── hnsw.ts        # HnswIndex + MatchingIndex (complementary pairing)
│   │       └── __tests__/
│   │
│   └── eval/                  # Evaluation suite
│       ├── fixtures/          # Test datasets (English + multilingual)
│       └── src/
│           ├── benchmarks/    # 9 benchmarks
│           ├── reporters/     # Console, JSON, markdown output
│           ├── run.ts         # Main orchestrator
│           └── smoke.ts       # Quick sanity check
│
├── docs/                      # Documentation website
│   ├── index.html             # Landing page
│   ├── how-it-works.html      # 5-step visual flow
│   ├── privacy.html           # Privacy model explanation
│   ├── developers/            # Architecture, protocol, API, eval, contributing
│   └── evals/                 # Auto-generated eval reports (markdown)
│
├── package.json               # Monorepo root (npm workspaces)
└── PRD-resonance-pilot.md     # Full product requirements document
```

## Key Design Decisions

These were validated empirically through the eval suite, not assumed:

1. **Index-only perturbation** — Only published embeddings are perturbed. Ephemeral queries use true embeddings (the relay doesn't store them). Double perturbation reduced recall from 82% to 48%.

2. **Relay threshold: 0.50** — The PRD proposed 0.72, but true need/offer cosine similarity averages 0.634. At 0.72, even unperturbed matches had only 4% recall.

3. **Confirmation threshold: 0.55** — Lowered from 0.70. With average true similarity at 0.634, a 0.70 threshold rejected half of genuine matches.

4. **MatchingIndex** — Two separate HNSW indexes (one for needs, one for offers). Needs only search offers and vice versa. This eliminated 65% same-type noise and brought FPR from 82% to 2%.

5. **Query rewriting** — Strip demand framing ("I need", "Looking for") before embedding. Modest +1.5pp similarity improvement, but free.

6. **doc2query expansion tested and rejected** — Measured +0.1pp improvement, not worth the dependency. The architectural fix (MatchingIndex) was the right answer.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (Node.js 20+, ESM) |
| Embedding | `@huggingface/transformers` (Nomic-embed-text, 768-dim) |
| ANN Index | `hnswlib-node` (M=16, ef=200/100, cosine distance) |
| Crypto | `tweetnacl` (Ed25519, X25519, XSalsa20-Poly1305) |
| Testing | Vitest |
| Monorepo | npm workspaces |

## Contributing

```bash
# Setup
git clone https://github.com/Planetary-e/resonance.git
cd resonance
npm install

# Run tests
npx vitest run              # 74 unit tests
npm run eval:quick          # Eval suite (quick mode)

# Smoke test (verifies embedding + perturbation + HNSW)
npx tsx packages/eval/src/smoke.ts
```

See [docs/developers/contributing.html](docs/developers/contributing.html) for detailed guidelines.

## Documentation

Open `docs/index.html` in a browser for the full documentation site, or browse:

- [How It Works](docs/how-it-works.html) — 5-step visual explanation
- [Privacy Model](docs/privacy.html) — Three layers of privacy protection
- [Architecture](docs/developers/architecture.html) — Three-tier design, data flow, trust boundaries
- [Wire Protocol](docs/developers/protocol.html) — All 14 message types with TypeScript interfaces
- [Core Library API](docs/developers/core-library.html) — Complete API reference
- [Eval Results](docs/developers/eval-results.html) — All 18 benchmark results

## License

MIT — free to use, modify, and distribute. No proprietary components.

## About

Planetary Resonance is part of the [Planetary Project](https://github.com/Planetary-e), building decentralized infrastructure that returns power to people.

Created by Marcos Cuevas. Built in Barcelona.
