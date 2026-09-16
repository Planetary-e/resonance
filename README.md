# Planetary Resonance

**Private, decentralized discovery for complementary needs and offers.**

[Latest release](https://github.com/Planetary-e/resonance/releases/latest) · [Roadmap](ROADMAP.md) · [Protocol v2](docs/developers/protocol-v2.md) · [Open issues](https://github.com/Planetary-e/resonance/issues)

Planetary Resonance is an open-source protocol and application for helping people find one another without giving a central platform a permanent record of who they are, what they need, what they can offer, and whom they contact.

A person writes a need or offer in natural language. Their device turns it into a compact matching fingerprint, publishes it under a key created for that one publication, and keeps the original text and root identity local. A relay compares complementary fingerprints. If two publications match, both people can consent to a fresh pairwise relationship and exchange end-to-end encrypted disclosures through asynchronous mailboxes.

Resonance is currently a **research prototype**, not a production network. The protocol v2 privacy and persistence foundation is implemented, along with initial replication across configured volunteer relays. Inventory-based repair, relay-to-relay query forwarding, private transport, and mobile participation remain future milestones.

## The goal

Most discovery systems require a platform to know the participants, their intent, their history, and the outcome of their conversations. Resonance explores a different model:

- **People keep their private data.** Raw text, true embeddings, root keys, and conversation plaintext remain on user-controlled devices.
- **The network matches intent.** Natural-language needs are compared with complementary offers rather than exact keywords.
- **Activity has separate identities.** Publications, searches, relay installations, and accepted relationships use independent cryptographic keys.
- **Infrastructure comes from participants.** The target network uses volunteer devices and remains useful through replication and repair when individual relays disappear.
- **Privacy claims stay measurable.** Threat models, leakage boundaries, tests, and evaluation results live beside the implementation.
- **No account or platform tax is required.** The protocol does not require an email address, phone number, central account, or proprietary service.

The long-term aim is a public protocol that communities can operate for mutual aid, work, services, collaboration, local exchange, and other forms of human coordination without creating another behavioral-data platform.

## How it works

```text
1. Describe a need or offer
        │
        ▼
2. Your device embeds the text locally
        │
        ▼
3. Your device creates a 512-bit LSH fingerprint and a new publication key
        │
        ▼
4. A relay stores the signed publication and compares only compatible
   need/offer fingerprints
        │
        ▼
5. A match becomes a relay-signed operation and two encrypted mailbox notices
        │
        ▼
6. Each person decides whether to establish a new pairwise relationship
        │
        ▼
7. Disclosures and channel-close operations travel as end-to-end encrypted,
   signed, sequenced mailbox messages
```

Publications can be renewed or withdrawn with their own signing keys. Relay state is written to an append-only, fsynced journal before acknowledgement and is replayed after a restart. Searches use a new one-use identity, are never inserted into the index, and return publication identifiers rather than user accounts.

## Privacy and trust boundaries

Protocol v2 removes a stable user identifier from relay-visible application messages. That is an important boundary, but it does not make all network activity anonymous.

| Observer | What it can learn | What the protocol does not send it |
| --- | --- | --- |
| Personal node | The user's text, true embeddings, keys, publications, matches, and chosen disclosures | Other users' private local data |
| Relay | Source network address, timing, message size, group, item type, scoped identifiers, fingerprints, similarity, expiry, and mailbox routing metadata | Root identity, raw text, true embeddings, channel plaintext, or private publication/relationship keys |
| Matched peer | Information deliberately disclosed in that pairwise relationship | Unrelated publications, searches, matches, or relationships |
| Network observer | Endpoints, timing, direction, and message sizes | End-to-end encrypted mailbox contents |

Important limits in the current version:

- Similarity matching necessarily reveals that some fingerprints are close. A compact fingerprint reduces exposed data; it is not a proof that semantic membership cannot be inferred.
- A relay or network observer can still correlate requests by IP address, timing, size, and repeated fingerprints. Two-hop private transport, padding, batching, and route rotation are planned work.
- Current clients use one configured relay at a time. A relay that does not hold a record does **not** yet forward the query to another relay.
- A relay with configured authenticated relay contacts automatically attempts to place each locally submitted publication or tombstone on up to five live eligible volunteer relays. It records positive signed receipts durably and retries pending configured targets after reconnect or restart. Until a record has enough receipts, the local relay may still be its only copy.
- A signed receipt proves a relay fsynced one exact operation at one point in time. It does not prove that the relay is currently online, independently operated, or able to accept more data. Inventory checks, storage quotas, diversity evidence, and graceful handoff remain unfinished.
- A desktop relay contributes only while its relay process is running. Independent background supervision and graceful multi-relay handoff belong to the volunteer-replication milestone.
- The project does not operate a required fleet of permanent servers. The planned availability model depends on several independently operated volunteer devices.

Read the full [protocol v2 threat model](docs/developers/protocol-v2.md) and [roadmap](ROADMAP.md) before relying on Resonance for sensitive activity.

## Project status

| Area | Status |
| --- | --- |
| Protocol v2 scoped publication, search, and relationship identities | Implemented |
| Signed publication revisions, expiry, withdrawal, and terminal tombstones | Implemented |
| Durable relay journal, restart replay, signed matches, encrypted mailboxes | Implemented |
| Pairwise consent, encrypted disclosures, retries, and channel close | Implemented |
| CLI and Tauri desktop flows | Implemented from current source |
| v0.1 local-data backup and upgrade | Implemented |
| Configured-relay placement, signed receipts, persistent repair state, and reconnect retry | Implemented v0.3 foundation |
| Inventory reconciliation, peer diversity, graceful handoff, and query forwarding | Remaining v0.3 work |
| Private two-hop transport and anonymous abuse-control credentials | Planned for v0.4 |
| iOS and Android clients | Planned for v0.5 |

The current validation baseline is:

- **230 automated tests** across core, node, relay, storage, migration, and integration flows
- **44/44 evaluation gates passing**
- **93.3% recall** for the evaluated 512-bit LSH configuration at a 0.7 Hamming-similarity threshold
- **2.3 ms p95** for a 10,000-fingerprint Hamming scan on the recorded evaluation machine
- **42.4 ms** relay publication round trip and **134.1 ms** publication-to-encrypted-match delivery in the recorded run

These are development measurements, not service-level guarantees. See the [latest committed evaluation report](docs/evals/eval-2026-09-16-10-12-37.md) for the dataset, platform, thresholds, informational metrics, and complete results.

## Use Resonance

### Download a desktop build

Installers are published on [GitHub Releases](https://github.com/Planetary-e/resonance/releases). The latest published release currently includes an Apple Silicon macOS DMG, a Windows x64 installer, and Linux Debian/RPM packages.

Packaged releases may lag the protocol on `main`. Read the release notes and use the source workflow below when you want the newest protocol behavior.

The release workflow runs when a version tag is pushed, or when a maintainer starts it manually. Merging source changes into `main` does not immediately replace the downloadable applications.

### Run the current protocol from source

Requirements:

- Node.js 20 or newer
- npm
- Git

Clone, install exactly the locked dependencies, and verify the checkout:

```bash
git clone https://github.com/Planetary-e/resonance.git
cd resonance
npm ci
npm run build
npm test
```

The first embedding test, evaluation, or identity initialization downloads and caches the language model, so the first run takes longer.

### Start a local relay

From the repository root:

```bash
RELAY_HOST=127.0.0.1 \
RELAY_PORT=9090 \
RELAY_DATA_DIR=.resonance/relay \
npm run start --workspace=@resonance/relay
```

The relay writes its infrastructure identity and operation journal under `RELAY_DATA_DIR`. Stop it with `Ctrl+C`; accepted operations are replayed on the next start.

To expose signed v0.3 discovery metadata, set `RELAY_PUBLIC_ENDPOINTS` to the relay's comma-separated public WebSocket endpoints. Use `RELAY_CONTACTS` for configured relay hints and authenticated outbound links; every contacted relay and every descriptor it returns is verified independently. A relay with contacts and no public endpoint advertises itself as `outbound-only`. A local publication or tombstone creates a durable placement intent, selects live configured eligible contacts up to five targets, and records only positive signed fsync receipts. It retries missing configured targets on reconnect and after restart, while retaining prior targets for updates and tombstones. Peer-exchange results are never dialed automatically. See [Relay discovery for v0.3](docs/developers/relay-discovery-v0.3.md) for the protocol, current limits, and trust model.

The current transport is suitable for local development and controlled testing. It is not yet the private, authenticated Internet transport described in the roadmap.

### Use the CLI

Open another terminal in the repository root. Initialize a personal node; omitting `--password` keeps the password out of shell history and prompts for it interactively.

```bash
npm run resonance -- init

# Publish an offer to the local relay
npm run resonance -- publish \
  --type offer \
  --relay ws://127.0.0.1:9090 \
  "Experienced bicycle mechanic available on weekends"

# Search for complementary offers without creating an indexed publication
npm run resonance -- search \
  --type need \
  --relay ws://127.0.0.1:9090 \
  "I need help repairing a bicycle this weekend"

# Fetch encrypted match, consent, and channel mailbox messages
npm run resonance -- inbox --relay ws://127.0.0.1:9090

# Inspect local state
npm run resonance -- status
npm run resonance -- matches
```

A real match requires complementary publications from two personal nodes. To simulate two people on one computer, give each process a different data directory:

```bash
RESONANCE_DATA_DIR=.resonance/alice npm run resonance -- init
RESONANCE_DATA_DIR=.resonance/bob npm run resonance -- init
```

Run subsequent commands with the same `RESONANCE_DATA_DIR` for that participant. After both sides run `inbox`, use the displayed `matchId` and `channelId`:

```bash
RESONANCE_DATA_DIR=.resonance/alice \
  npm run resonance -- connect <matchId> --relay ws://127.0.0.1:9090

RESONANCE_DATA_DIR=.resonance/bob \
  npm run resonance -- inbox --relay ws://127.0.0.1:9090

RESONANCE_DATA_DIR=.resonance/alice \
  npm run resonance -- inbox --relay ws://127.0.0.1:9090

RESONANCE_DATA_DIR=.resonance/alice \
  npm run resonance -- channel <channelId> --relay ws://127.0.0.1:9090
```

Inside a channel, use:

```text
/disclose general <text>
/disclose specific <text>
/disclose identifying <text>
/sync
/status
/close
```

Run `npm run resonance -- --help` or append `--help` to a subcommand for the complete current interface.

### Upgrade v0.1 local data

The upgrade creates a timestamped backup of the encrypted identity and database before opening the old schema. It then gives every active legacy item fresh protocol v2 publication and mailbox keys.

```bash
npm run resonance -- upgrade-v2 --relay ws://127.0.0.1:9090
```

Use `--local-only` to prepare records without contacting a relay. Read the [v0.1 to v0.2 upgrade guide](docs/developers/v0.1-to-v0.2-upgrade.md) before upgrading important local data.

### Run the desktop application from source

Install the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system, including Rust and the required system WebView libraries. Then, from the repository root:

```bash
# The development desktop backend currently expects its relay on port 9091
RELAY_HOST=127.0.0.1 RELAY_PORT=9091 RELAY_DATA_DIR=.resonance/relay \
  npm run start --workspace=@resonance/relay
```

In a second terminal:

```bash
cd packages/app
npx tauri dev
```

The desktop app manages the same personal-node concepts as the CLI and can also start a local relay from the dashboard when its configured relay port is free. Closing the current application stops its supervised backend process.

To create an installer for the current operating system:

```bash
cd packages/app
npx tauri build
```

## CLI reference

| Command | Purpose |
| --- | --- |
| `init` | Create the encrypted root identity, initialize the local database, and prepare the embedding model |
| `publish <text>` | Store a need or offer locally and publish a scoped v2 record |
| `withdraw <itemId>` | Sign and submit a terminal tombstone with the publication key |
| `search <text>` | Run a one-use, non-indexed search for complementary publications |
| `inbox` | Fetch, verify, persist, and acknowledge match, consent, and channel envelopes |
| `matches` | List locally persisted protocol v2 matches |
| `connect <matchId>` | Start the encrypted pairwise-consent exchange for a match |
| `channel <channelId>` | Synchronize and interact with an active pairwise channel |
| `status` | Show local items, matches, channels, identity, and data directory |
| `upgrade-v2` | Back up and migrate legacy local items to unrelated v2 identities |

Networked commands accept `--relay <ws-url>`. Publication and search commands accept `--group <id>` so independently governed communities can keep their matching domains separate.

## Architecture

```text
┌──────────────────────┐                         ┌──────────────────────┐
│ Personal node A      │                         │ Personal node B      │
│                      │                         │                      │
│ raw text + embedding │                         │ raw text + embedding │
│ root and scoped keys │                         │ root and scoped keys │
│ encrypted local DB   │                         │ encrypted local DB   │
└──────────┬───────────┘                         └──────────┬───────────┘
           │ signed publication/search requests            │
           │ 512-bit fingerprints                          │
           ▼                                               ▼
        ┌─────────────────────────────────────────────────────┐
        │ Volunteer relay                                    │
        │                                                     │
        │ Hamming matcher · signed match operations           │
        │ durable journal · encrypted asynchronous mailboxes  │
        └──────────────────────────┬──────────────────────────┘
                                   │ opaque encrypted envelopes
                    ┌──────────────┴──────────────┐
                    │ Fresh pairwise relationship │
                    │ consent · disclosures · close│
                    └─────────────────────────────┘
```

The desktop package contains a personal node and an optional relay role. Their identities, data stores, and lifecycle are separate even when they run on the same device.

## Repository map

```text
packages/
  core/    Cryptography, embeddings, fingerprints, protocol objects, mailboxes
  relay/   WebSocket relay, Hamming index, durable journal, matching and delivery
  node/    CLI, encrypted local store, relay client, migration, pairwise channels
  app/     Tauri desktop shell, React interface, and local Node.js backend
  eval/    Quality, privacy, performance, storage, relay, and channel benchmarks

docs/
  developers/   Protocol, architecture, API, migration, and contribution guides
  evals/        Generated evaluation reports

ROADMAP.md      Sequenced protocol and product milestones
COMPLIANCE.md   Deployment-oriented EU legal and operational notes
```

## Develop and validate changes

From the repository root:

```bash
npm ci
npm run build
npm test
npm run eval:quick
```

Use the quick evaluation whenever a change affects embeddings, fingerprints, thresholds, matching quality, privacy behavior, storage, relay performance, or channel flow. It writes JSON output under `packages/eval/results/` and a Markdown report under `docs/evals/`.

Useful targeted commands:

```bash
npm test --workspace=@resonance/core
npm test --workspace=@resonance/relay
npm test --workspace=@resonance/node
npm run start --workspace=@resonance/relay
```

## Join the community

The project currently collaborates in public through GitHub Issues and pull requests.

- **Ask a question or propose a use case:** [open an issue](https://github.com/Planetary-e/resonance/issues/new) and explain the community, problem, and privacy or availability constraints involved.
- **Report a bug:** include the operating system, Node version, commit or release, exact command, expected behavior, actual behavior, and a minimal log with secrets and personal data removed.
- **Propose a protocol change:** start with an issue. Describe the threat model, relay failure behavior, compatibility impact, and how the change can be evaluated before writing a large implementation.
- **Contribute code or documentation:** choose an open issue, comment that you intend to work on it, create a focused branch, add appropriate tests or evaluation evidence, and open a pull request.
- **Find approachable work:** look for [`good first issue`](https://github.com/Planetary-e/resonance/labels/good%20first%20issue) and [`help wanted`](https://github.com/Planetary-e/resonance/labels/help%20wanted) labels when available.
- **Help with the next network milestone:** relay discovery, multi-relay publication, replica repair, bounded query forwarding, churn testing, and resource controls are the main v0.3 priorities.

Community norms:

- Discuss ideas and evidence, and treat other participants with respect.
- Never post private keys, identity files, real personal data, or unredacted databases.
- Use synthetic fixtures unless participants have explicitly consented to another dataset.
- State privacy and reliability limits plainly. Avoid presenting prototype behavior as a production guarantee.
- Keep pull requests reviewable and include documentation when behavior or trust boundaries change.

See the [contribution guide](docs/developers/contributing.html), [open issues](https://github.com/Planetary-e/resonance/issues), and [roadmap](ROADMAP.md) for more context.

## Documentation

- [Protocol v2 and threat model](docs/developers/protocol-v2.md)
- [Relay discovery for v0.3](docs/developers/relay-discovery-v0.3.md)
- [v0.1 to v0.2 upgrade guide](docs/developers/v0.1-to-v0.2-upgrade.md)
- [Architecture](docs/developers/architecture.html)
- [How Resonance works](docs/how-it-works.html)
- [Privacy model](docs/privacy.html)
- [Use cases](docs/use-cases.html)
- [Evaluation report](docs/evals/eval-2026-09-16-10-12-37.md)
- [Security audit](docs/security-audit-2026-03-26.md)
- [EU compliance notes](COMPLIANCE.md)

Some HTML documentation still describes the v0.1 pilot. The protocol v2 specification, upgrade guide, roadmap, tests, and current source are authoritative where they differ.

## License

[MIT](LICENSE). You may use, study, modify, and distribute the software under the license terms.

## About

Planetary Resonance is part of the [Planetary Project](https://github.com/Planetary-e), an effort to build decentralized infrastructure that returns agency and data control to the people who use it.

Created by Marcos Cuevas in Barcelona and developed in public with its contributors.
