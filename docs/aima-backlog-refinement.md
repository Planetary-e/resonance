# Aima x Resonance — Backlog Refinement Plan

_Preparation document for engineering team, April 2026_

---

## Context for Engineers

**Aima today:** Layer 0 voice assistant running on-device
- ASR (speech-to-text) -> LLM (simple prompt) -> TTS (text-to-speech)
- Everything runs locally on the user's device
- Single model, single prompt, no specialization
- No network intelligence, no privacy-preserving matching

**What we're introducing:** The Resonance protocol — a privacy-preserving P2P infrastructure that enables Aima to:
1. Match user needs to specialized AI agents across a distributed network
2. Keep private data (RAG, context, conversation history) on-device
3. Fan out complex tasks to multiple specialists in parallel
4. Form capability clusters (groups of specialized nodes working together)
5. All with E2E encryption and no centralized data collection

**The key shift:** Aima goes from "one local model answers everything" to "a local orchestrator that knows when to ask the network for help."

---

## Part 1: Discovery Questions for Engineering Team

### Current Architecture Understanding

These questions map the existing system so we know exactly what we're building on top of.

1. **ASR pipeline**
   - Which ASR model/service are we using? (Whisper local? Cloud API?)
   - What's the current latency from speech-end to text-ready?
   - Is ASR running on-device or does it hit a server?
   - What languages/locales are supported?

2. **LLM layer**
   - Which model is running? (Size, quantization, runtime — ONNX? llama.cpp? MLX?)
   - What's the current inference speed (tokens/sec)?
   - How much RAM/VRAM does it consume?
   - What's the prompt structure? System prompt + user turn only, or is there conversation history?
   - Is there any context window management (sliding window, summarization)?

3. **TTS pipeline**
   - Which TTS model/service? (Local or cloud?)
   - Is it streaming (word-by-word) or batch (wait for full response)?
   - Latency from first token to first audio?

4. **Device constraints**
   - What are the target devices? (Phone, tablet, laptop, all?)
   - Minimum RAM/storage we can assume?
   - Is there GPU/NPU access on target devices?
   - Battery impact of current pipeline?

5. **Data & state**
   - Is conversation history persisted between sessions?
   - Is there any user profile or personalization?
   - Where is data stored today? (SQLite? Files? Memory only?)
   - Is anything encrypted?

6. **Infrastructure**
   - Is there any backend/server today, or is it 100% on-device?
   - How are updates deployed? (App store? OTA?)
   - What's the tech stack? (React Native? Swift? Kotlin? Flutter? Tauri?)

### Capacity & Constraints

7. **Team**
   - How many engineers will work on this?
   - Familiarity with: WebSockets, P2P protocols, cryptography, ONNX/ML runtimes?
   - Current sprint cadence? (1 week? 2 weeks?)

8. **Timeline**
   - When is the next release planned?
   - Are there hard deadlines (investor demo, launch date, partnership)?
   - Can we ship incrementally or does it need to be a big-bang release?

9. **Risk tolerance**
   - Can we ship experimental features behind a flag?
   - Is there a staging/beta user group?
   - What's the rollback strategy if something breaks?

---

## Part 2: Architecture Transition Plan

### Phase 0: Current State (Aima today)

```
User speaks
  -> ASR (on-device)
  -> LLM (on-device, single prompt)
  -> TTS (on-device)
  -> User hears response
```

**Capability:** Answers any question, but with a single small model. No specialization, no external knowledge, no network intelligence.

---

### Phase 1: Identity & Local Store (Week 1-2)

**Goal:** Give Aima a cryptographic identity and encrypted local storage, without changing the user-facing experience.

**What changes:**
- Generate Ed25519 DID on first launch (invisible to user)
- Add encrypted SQLite store for conversation history, preferences, user context
- Add Argon2id password/biometric derivation for encryption key

**What doesn't change:**
- Voice pipeline stays identical (ASR -> LLM -> TTS)
- User sees no difference
- No network connections yet

**Engineering tasks:**
```
[ ] Integrate @resonance/core (DID generation, crypto primitives)
[ ] Integrate @resonance/node (encrypted store)
[ ] First-launch: generate identity, derive store key from device auth
[ ] Migrate any existing local state to encrypted store
[ ] Add conversation history persistence (encrypted)
[ ] Unit tests for identity + store
```

**Why first:** This is the foundation everything else builds on. Zero risk — purely additive, no behavior changes.

---

### Phase 2: Context-Aware Orchestrator (Week 3-4)

**Goal:** Replace the single LLM prompt with an orchestrator that classifies intent and routes to the right handler.

