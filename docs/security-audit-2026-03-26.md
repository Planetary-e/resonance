# Resonance Security Audit Report

**Date**: 2026-03-26
**Scope**: Full codebase — `packages/core`, `packages/node`, `packages/relay`, `packages/app`
**Methodology**: Manual source code review with focus on safety, security, and privacy

---

## Executive Summary

Planetary Resonance is a privacy-preserving P2P matching protocol built on Ed25519/X25519 cryptography, differential privacy perturbation, and end-to-end encrypted channels. The codebase demonstrates solid cryptographic engineering — correct use of TweetNaCl primitives, unique random nonces per encryption, field-level store encryption, and comprehensive message signing.

However, this audit identified **16 vulnerabilities** — **3 critical, 4 high, and 9 medium** severity — that undermine the protocol's two core promises:

- **Privacy**: The search function sends unperturbed embeddings to the relay, bypassing the entire differential privacy model (VULN-02).
- **E2E Encryption**: The channel key exchange is unauthenticated, allowing a malicious relay to perform a man-in-the-middle attack and read all channel traffic (VULN-01).

These two findings, combined with a weak password KDF (VULN-03), represent the highest priority remediations before any production deployment.

---

## Findings

### CRITICAL Severity

#### VULN-01: Relay Man-in-the-Middle on Channel Key Exchange

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Category** | Cryptographic Protocol Flaw |
| **CVSS Estimate** | 9.1 |
| **Files** | `packages/node/src/channel.ts:160-166, 208-215` `packages/relay/src/handler.ts:126-148` |

**Description**

The consent handshake transmits ephemeral X25519 public keys as plaintext JSON inside the `encryptedForPartner` field. Despite the field name suggesting encryption, the actual value is:

```typescript
// channel.ts:164-166
encryptedForPartner: JSON.stringify({
  ephemeralPublicKey: encodeBase64(myKP.publicKey),
})
```

No encryption. No signature. No authentication binding the ephemeral key to the sender's DID.

The relay's `handleConsent` function (handler.ts:139-143) receives this value and forwards it verbatim to the partner in a `CONSENT_FORWARD` message. A malicious relay can:

1. Intercept Alice's ephemeral public key from her CONSENT message
2. Generate its own ephemeral keypair
3. Substitute its own public key in the CONSENT_FORWARD to Bob
4. Repeat when Bob responds to Alice
5. Derive shared secrets with **both** parties independently
6. Decrypt, read, and re-encrypt **all** channel messages transparently

This completely breaks the E2E encryption guarantee. The protocol has Ed25519 signing infrastructure (`createMessage`/`verifyMessage` in protocol.ts) and box encryption (`boxEncrypt`/`boxDecrypt` in crypto.ts), but neither is used to protect the key exchange.

**Impact**: Total compromise of channel confidentiality. The relay can read all progressive disclosures, confirm embeddings, accept/reject messages, and contact information exchanged between matched users.

**Root Cause**: No cryptographic authentication of ephemeral keys to the sender's identity. The protocol's honest-but-curious relay assumption is not enforced cryptographically.

**Recommended Fix**:
1. Sign the ephemeral public key with the sender's Ed25519 identity key. Include `matchId` and partner DID in the signed payload to prevent replay/misdirection.
2. Use `boxEncrypt` (already implemented in crypto.ts) to encrypt the consent payload for the partner's public key derived from their DID.
3. On receipt, verify the signature against the sender's DID before accepting the ephemeral key.
4. Consider adopting a Noise protocol handshake (e.g., Noise_XX) for stronger forward secrecy guarantees.

---

#### VULN-02: Search Sends Unperturbed Embeddings to Relay

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Category** | Privacy Model Bypass |
| **CVSS Estimate** | 8.6 |
| **Files** | `packages/app/src/session.ts:189-197` `packages/core/src/types.ts:71` |

**Description**

The `searchRelay()` function embeds the query text and sends the resulting vector directly to the relay without perturbation:

