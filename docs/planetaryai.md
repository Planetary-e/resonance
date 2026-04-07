# Planetary AI — Distributed Intelligence Platform

_Vision document based on architectural analysis of Resonance protocol, March 2026_

---

## Executive Summary

Planetary Resonance already implements the core infrastructure for a **privacy-preserving distributed AI platform**: P2P identity (Ed25519 DID), privacy-preserving matching (LSH hashing), E2E encrypted channels, relay-based discovery, and local-first storage. The transition from "matching people's needs and offers" to "matching AI tasks to capable agents" requires no architectural changes — only application-layer semantics on top of the existing protocol.

---

## Foundation: What Resonance Already Has

| Capability | Current State | AI Platform Use |
|-----------|--------------|-----------------|
| P2P identity (Ed25519 DID) | Working | Agents identify themselves, sign messages |
| Privacy-preserving matching (LSH 512-bit) | Working, 93.3% recall | Match AI tasks to agents with relevant capabilities |
| E2E encrypted channels (X25519 + XSalsa20) | Working | Secure agent-to-agent communication |
| Relay network (peer relay mode) | Working | Task routing, capability discovery |
| Embedding engine (ONNX, 768-dim) | Working, 14ms p95 | Embed task descriptions, agent capability profiles |
| Local-first encrypted storage (SQLite) | Working | Agent memory, task history, model cache |
| Desktop app (Tauri + React) | Working | UI for managing agents, reviewing tasks |

---

## Core Insight

The Resonance protocol is "needs and offers" matching with privacy. Replace "needs" with **AI tasks** and "offers" with **agent capabilities**:

```
Current Resonance:
  User A publishes NEED: "I need a React developer"
  User B publishes OFFER: "I offer React development"
  -> Match at 82% -> Open channel -> Exchange details

Distributed AI Platform:
  Agent A publishes TASK: "Analyze this dataset for anomalies"
  Agent B publishes CAPABILITY: "I run anomaly detection models locally"
  -> Match at 87% -> Open channel -> Agent B processes task, returns results
```

**You don't need to distribute the model. You distribute the tasks.**

---

## Why Distributed MoE Doesn't Work Over the Internet

A Mixture-of-Experts model only activates 2-3 experts per token. In theory, different nodes could host different experts. In practice:

| Approach | Network calls per task | Latency | Verdict |
|----------|----------------------|---------|---------|
| Distributed MoE (per-token routing) | Thousands (per token) | Fatal (100ms x 100 tokens = 10s overhead) | Not viable for real-time |
| Pipeline parallelism (Petals-style) | Hundreds (per layer) | High, chain breaks if node dies | Batch only |
| **Agentic fan-out (task routing)** | **5-10 (per agent)** | **Tolerant (one round-trip)** | **Works** |
| **Small specialized models locally** | **Zero network during inference** | **None** | **Works** |

Datacenter MoE works because interconnects are ~1us. Consumer internet is ~100ms. That's a 100,000x difference. Per-token distribution is physically impossible at consumer latencies.

---

## Patterns That Work

### 1. Fan-Out / Fan-In (Map-Reduce over P2P)

Parallelize across many specialized nodes, then synthesize locally:

```
User: "Analyze this startup's market opportunity"
         |
    Resonance Relay (match task to capable agents)
         |
    +----+----+----+----+
    v    v    v    v    v        Fan-out (parallel, E2E encrypted)
  Node A  B    C    D    E
  Market  IP   Team  Fin  Legal
  size    land- work  mod- risk
  anal.   scape force el   scan
    |    |    |    |    |
    +----+----+----+----+
         |
    Local orchestrator              Fan-in (synthesize)
    "Combine 5 reports into
     investment thesis"
         |
    Final analysis to user
```

Each node runs its own small model independently. The latency is wall-clock parallel: if each agent takes 10 seconds, the whole thing takes ~10 seconds, not 50.

**Best for**: Research, analysis, audits, due diligence

### 2. Pipeline (Sequential Agents)

Agent A drafts -> Agent B reviews -> Agent C formats

**Best for**: Content creation, code generation + review

### 3. Marketplace (Competitive Bidding)

Publish task, multiple agents bid, pick the best/cheapest/fastest.

**Best for**: Commodity tasks (translation, summarization, image generation)

All three patterns work over the Resonance protocol as-is. The relay handles discovery, the channels handle communication, the DID handles identity/reputation.

---

## Capability Clusters: Distributed Expertise with Collective Intelligence

### The Therapist Example

```
Dr. Maria -- Therapist specializing in anxiety + EMDR
+-- Her laptop (Personal Node)
|   +-- Fine-tuned 7B model on EMDR protocols
|   +-- RAG: her clinical notes, research papers, EMDR manual
|   +-- Private: patient context never leaves this device
|   +-- DID: did:key:z6Mk...Maria
|
+-- Her office workstation (Extension Node)
|   +-- Same DID, shared encrypted store
|   +-- Larger model (13B) for complex cases
|   +-- RAG: DSM-5, treatment outcome database
|
+-- Colleague network (Trusted Cluster)
|   +-- Dr. Chen -- CBT specialist, own model + RAG
|   +-- Dr. Okafor -- Trauma specialist, own model + RAG
|   +-- Opted into a shared relay group
|
+-- Published OFFER on relay:
    "Anxiety assessment, EMDR protocol guidance,
     trauma-informed care, Spanish + English"
```

### How it works