**What changes:**
- Local LLM gets a richer system prompt with routing logic
- Orchestrator classifies: "Can I handle this locally, or should I ask the network?"
- For now, everything stays local (network comes in Phase 3)
- But the routing infrastructure is in place

**Architecture:**
```
User speaks
  -> ASR
  -> Orchestrator (local LLM)
     |
     +-> "Simple question" -> Answer locally (as today)
     +-> "Needs specialization" -> [placeholder: answer locally with caveat]
     +-> "Needs external data" -> [placeholder: answer locally with caveat]
  -> TTS
```

**Engineering tasks:**
```
[ ] Design intent taxonomy (what categories of requests exist?)
[ ] Build orchestrator prompt that classifies intent
[ ] Add capability registry (what can this device do locally?)
[ ] Route "simple" queries to local model (no change from today)
[ ] Route "complex" queries to local model with "I'd give a better answer
    if I could consult specialists" awareness
[ ] Conversation context injection (use stored history for better answers)
[ ] Eval: compare answer quality before/after orchestrator
```

**Why second:** This separates "understanding what's needed" from "executing it." The network layer plugs into the routing slots.

---

### Phase 3: Relay Connection (Week 5-6)

**Goal:** Connect Aima to the Resonance relay network. Publish capabilities, discover other nodes.

**What changes:**
- Aima connects to a bootstrap relay on startup
- Publishes its capability profile as an OFFER
- Can discover other nodes' capabilities via the relay
- User sees: "Connected to network" indicator

**Architecture:**
```
User speaks
  -> ASR
  -> Orchestrator
     |
     +-> "Simple" -> Local LLM
     +-> "Needs specialist" -> Search relay for matching capability
         -> If found: open E2E channel, send task, receive result
         -> If not found: local fallback with disclaimer
  -> TTS
```

**Engineering tasks:**
```
[ ] Integrate @resonance/node relay client (WebSocket)
[ ] Configure bootstrap relay URL (hardcoded for pilot, configurable later)
[ ] Publish device capability profile on connect:
    - Model name, size, languages
    - Available tools (calculator, web search, file access)
    - Current capacity (busy/available)
[ ] Implement search flow: embed user query -> search relay -> get matches
[ ] Implement channel flow: open channel to matched node, exchange task+result
[ ] Handle offline gracefully (local-only mode when no relay)
[ ] Add "Connected / Disconnected" status to UI
[ ] Bearer token auth for all API calls (VULN-18 fix already in place)
[ ] Test with two Aima instances on same network
```

**Critical decision point:** What's the bootstrap relay?
- Option A: Planetary hosts a public relay (simplest for pilot)
- Option B: User runs their own relay (most private)
- Option C: Both — public relay as default, configurable

---

### Phase 4: Specialist Agents (Week 7-8)

**Goal:** Enable nodes to advertise specialized capabilities. Aima can delegate tasks to specialists.

**What changes:**
- Nodes can load different models for different tasks
- RAG integration: nodes can have private knowledge bases
- Orchestrator prefers specialists over generic answers

**Use cases unlocked:**
```
User: "What are the side effects of metformin?"
  -> Orchestrator: needs medical knowledge
  -> Relay: finds a node with medical RAG
  -> E2E channel: sends query, receives specialist answer
  -> TTS: speaks the answer (with "According to medical sources..." framing)

User: "Translate this email to Japanese"
  -> Orchestrator: needs translation specialist
  -> Relay: finds a node with Japanese language model
  -> Channel: sends text, receives translation
  -> TTS: speaks confirmation
```

**Engineering tasks:**
```
[ ] Define capability schema (model, specialization, languages, tools, RAG topics)
[ ] Build RAG integration (vector store + document loader)
[ ] Implement task protocol:
    - Task request: { type, payload, constraints }
    - Task result: { output, confidence, sources }
    - Task error: { reason, fallback }
[ ] Add specialist matching (prefer exact capability match over generic)
[ ] Add result confidence scoring (should we trust this answer?)
[ ] Add source attribution ("Based on medical literature" vs "Based on general knowledge")
[ ] Implement timeout + fallback (if specialist doesn't respond in N seconds, answer locally)
[ ] Eval: compare specialist answers vs local-only answers
```

---

### Phase 5: Fan-Out & Synthesis (Week 9-10)

**Goal:** Complex queries get decomposed into parallel subtasks, each handled by the best available node.

**What changes:**
- Orchestrator can break complex queries into parts
- Parts execute in parallel across multiple nodes
- Local model synthesizes results into a coherent response

**Example:**
```
User: "Help me plan a trip to Tokyo next month"
  -> Orchestrator decomposes:
     +-> [Parallel] Weather forecast for Tokyo (weather specialist)
     +-> [Parallel] Flight prices from Barcelona (travel specialist)
     +-> [Parallel] Hotel recommendations (travel specialist)
     +-> [Parallel] Cultural events in May (local knowledge specialist)
  -> All 4 return results in ~3-5 seconds
  -> Local LLM synthesizes into coherent travel plan
  -> TTS speaks the plan
```