```typescript
// session.ts:193-195
const embedding = await s.engine.embedForMatching(text, type);
const results = await s.relayClient.search({
  vector: Array.from(embedding),  // TRUE embedding — no perturbation
  k: 10,
  threshold: 0.5,
});
```

This is by design — the comment in types.ts:71 states `perturbMode: 'index-only'` — "Only perturb indexed (published) embeddings; queries use true embeddings." However, it fundamentally undermines the privacy model.

Compare with the `publishItem()` function (session.ts:172) which correctly applies differential privacy:

```typescript
// session.ts:172
const { perturbed, epsilon } = perturbWithLevel(embedding, privacy);
```

Every time a user searches, the relay receives an exact semantic representation of their intent. Since users must search to discover matches, this gives the relay access to unperturbed intent vectors for every active user.

**Impact**: The relay can reconstruct user interests with full precision. The differential privacy applied to published items becomes meaningless if the same information is available via search queries.

**Root Cause**: Architectural decision to send raw queries for better search precision, without recognizing this negates the differential privacy applied to published items.

**Recommended Fix**:
1. Apply `perturbWithLevel()` to search queries using the same mechanism as publishing.
2. Accept the reduced search precision — the direct channel confirmation step (true embedding exchange peer-to-peer) provides a compensation mechanism for false negatives from perturbed queries.
3. For stronger guarantees, consider Private Information Retrieval (PIR) techniques or a multi-relay architecture where no single relay sees the full query.

---

#### VULN-03: Weak Password Key Derivation (Raw SHA-512)

| Field | Value |
|-------|-------|
| **Severity** | CRITICAL |
| **Category** | Cryptographic Weakness |
| **CVSS Estimate** | 8.1 |
| **Files** | `packages/core/src/crypto.ts:207-209, 225` `packages/node/src/config.ts:39-41` |

**Description**

Both `exportIdentity` and `deriveStoreKey` derive encryption keys using a single pass of `nacl.hash()` (SHA-512) truncated to 32 bytes:

```typescript
// crypto.ts:208-209
// Derive a key from the password using a simple hash (for pilot; use scrypt/argon2 in production)
const key = nacl.hash(passwordBytes).slice(0, nacl.secretbox.keyLength);

// config.ts:39-41
export function deriveStoreKey(identity: Identity): Uint8Array {
  return nacl.hash(identity.secretKey).slice(0, nacl.secretbox.keyLength);
}
```

For `exportIdentity`:
- **No salt**: Identical passwords produce identical keys, enabling precomputed rainbow table attacks.
- **No iterations**: A single SHA-512 hash can be computed at ~10 billion hashes/second on modern GPUs.
- **No memory cost**: No defense against parallelized attacks.

For `deriveStoreKey`: The input is a 64-byte Ed25519 secret key (high entropy), making brute force impractical. However, the pattern is still poor practice — no domain separation means the same key derivation is used for different purposes.

**Impact**: An attacker who obtains the encrypted `identity.json` file can mount an efficient offline dictionary/brute-force attack against the password. If successful, they gain the user's full Ed25519 identity (DID, signing key, and by extension, store decryption key).

**Root Cause**: Placeholder implementation acknowledged in code comments, not yet upgraded.

**Recommended Fix**:
1. Replace `nacl.hash(password)` with Argon2id: memory cost >= 64 MiB, time cost >= 3 iterations, parallelism = 1.
2. Generate a unique random 16-byte salt, stored alongside the ciphertext in `identity.json`.
3. For `deriveStoreKey`, use HKDF-SHA256 with a domain separation label (e.g., `"resonance-store-key-v1"`) to derive the store key from the identity secret key.

---

### HIGH Severity

#### VULN-04: No Request Body Size Limit (Memory Exhaustion DoS)

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **CVSS Estimate** | 7.5 |
| **File** | `packages/app/src/api.ts:30-38` |

**Description**

The `readBody()` function accumulates incoming request body chunks into a string without any size check:

```typescript
async function readBody(req: Req): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}
```

