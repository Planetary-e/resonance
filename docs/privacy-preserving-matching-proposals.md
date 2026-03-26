# Privacy-Preserving Matching: Alternative Approaches

**Date**: 2026-03-26
**Context**: Resonance currently uses differential privacy (Laplace perturbation) to protect embeddings sent to the relay. This introduces a fundamental trade-off: privacy degrades similarity signal, reducing match quality. This document evaluates alternative approaches that preserve similarity properties while keeping the relay blind to the actual vectors.

**Related**: [Security Audit Report](security-audit-2026-03-26.md) — VULN-02 (search sends unperturbed embeddings)

---

## Problem Statement

Resonance's privacy model relies on perturbing embedding vectors with calibrated Laplace noise before sending them to the relay. This protects user intent from the relay operator but degrades matching precision:

| Privacy Level | Epsilon | Expected Cosine Similarity to Original |
|--------------|---------|----------------------------------------|
| Low | 5.0 | ~0.99 (minimal protection) |
| Medium | 1.0 | ~0.88 (moderate noise) |
| High | 0.1 | ~0.18 (heavy noise, poor matching) |

At meaningful privacy levels, the noise is significant. Worse, the search function currently bypasses perturbation entirely (VULN-02), because perturbed queries produce too many false negatives.

The question: **can we protect embeddings without destroying their similarity properties?**

Embeddings are one-way functions — there is no mathematical inverse. But they are not opaque. An attacker with access to the same public model (Nomic-embed-text) can probe embeddings via nearest-neighbor search against candidate phrases, or use embedding inversion models (e.g., Vec2Text) to recover approximate text. The perturbation layer exists to defend against these attacks.

---

## Proposal 1: Locality-Sensitive Hashing (LSH)

### Overview

Convert embedding vectors into compact binary hash codes using random hyperplane projections. Similar embeddings produce similar hashes with high probability. The relay indexes and searches over hashes — never seeing the original vectors.

### How It Works

1. Generate a random projection matrix `R` of shape `(h, 768)` where `h` is the hash length (e.g., 256 bits)
2. For each embedding vector `v`, compute: `hash = sign(R * v)` — each bit is 1 if the dot product with that hyperplane is positive, 0 otherwise
3. Send only the binary hash to the relay
4. The relay compares hashes using Hamming distance, which correlates with cosine similarity

```
embedding (768 floats, ~3 KB) → LSH hash (256 bits, 32 bytes)
```

### Privacy Properties

- The relay sees a 256-bit hash, not a 768-dimensional float vector
- The random projection irreversibly discards information — inverting an LSH hash is significantly harder than inverting a raw embedding
- The projection matrix `R` can be public (security comes from the information loss) or kept secret for additional protection
- Unlike perturbation, the hash is deterministic — the same input always produces the same hash, so repeated queries don't leak additional information

### Similarity Preservation

- The probability that two vectors share a hash bit equals `1 - arccos(cos_sim) / pi`
- For vectors with 0.85 cosine similarity: ~82% of bits match
- For vectors with 0.50 cosine similarity: ~67% of bits match
- Approximate nearest neighbor search over Hamming distance is well-studied and fast (bit operations)

### Trade-offs

| Advantage | Disadvantage |
|-----------|--------------|
| No privacy/utility trade-off knob to tune | Less precise than raw vector similarity |
| Relay never sees vectors | Requires replacing HNSW with Hamming-based index |
| Compact representation (32 bytes vs ~3 KB) | Precision depends on hash length `h` |
| Fast comparison (XOR + popcount) | Random projection matrix must be shared across all nodes |
| Deterministic — no information leak from repeated queries | Cannot use existing HNSW library directly |

### Fit for Resonance

**High**. LSH is the lowest-effort change that eliminates the perturbation trade-off. The confirmation step (true embedding exchange peer-to-peer in the E2E encrypted channel) already compensates for imprecise relay-side matching. LSH handles coarse discovery; the channel handles precise confirmation.