```
Patient query: "I'm having panic attacks at work"
         |
   Maria's orchestrator (laptop)
   Decomposes:
   +-- Subtask 1: Symptom assessment  -> runs locally (7B + patient RAG)
   +-- Subtask 2: Protocol selection  -> routes to office workstation (13B + DSM-5 RAG)
   +-- Subtask 3: Workplace strategies -> routes to Dr. Chen (CBT specialist)
         |
   Synthesize: Personalized treatment plan
   combining EMDR + CBT + workplace strategies
```

The patient sees **one therapist**. Behind the scenes, three models on three machines contributed — each with their own specialization and private knowledge base.

### The key privacy guarantee

```
Relay sees:  LSH hash of "anxiety treatment EMDR CBT trauma"
Relay NEVER sees:  patient notes, clinical records, RAG contents

Channel carries:  "patient reports panic attacks at work"
RAG lookup:  happens INSIDE the node, never transmitted
Response:  only the synthesized answer leaves the node
```

The RAG contents are the most sensitive data — and they never leave the device. This is where Resonance's privacy-first architecture pays off massively.

### Cluster Architecture

```
+---------------------------------------------+
|  Capability Cluster: "Anxiety Treatment"     |
|                                              |
|  +----------+  +----------+  +----------+   |
|  | Maria    |  | Chen     |  | Okafor   |   |
|  | EMDR     |  | CBT      |  | Trauma   |   |
|  | 7B+RAG   |  | 7B+RAG   |  | 13B+RAG  |   |
|  | laptop   |  | desktop   |  | server   |   |
|  +----------+  +----------+  +----------+   |
|                                              |
|  Shared: cluster DID, routing rules,         |
|  availability schedule, load balancing       |
|  Private: each node's RAG stays local        |
+---------------------------------------------+
```

### New concepts needed

**1. Cluster identity** — A shared DID that multiple nodes can sign for:

```typescript
interface Cluster {
  clusterDID: string;           // shared identity on the relay
  members: MemberNode[];        // individual DIDs
  routingPolicy: 'round-robin' | 'capability-match' | 'availability';
}

interface MemberNode {
  did: string;
  capabilities: string[];       // what this node specializes in
  availability: Schedule;       // when it's online
  capacity: number;             // concurrent tasks
}
```

**2. Private RAG stays local** — RAG contents never leave the device. Only synthesized answers are transmitted through E2E encrypted channels.

**3. Intra-cluster routing** — Nodes within a cluster coordinate privately via existing E2E channels.

---

## Universal Pattern: Beyond Therapy

| Domain | Cluster | Members | Private RAG |
|--------|---------|---------|-------------|
| Therapy | Anxiety treatment | EMDR, CBT, trauma specialists | Patient notes, clinical protocols |
| Legal | Startup counsel | Corporate, IP, employment lawyers | Case law, client contracts |
| Medicine | Diagnosis | Radiology AI, symptom model, drug interaction | Patient records, imaging |
| Education | Tutor | Math, physics, writing coaches | Student progress, curriculum |
| Engineering | Code review | Security, performance, architecture agents | Codebase, internal docs |
| Finance | Due diligence | Market, legal, financial, technical analysts | Deal flow, proprietary data |

---

## Implementation Roadmap

Building on the existing Resonance roadmap milestones:

### Phase 6: Agent Capabilities (on top of Personal Node)

- Task execution engine (run models, tools, code)
- Capability profile (what models/tools this agent has)
- Resource accounting (GPU time, tokens, storage)
- Local orchestrator for task decomposition

### Phase 7: Task Exchange (on top of Relay)

- Task queue / bidding protocol
- Result verification (did the agent actually do the work?)
- Cluster identity and intra-cluster routing

### Phase 8: Reputation & Trust (existing v0.8 milestone)

- Agent/cluster quality scores
- Track record of completed tasks
- Community-driven trust signals

### Phase 9: Economic Layer (existing v0.9 milestone)

- Payment channels for compute
- Token incentives for relay operators and capable nodes
- SLA negotiation in channels
- Micropayments for task completion

---

## The Flywheel

```
More specialists join -> better cluster coverage
Better coverage -> more tasks matched
More tasks -> reputation data
Reputation -> trust -> users prefer proven clusters
Proven clusters -> economic value
Economic value -> more specialists join
```

---

## Why This Is Hard to Replicate

Most "distributed AI" projects start by building infrastructure (networking, discovery, encryption) and struggle with it for years. Resonance has already built and battle-tested that layer:

- **18 security vulnerabilities found and fixed**
- **92 tests passing, 35 eval metrics validated**
- **93.3% matching recall with privacy guarantees**
- **E2E encryption from day one, not bolted on**
- **Peer relay mode — no centralized infrastructure required**

Adding AI agent semantics on top is a feature sprint, not an architecture change. The matching engine doesn't care whether the embeddings represent "I need a plumber" or "I need GPU inference for Llama 3" — it just finds complementary vectors with privacy guarantees.

---

## Key Architectural Principle

> **The infrastructure doesn't know it's routing AI tasks.**
>
> From the relay's perspective, a therapy cluster publishing an OFFER looks identical to a person offering web development services. The privacy, matching, and channel mechanics are the same. This is by design — the protocol is capability-agnostic, which means it scales to any domain without protocol changes.

---

_Document: Planetary AI Vision_
_Based on: Resonance protocol v0.2.1_
_Date: 2026-03-30_
_Authors: Marcos Cuevas, Claude_