An attacker can send an arbitrarily large POST body to any API endpoint (`/api/init`, `/api/unlock`, `/api/items`, `/api/search`) to exhaust the Node.js process memory. While the app server binds to `127.0.0.1` (server.ts:138), exploitation is possible through VULN-05 (CORS wildcard) from any website the user visits.

**Recommended Fix**:
1. Add a maximum body size constant (e.g., 1 MiB).
2. Track accumulated size in `readBody()` and destroy the request stream with a 413 status if exceeded.

---

#### VULN-05: CORS Wildcard on All Sensitive API Endpoints

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **CVSS Estimate** | 7.4 |
| **File** | `packages/app/src/api.ts:22, 54-58` |

**Description**

Every API response includes `Access-Control-Allow-Origin: *`:

```typescript
function json(res: Res, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',  // Allows ANY origin
  });
  res.end(JSON.stringify(data));
}
```

The CORS preflight handler (lines 53-61) also returns wildcard origin. This allows any website the user visits to:

- Submit passwords to `/api/unlock` and `/api/init`
- Read all stored items (including decrypted raw text) from `/api/items`
- Read match data and partner DIDs from `/api/matches`
- Initiate channels and perform actions on behalf of the user
- Search the relay using `/api/search`

**Recommended Fix**:
1. Remove the wildcard origin.
2. Restrict to `http://127.0.0.1:<port>` (the local UI origin).
3. Validate the `Origin` header against an allowlist before setting CORS headers.
4. Consider adding CSRF tokens for state-mutating endpoints.

---

#### VULN-06: Unauthenticated WebSocket Event Stream

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **CVSS Estimate** | 7.1 |
| **File** | `packages/app/src/server.ts:131-135` |

**Description**

The WebSocket server at `/api/events` accepts any connection without authentication:

```typescript
wss = new WebSocketServer({ server: httpServer, path: '/api/events' });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});
```

All session events are broadcast to every connected client — match notifications (including partner DIDs and similarity scores), channel readiness, confirmation results, disclosure text, accept/reject messages. WebSocket connections bypass CORS entirely (the Same-Origin Policy does not apply to WebSocket upgrades), so any website can open a `ws://localhost:<port>/api/events` connection.

**Recommended Fix**:
1. Require a session-scoped authentication token on WebSocket connection (via query parameter or initial message).
2. Generate the token on `/api/unlock` and require it for WebSocket subscription.
3. Validate the `Origin` header on upgrade requests as defense-in-depth.

---

#### VULN-07: Unauthenticated Relay Stats Endpoint

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **CVSS Estimate** | 5.3 |
| **File** | `packages/relay/src/server.ts:126-135` |

**Description**

The `/stats` HTTP endpoint returns operational metrics without authentication:

```typescript
if (req.url === '/stats' && req.method === 'GET') {
  const stats = engine.getStats();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    indexed_embeddings: stats.total,
    connected_nodes: clients.size,
    matches_today: stats.matchesToday,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  }));
}
```

The relay listens on `0.0.0.0` (line 65), making this endpoint network-accessible. Exposed metrics aid reconnaissance by revealing network size, activity levels, and server restart patterns.

**Recommended Fix**: Add API key authentication or restrict to an admin-only bind address.

---

### MEDIUM Severity

#### VULN-08: No Session Timeout / Auto-Lock

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `packages/app/src/session.ts` |

Once `unlockSession()` is called (line 134), the session persists in memory indefinitely. The `lockSession()` function (line 160) exists but is never called automatically. The session holds the full Ed25519 secret key, store encryption key, and active relay connection. An unattended device remains fully accessible.

**Fix**: Implement a configurable inactivity timer (default 15-30 min) that calls `lockSession()`. Reset on each API request.

---

#### VULN-09: Fragile Directory Traversal Protection

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `packages/app/src/server.ts:108` |

The static file server sanitizes paths with a blocklist approach:

```typescript
filePath = filePath.replace(/\.\./g, '');
```

While this handles common `../` sequences, it is fragile. Proper defense should verify the resolved path remains within the expected directory.

**Fix**: After constructing `fullPath`, verify `path.resolve(fullPath).startsWith(path.resolve(UI_DIR))` before serving.