**Engineering tasks:**
```
[ ] Task decomposition in orchestrator (when to fan out vs handle locally)
[ ] Parallel channel management (open N channels simultaneously)
[ ] Result aggregation + synthesis prompt
[ ] Timeout handling (don't wait forever for slow nodes)
[ ] Partial results (if 3/4 respond, synthesize with what we have)
[ ] Progress indicator in UI ("Consulting 4 specialists...")
[ ] Eval: end-to-end latency for fan-out queries
```

---

### Phase 6: Capability Clusters (Week 11-12)

**Goal:** Groups of devices form clusters that appear as a single, more capable node on the network.

**What changes:**
- Multiple devices can share a cluster identity
- Tasks route to the best available member
- Private RAG stays on each member's device

**Use case:** A consulting firm has 5 specialists. Their Aima devices form a cluster. When a client asks a complex question, it automatically routes to the right specialist's device.

**Engineering tasks:**
```
[ ] Cluster identity (shared DID that members can sign for)
[ ] Intra-cluster routing (leader receives, delegates to members)
[ ] Availability-aware routing (skip offline members)
[ ] Cluster management UI (invite/remove members)
[ ] Private RAG isolation (each member's knowledge stays local)
[ ] Eval: cluster response quality vs single-node
```

---

## Part 3: Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Network latency adds to voice response time | User waits too long | Local fallback always available; stream results as they arrive |
| No specialists available on network | Query fails | Local model answers with disclaimer; grow network before launch |
| Bad actor publishes false capabilities | Incorrect answers | Reputation system (Phase 8); result verification; confidence scoring |
| Battery drain from relay connection | User experience | Use WebSocket keepalive, not polling; disconnect when app backgrounded |
| Privacy concern from users | Trust | Publish COMPLIANCE.md; in-app privacy indicator; all data encrypted |
| Engineering complexity overwhelms team | Delays | Ship phases independently; each phase is usable on its own |

---

## Part 4: Success Metrics Per Phase

| Phase | Metric | Target |
|-------|--------|--------|
| 1: Identity & Store | Encryption overhead | <5ms per read/write |
| 2: Orchestrator | Intent classification accuracy | >90% on test set |
| 2: Orchestrator | Answer quality improvement | +15% on eval suite |
| 3: Relay | Connection success rate | >95% uptime |
| 3: Relay | Discovery latency | <500ms to find a match |
| 4: Specialists | Specialist vs local answer quality | +30% on domain-specific evals |
| 4: Specialists | E2E task latency | <3 seconds |
| 5: Fan-out | Complex query quality | +40% vs single-model |
| 5: Fan-out | Parallel latency overhead | <1s vs single best specialist |
| 6: Clusters | Cluster response time | <2s average |

---

## Part 5: Backlog Refinement Agenda

### Meeting structure (2 hours)

**Block 1: Context (30 min)**
- Present this document
- Walk through the Planetary AI vision (docs/planetaryai.md)
- Show the working Tauri demo (two nodes matching)
- Q&A on the big picture

**Block 2: Current state discovery (30 min)**
- Go through Part 1 questions with the team
- Map Aima's current architecture on a whiteboard
- Identify integration points and constraints

**Block 3: Phase planning (45 min)**
- Review each phase
- Estimate complexity per task (T-shirt sizing: S/M/L/XL)
- Identify dependencies and blockers
- Assign owners for Phase 1 tasks

**Block 4: Decisions & next steps (15 min)**
- Decide: bootstrap relay strategy (hosted vs self-hosted vs both)
- Decide: which phase to target for next release
- Decide: feature flag strategy for gradual rollout
- Set next sync date

---

## Appendix: Key Technical References

| Document | Location | Purpose |
|----------|----------|---------|
| Resonance architecture | docs/developers/architecture.html | Three-tier system, trust boundaries, data flow |
| Wire protocol | docs/developers/protocol.html | Message types, signatures, channel handshake |
| Security audit | docs/security-audit-2026-03-26.md | 18 vulnerabilities found and fixed |
| Planetary AI vision | docs/planetaryai.md | Distributed intelligence platform roadmap |
| Compliance guide | COMPLIANCE.md | EU regulation responsibilities by role |
| Eval results | docs/developers/eval-results.html | Performance benchmarks and recall metrics |
| Privacy model | docs/privacy.html | Three-layer defense, what each tier sees |

---

_Prepared by: Marcos Cuevas_
_Date: 2026-04-13_