### Implementation Sketch

1. Generate a shared projection matrix `R` (distributed with the client, or derived from a public seed)
2. In `packages/core`, add an `lsh.ts` module: `hashEmbedding(vector, R) → Uint8Array`
3. Replace `perturbVector()` calls with `hashEmbedding()` before sending to relay
4. In `packages/relay`, replace HNSW with a Hamming distance index (e.g., multi-index hashing or a simple brute-force scan for the pilot)
5. Search queries also send hashes — solving VULN-02 without perturbation

---

## Proposal 2: Trusted Execution Environments (TEE)

### Overview

Run the relay's matching engine inside a hardware-protected enclave (Intel TDX, AWS Nitro Enclaves, ARM CCA). Vectors are encrypted in transit and at rest, decrypted only inside the enclave's protected memory. The relay operator cannot inspect the data, even with root access.

### How It Works

1. The relay runs inside a TEE (e.g., AWS Nitro Enclave)
2. The enclave generates an attestation document proving its code and configuration
3. Clients verify the attestation before sending data — confirming the relay runs unmodified Resonance code
4. Vectors are sent encrypted (TLS to the enclave, not to the host)
5. Inside the enclave, HNSW runs on plaintext vectors — **full precision matching**
6. Results are encrypted before leaving the enclave

### Privacy Properties

- The relay operator sees only encrypted traffic — cannot inspect enclave memory
- Hardware-enforced isolation: even the host OS kernel cannot read enclave memory
- Attestation provides cryptographic proof of what code is running
- Eliminates the need for perturbation, LSH, or any other degradation of the vectors

### Similarity Preservation

**Perfect**. The matching algorithm operates on original vectors inside the enclave. No noise, no hashing, no information loss.

### Trade-offs

| Advantage | Disadvantage |
|-----------|--------------|
| Full matching precision — no privacy/utility trade-off | Requires specific hardware (Intel TDX, AMD SEV, ARM CCA, AWS Nitro) |
| Existing HNSW index works unmodified | Trust shifts to hardware manufacturer (Intel, AMD, AWS) |
| Strongest privacy guarantee against relay operator | Side-channel attacks against TEEs are an active research area |
| Attestation proves relay integrity | Adds deployment complexity and cost |
| Industry-proven (Signal uses SGX for contact discovery) | Not available on all hosting platforms |

### Fit for Resonance

**High for production deployment**. TEEs are the gold standard for this use case — Signal uses them for private contact discovery for the same reason. The matching algorithm needs zero changes. The cost is operational: the relay must run on TEE-capable hardware, and clients must verify attestation documents.

### Implementation Sketch

1. Package the relay as an enclave application (e.g., AWS Nitro Enclave image)
2. Add attestation verification to the client (`packages/node/src/relay-client.ts`)
3. Establish an encrypted channel directly to the enclave (not the host)
4. Remove perturbation from the publish flow — vectors can be sent in full
5. Document the attestation verification process and trust assumptions

---

## Proposal 3: Functional Encryption (Inner Product)

### Overview

A cryptographic primitive where the relay can compute the inner product (cosine similarity) of two encrypted vectors and obtain **only the scalar result** — not the vectors themselves. A trusted authority issues function-specific decryption keys.

### How It Works

1. A setup authority generates a master secret key and public parameters
2. Users encrypt their vectors using the public parameters
3. The authority issues a "functional decryption key" for the inner product function
4. The relay uses this key to compute `decrypt(enc_A, enc_B) → dot_product(A, B)` without learning A or B
5. The relay learns similarity scores (needed for ranking) but not the underlying vectors

### Privacy Properties

- Vectors are never exposed to the relay in any form
- The relay learns only pairwise similarity scores — enough to rank matches but not enough to reconstruct vectors
- Similarity scores do leak some information (the relay knows how similar two users are)
- Based on well-studied cryptographic assumptions (DDH, LWE depending on scheme)