---

#### VULN-10: matchRegistry Unbounded Memory Growth

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Files** | `packages/relay/src/server.ts:89` `packages/relay/src/handler.ts:75` |

The `matchRegistry` Map grows without bound — `handlePublish` adds an entry for every match notification, but no code ever removes entries. The `notifiedPairs` Set in `MatchingEngine` (matching-engine.ts) has the same issue. Long-running relays will eventually exhaust memory.

**Fix**: Add TTL-based expiry (aligned with `matchExpiryMs`) and periodic cleanup. Consider an LRU cache with a maximum size.

---

#### VULN-11: DID Reuse Enables Relay-Side Correlation

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Category** | Privacy / Architectural |
| **Files** | `packages/node/src/identity.ts` `packages/relay/src/handler.ts:58-104` |

Each user has a single DID used for all published items, searches, consent exchanges, and channel establishment. The relay can trivially correlate all activity from the same DID, building a complete behavioral profile: what types of items a user publishes, how often they search, who they match with, which matches they consent to.

**Fix**: Consider per-item or per-session ephemeral DIDs. Use blind signatures or group signatures for authorization without identity linkage. At minimum, document the correlation risk in the threat model.

---

#### VULN-12: Relay Identity Ephemeral on Restart

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `packages/relay/src/server.ts:87` |

The relay generates a fresh identity on every startup via `generateIdentity()`. The DID is logged but never persisted. Clients cannot verify relay continuity or detect impersonation.

**Fix**: Persist the relay identity to disk. Allow clients to pin the relay's DID and warn if it changes.

---

#### VULN-13: No Rate Limiting on Authentication Attempts

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `packages/relay/src/server.ts:174-216` |

The AUTH handler validates timestamp freshness but does not limit authentication attempt rates. The existing `RateLimiter` only covers `publish` and `search` actions.

**Fix**: Add IP-based rate limiting for WebSocket connection attempts. Implement exponential backoff after repeated failed connections.

---

#### VULN-14: Sensitive Data Leakage in Error Responses

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `packages/app/src/api.ts:89, 139, 177, 200, 231` |

Several error handlers pass `String(err)` directly to the client (e.g., `error(res, String(err), 500)`). JavaScript error objects may include stack traces, file paths, and internal state descriptions. Line 103 correctly uses a generic message, but other paths do not.

**Fix**: Return generic error messages to the client. Log full details server-side.

---

#### VULN-15: SQLite Database File Not Encrypted at Rest

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `packages/node/src/store.ts` |

While sensitive field values (raw_text, embedding, shared_key) are encrypted with secretbox, the SQLite file itself is unencrypted. An attacker with file system access can read: table structure, item IDs and types, privacy level settings, status values, partner DIDs, similarity scores, timestamps, and row counts. The `perturbed` column (line 114) is stored unencrypted as it is "public data sent to relays."

**Fix**: Consider SQLCipher for full database encryption. Set restrictive file permissions (0600). Document which metadata is exposed.

---

#### VULN-16: Key Material Not Zeroed from Memory

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `packages/node/src/channel.ts` `packages/app/src/session.ts:160-165` |

After channel close, shared secrets and ephemeral key pairs remain in the JavaScript heap. The `InternalChannel` object stays in the `channels` Map. `lockSession()` sets `session = null` but does not zero `identity.secretKey`.

**Fix**: On channel close, zero `sharedSecret` and `myKeyPair.secretKey` with `.fill(0)` and remove from Map. On session lock, zero `identity.secretKey`. Acknowledge JavaScript provides no memory erasure guarantees, but zeroing reduces the exposure window.

---

## Strengths

The audit also identified several well-implemented security measures worth acknowledging:

- **Correct crypto primitive selection**: TweetNaCl (Ed25519, X25519, XSalsa20-Poly1305) is a well-vetted, audited library
- **Unique random nonces**: Every encryption operation generates a fresh nonce via `nacl.randomBytes()` (CSPRNG-backed)
- **Field-level encryption**: Sensitive store fields are encrypted individually with unique nonces
- **Forward secrecy per channel**: Ephemeral X25519 keypairs generated per channel
- **No hardcoded secrets**: Clean separation of configuration and credentials
- **DID-based identity**: No centralized user registry or email/phone requirements
- **Comprehensive message signing**: All protocol messages signed with Ed25519 and verified
- **Rate limiting**: Per-DID fixed-window rate limiter for publish/search operations
- **Log sanitization**: Vectors and embeddings stripped from log output
- **Input validation**: Type checking on protocol messages, DID format validation, SQL schema constraints

---

## Remediation Status

*Updated 2026-03-26 after remediation.*

| Priority | ID | Finding | Status | Fix Details |
|----------|----|---------|--------|-------------|
| **P0** | VULN-01 | MITM key exchange | **FIXED** | Ephemeral DH keys signed with Ed25519 identity, verified on receipt |
| **P0** | VULN-02 | Raw search embeddings | **FIXED** | Search queries perturbed at ε=5.0 (~99% similarity preserved). Eval confirmed no recall drop |
| **P0** | VULN-03 | Weak password KDF | **FIXED** | Argon2id (64 MiB, 3 iterations, random 16-byte salt). Backward-compatible with v1 format |
| **P1** | VULN-04 | No body size limit | **FIXED** | 1 MiB maximum body size in readBody() |
| **P1** | VULN-05 | CORS wildcard | **FIXED** | Restricted to `http://127.0.0.1` |
| **P1** | VULN-06 | Unauthenticated WebSocket | **FIXED** | Session token required on WebSocket connection |
| **P1** | VULN-07 | Unauthenticated stats | **FIXED** | API key required when `adminApiKey` configured |
| **P2** | VULN-08 | No session timeout | **FIXED** | 30-minute inactivity timer, reset on API use |
| **P2** | VULN-09 | Directory traversal | **FIXED** | `path.resolve()` containment check against UI_DIR |
| **P2** | VULN-10 | matchRegistry leak | **FIXED** | TTL-based expiry aligned with matchExpiryMs, periodic cleanup |
| **P2** | VULN-14 | Error data leakage | **FIXED** | Generic error messages returned to client, no stack traces |
| **P3** | VULN-11 | DID correlation | **DEFERRED** | Architectural — requires per-session ephemeral DIDs (roadmap v0.3) |
| **P3** | VULN-12 | Relay identity ephemeral | **FIXED** | Relay identity persisted to disk, survives restarts |
| **P3** | VULN-13 | Auth rate limiting | **FIXED** | IP-based rate limiting (5 attempts/min default) |
| **P3** | VULN-15 | SQLite unencrypted | **ACCEPTED** | Field-level encryption protects all sensitive data. File-level encryption requires native SQLCipher dependency, contradicting standalone binary goal. Metadata exposure (types, timestamps, counts) is residual risk. |
| **P3** | VULN-16 | Key material in memory | **FIXED** | Shared secrets and secret keys zeroed on channel close and session lock |

**Summary: 14 fixed, 1 deferred to roadmap, 1 accepted risk.**

All fixes verified with 120/120 tests and 35/35 eval metrics passing. Matching recall unchanged (84% at ε=1.0).

---

## Post-Remediation Assessment

*Added 2026-03-26 after independent verification of all fixes.*

### Current Security Posture

The remediation round addressed all critical and high-severity findings correctly. Cryptographic mechanics — encryption, signing, authentication, key derivation, input validation — are now solid. The codebase is **adequate for a pilot with trusted relay operators**, but **not production-ready for untrusted infrastructure**.

### Residual Risks

The following systemic gaps remain after remediation. These are not bugs — they are architectural limitations that require design-level changes.

#### RISK-01: Weak Search Query Perturbation — **RESOLVED**

| Field | Value |
|-------|-------|
| **Related Finding** | VULN-02 |
| **Residual Risk** | ~~HIGH~~ → **LOW** |
| **Category** | Privacy |
| **Resolution** | Replaced perturbation with LSH 512-bit Hamming matching |

*Resolved 2026-03-26.* The entire perturbation-based matching system was replaced with Locality-Sensitive Hashing (LSH). The relay now sees only 64-byte binary hashes (512-bit) instead of 3KB float vectors. Hashes are irreversible (96:1 compression ratio). Both publish and search use the same hash format — the relay never sees any embedding vector. Eval benchmark: 93.3% recall on 45 realistic pairs + 5000 distractors, 100% on high-similarity pairs. See [Privacy-Preserving Matching Proposals](privacy-preserving-matching-proposals.md), Proposal 1.

#### RISK-02: DID Correlation / Behavioral Profiling

| Field | Value |
|-------|-------|
| **Related Finding** | VULN-11 (deferred) |
| **Residual Risk** | HIGH |
| **Category** | Privacy |

A single DID is used across all published items, searches, and consent exchanges. The relay can build complete behavioral profiles per user: publication frequency, search patterns, match partners, consent decisions. This metadata is as revealing as the vector content itself.

**Recommended next step**: Implement per-session or per-item ephemeral DIDs with unlinkable authorization (blind signatures or group signatures). Roadmap target: v0.3.

#### RISK-03: No Transport Layer Security

| Field | Value |
|-------|-------|
| **Residual Risk** | MEDIUM |
| **Category** | Security |

The relay communicates over plain WebSocket (`ws://`), not `wss://`. The app serves HTTP, not HTTPS. Network observers can see all protocol metadata (DIDs, message types, timing) even though channel content is E2E encrypted. The app's password submission is safe only because it binds to 127.0.0.1.

**Recommended next step**: Require TLS for all relay connections before any non-localhost deployment. Add certificate pinning for known relays.

#### RISK-04: No Key Rotation or Revocation

| Field | Value |
|-------|-------|
| **Residual Risk** | MEDIUM |
| **Category** | Security |

If an identity is compromised, there is no mechanism to revoke the old DID, notify matched partners, rotate channel keys, or migrate stored data to a new identity. The user's only option is to create a new identity and lose all history.

**Recommended next step**: Design a key rotation protocol (new DID signed by old DID as proof of continuity) and a revocation mechanism (publish revocation to relay or out-of-band).

#### RISK-05: Relay Trust Concentration

| Field | Value |
|-------|-------|
| **Residual Risk** | MEDIUM |
| **Category** | Privacy / Availability |

The relay is a single trusted component that controls match routing (could suppress or fabricate matches), knows the full social graph, can perform timing analysis, and is a single point of failure. Relay identity persistence (VULN-12 fix) helps with continuity but doesn't address trust. There is no attestation mechanism — clients cannot verify the relay runs genuine Resonance code.

**Recommended next step**: Deploy the relay inside a Trusted Execution Environment (TEE) with remote attestation. See [Privacy-Preserving Matching Proposals](privacy-preserving-matching-proposals.md), Proposal 2. Long-term: multi-relay federation with secret sharing (Proposal 5).

### Production Readiness Roadmap

| Phase | Goal | Key Changes |
|-------|------|-------------|
| **Current (Pilot)** | Trusted relay, local use | All VULN fixes applied. Adequate for controlled testing. |
| **Phase 1** | Stronger query privacy | Replace perturbation with LSH for publish and search (eliminates RISK-01) |
| **Phase 2** | Transport security | TLS for all relay connections, certificate pinning (eliminates RISK-03) |
| **Phase 3** | Unlinkable identity | Ephemeral DIDs with blind signature authorization (eliminates RISK-02) |
| **Phase 4** | Key lifecycle | Rotation protocol, revocation mechanism (eliminates RISK-04) |
| **Phase 5** | Trustless relay | TEE deployment with remote attestation (eliminates RISK-05) |
| **Phase 6** | Decentralization | Multi-relay federation with MPC (defense in depth) |

### Maturity by Area