### Similarity Preservation

**Perfect**. The inner product is computed exactly, not approximated.

### Trade-offs

| Advantage | Disadvantage |
|-----------|--------------|
| Exact similarity computation | Requires a trusted key authority (setup phase) |
| Vectors never leave user's device in usable form | Relatively new cryptographic primitive — fewer battle-tested libraries |
| Mathematically provable security | Leaks pairwise similarity scores to relay |
| No hardware requirements | Key authority is a single point of trust/failure |
| | Performance overhead (moderate — better than HE, worse than plaintext) |

### Fit for Resonance

**Medium**. The trusted authority requirement introduces a centralization point that conflicts with Resonance's decentralized philosophy. However, the authority could be implemented as a threshold scheme across multiple parties. Libraries exist (CiFEr, GoFE) but are not as mature as NaCl/libsodium.

### Implementation Sketch

1. Evaluate CiFEr (C) or GoFE (Go) libraries for inner-product functional encryption
2. Implement a setup ceremony that generates master keys (could be a one-time bootstrap step)
3. In `packages/core`, add `fe.ts` module: `encryptVector(vector, publicParams) → ciphertext`
4. In `packages/relay`, replace HNSW similarity computation with functional decryption
5. Consider threshold key generation to avoid single-point trust

---

## Proposal 4: Homomorphic Encryption (HE)

### Overview

Compute similarity directly on encrypted vectors without decrypting. The relay performs all matching operations on ciphertext. Only the user can decrypt results.

### How It Works

1. Users encrypt their embedding vectors with an HE scheme (e.g., BFV, CKKS)
2. Encrypted vectors are sent to the relay
3. The relay computes encrypted dot products: `HE_dot(enc_A, enc_B) → enc_similarity`
4. The encrypted similarity score is returned to the user, who decrypts it locally

### Privacy Properties

- Strongest theoretical guarantee: the relay computes on encrypted data and learns nothing
- No information leakage — not even similarity scores
- Based on well-studied lattice-based cryptographic assumptions

### Similarity Preservation

**Perfect**. The computation is exact (within CKKS approximation bounds, which are configurable to arbitrary precision).

### Trade-offs

| Advantage | Disadvantage |
|-----------|--------------|
| Strongest privacy — relay learns absolutely nothing | Extremely slow — orders of magnitude overhead |
| No trusted third party needed | Encrypted vectors are very large (MB per vector vs KB for plaintext) |
| Mathematically provable security | HNSW index operations impractical on encrypted data |
| No hardware requirements | Complex implementation, easy to get wrong |
| | Requires homomorphic-friendly index structure (not HNSW) |

### Fit for Resonance

**Low for current scale, future potential**. HE is theoretically ideal but practically too slow for interactive nearest-neighbor search on 768-dimensional vectors. A single encrypted dot product can take 10-100ms, and HNSW requires thousands of comparisons per query. This may become viable as HE libraries mature and hardware accelerators emerge, but it is not practical for the pilot phase.

### Implementation Sketch

1. Evaluate SEAL (Microsoft), OpenFHE, or TFHE libraries
2. Use CKKS scheme for approximate arithmetic on real numbers
3. Replace vector storage with encrypted ciphertext (significant size increase)
4. Implement brute-force or tree-based search over encrypted vectors (HNSW is incompatible)
5. Benchmark: can a search over 10K encrypted 768-dim vectors complete in < 5 seconds?

---

## Proposal 5: Multi-Relay Secret Sharing

### Overview

Split each embedding vector into additive shares distributed across 2-3 non-colluding relay servers. No single relay can reconstruct the original vector. Similarity is computed collaboratively using secure multi-party computation (MPC) protocols.

### How It Works

1. User splits vector `v` into shares: `v = s1 + s2 + s3`
2. Each share is sent to a different relay server
3. To compute similarity: relays exchange intermediate values using an MPC protocol (e.g., SPDZ, ABY)
4. The final similarity score is reconstructed without any relay learning the full vectors