| Area | Rating | Notes |
|------|--------|-------|
| Symmetric encryption | **Strong** | XSalsa20-Poly1305, random nonces, correct usage |
| Asymmetric encryption | **Strong** | X25519 DH + authenticated key exchange |
| Identity & signing | **Strong** | Ed25519, DID:key, all messages signed |
| Password protection | **Strong** | Argon2id with proper parameters |
| Local data protection | **Good** | Field-level encryption; SQLite metadata exposed (accepted) |
| Relay-side privacy | **Good** | LSH hashing — relay sees only irreversible binary hashes; DID correlation unsolved |
| Network security | **Weak** | No TLS enforcement, no certificate pinning |
| Key lifecycle | **Weak** | No rotation, no revocation, no migration |
| Metadata protection | **Weak** | Timing, frequency, social graph visible to relay |
| Auditability | **Good** | Clean code, explicit security comments, test coverage |

---

*Report generated by manual code audit. All fixes independently verified against source code. Residual risks and roadmap added after post-remediation assessment.*

---

## Addendum: Tauri Migration (2026-03-29)

The desktop app was migrated from Electron to Tauri v2. This has the following security implications:

### New attack surface

| Area | Risk | Mitigation |
|------|------|------------|
| CORS allowlist | Medium | Dynamic origin validation from a fixed Set of allowed origins (localhost variants + Tauri protocol schemes). No wildcard. |
| Node.js sidecar | Low | Backend runs as a child process on 127.0.0.1 only. Same security model as before. |
| Tauri IPC | Low | Minimal permissions: only `shell:allow-open`, `shell:allow-spawn`, `shell:allow-execute`. No filesystem or network plugins. |
| WebView isolation | Improved | Tauri's WebView has stricter CSP than Electron's Chromium by default. No `nodeIntegration` risk. |

### CORS changes (VULN-05 related)

The original VULN-05 fix hardcoded `ALLOWED_ORIGIN = 'http://127.0.0.1'`. This was expanded to a Set-based allowlist to support Tauri's WebView, which loads from different origins in dev vs production:

- `http://localhost:5173` — Vite dev server
- `http://localhost:3000` / `http://127.0.0.1:3000` — Production same-origin
- `tauri://localhost` — Tauri production (macOS/Linux)
- `https://tauri.localhost` — Tauri production (Windows)

The origin is validated per-request. Requests from unknown origins receive an empty `Access-Control-Allow-Origin` header.

### Removed risks

- **Electron `nodeIntegration`**: No longer applicable. Tauri WebView cannot access Node.js APIs.
- **Chromium vulnerabilities**: Tauri uses the system WebView (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux), which is patched by OS updates.
- **App size / supply chain**: Reduced from ~993MB to ~44MB DMG, significantly shrinking the attack surface of bundled dependencies.

### Residual risks unchanged

- RISK-02 (DID correlation) — still deferred to v0.3
- RISK-03 (No TLS for relay) — still applies
- RISK-04 (No key rotation) — still applies
- RISK-05 (Relay trust) — partially mitigated by peer relay mode

---

## Addendum: Security Fixes (2026-03-30)

### VULN-17: Unauthenticated relay endpoints (FIXED)

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **File** | `packages/app/src/server/api.ts:319-338` |

`/api/relay/start` and `/api/relay/stop` had no `requireAuth()` guard, allowing any local process to open a relay listener on `0.0.0.0` (network-facing) on an arbitrary port without authentication.

**Fix**: Added `requireAuth(req, res)` to both endpoints. Added port validation (1024-65535).

### VULN-18: No per-request HTTP authentication (FIXED)

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `packages/app/src/server/api.ts` (all authenticated endpoints) |

After session unlock, all HTTP API endpoints were accessible without any per-request credential. The `sessionToken` was only checked for WebSocket connections. Any local process could read all items (including `rawText`), matches, channels, and act on the user's behalf.

**Fix**: Replaced `requireSession(res)` with `requireAuth(req, res)` which validates both session state AND a `Bearer` token in the `Authorization` header. The token (generated at unlock) is now required for all authenticated HTTP endpoints. The frontend `api.client.ts` sends the token with every request via `setAuthToken()`.