### Privacy Properties

- No single relay sees the original vector or can reconstruct it
- Security holds as long as relays don't collude (e.g., 2-of-3 honest majority)
- Well-studied theoretical foundations (Shamir's secret sharing, Beaver triples)

### Similarity Preservation

**Perfect**. MPC computes exact similarity — no approximation.

### Trade-offs

| Advantage | Disadvantage |
|-----------|--------------|
| No single point of trust | Requires multiple independent relay operators |
| Exact computation | Communication overhead between relays |
| Well-studied cryptographic foundations | Latency increases (network round trips between relays) |
| No special hardware needed | Collusion breaks the model entirely |
| | Operationally complex — who runs the other relays? |

### Fit for Resonance

**Medium-long term**. Resonance's architecture currently assumes a single relay. Multi-relay MPC is theoretically elegant but requires a federation of independent operators. This aligns with Resonance's long-term decentralization vision but is premature for the pilot.

### Implementation Sketch

1. Define a relay federation protocol (discovery, trust establishment)
2. Implement Shamir or additive secret sharing in `packages/core`
3. Add MPC protocol for inner product computation between relay pairs
4. Modify `packages/node` to split vectors and communicate with multiple relays
5. Define trust model: how many relays must be honest? Who operates them?

---

## Comparison Matrix

| Property | Perturbation (current) | LSH | TEE | Functional Encryption | Homomorphic Encryption | Multi-Relay MPC |
|----------|----------------------|-----|-----|----------------------|----------------------|-----------------|
| **Similarity preserved** | Degraded (epsilon-dependent) | Approximate | Exact | Exact | Exact | Exact |
| **Relay learns** | Noisy vector | Hash only | Nothing (hardware enforced) | Similarity scores only | Nothing | Nothing (if no collusion) |
| **Implementation effort** | Already done | Low | Medium | Medium-High | High | High |
| **Performance overhead** | None | Low (faster than current) | None | Moderate | Very high | Moderate |
| **Trust assumption** | Honest-but-curious relay | Honest-but-curious relay | Hardware manufacturer | Key authority | None | Non-colluding relays |
| **Special requirements** | None | Shared projection matrix | TEE hardware | FE library | HE library | Multiple relay operators |
| **Maturity** | Well-understood | Well-understood | Production-proven (Signal) | Research-stage | Research-stage | Research-stage |
| **Solves VULN-02** | No (search bypass needed) | Yes | Yes | Yes | Yes | Yes |

---

## Recommendation

A layered approach, implemented incrementally:

### Phase 1 (Pilot) — LSH

Replace perturbation with locality-sensitive hashing. This is the lowest-effort change that:
- Eliminates the privacy/utility trade-off entirely
- Solves VULN-02 (search queries send hashes, not vectors)
- Requires no special hardware or trusted third parties
- Leverages the existing confirmation step for precision recovery

The relay never sees a vector — only a compact binary hash that supports approximate matching but resists inversion. Any precision lost at the hash level is recovered in the E2E encrypted confirmation step, which already exists.

### Phase 2 (Production) — TEE

Deploy the relay inside a trusted execution environment. This provides:
- Defense in depth on top of LSH
- Full precision matching (HNSW can run unmodified inside the enclave)
- Attestation-based trust (clients verify the relay runs genuine Resonance code)
- Industry-proven approach (Signal's private contact discovery uses the same pattern)

### Phase 3 (Federation) — Multi-Relay MPC

As Resonance scales and decentralizes:
- Introduce relay federation with secret sharing
- No single relay (or hardware vendor) becomes a trust bottleneck
- Aligns with the long-term vision of fully decentralized infrastructure

---

*This document accompanies the [Security Audit Report](security-audit-2026-03-26.md) and addresses the architectural root cause behind VULN-02.*
