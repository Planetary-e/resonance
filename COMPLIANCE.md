# Regulatory Compliance Guide

_Resonance is open-source software published under the MIT license. This document clarifies regulatory obligations for different roles in the ecosystem._

---

## Open-Source Software Is Not Regulated

The EU AI Act (Article 2, Recital 102) explicitly exempts free and open-source AI components released under permissive licenses from the obligations of the regulation, unless they are placed on the market or put into service as high-risk AI systems.

**Publishing this code on GitHub creates no regulatory obligations for the Planetary Project or its contributors.** Regulation applies to those who **deploy** or **operate** the software, not to those who write or distribute it.

---

## Roles and Responsibilities

### You are a **User** (running the desktop app)

You run Resonance on your own device. Your data (items, embeddings, identity) stays on your machine, encrypted with your password.

| Obligation | Applies? | Notes |
|-----------|----------|-------|
| GDPR | No | You are processing your own data on your own device |
| EU AI Act | No | Personal use is excluded |

When you publish an item to a relay, you transmit a **privacy-preserving hash** (not your raw text) and your **pseudonymous DID**. You are responsible for choosing which relays to connect to.

### You are a **Relay Operator** (running a relay server)

You operate infrastructure that processes data from other users. Under GDPR, you are a **data controller or processor** depending on your relationship with users.

| Obligation | Applies? | What You Must Do |
|-----------|----------|-----------------|
| GDPR Art. 6 (Lawful basis) | Yes | Document your lawful basis for processing (likely legitimate interest or consent) |
| GDPR Art. 13/14 (Transparency) | Yes | Publish a privacy notice explaining what data you process |
| GDPR Art. 17 (Right to erasure) | Yes | Honor deletion requests — use the relay's purge mechanisms |
| GDPR Art. 25 (Privacy by design) | Yes | The protocol helps: only hashes and pseudonymous DIDs are transmitted |
| GDPR Art. 30 (Records of processing) | Yes | Maintain a record of processing activities |
| GDPR Art. 32 (Security) | Yes | Keep the relay software updated, restrict network access |

**What the relay processes:**

| Data | Type | Retention | Personal Data? |
|------|------|-----------|---------------|
| LSH binary hashes | Pseudonymous | 7 days (auto-expiry) | No (not invertible) |
| DIDs | Pseudonymous identifier | Configurable | Yes (persistent pseudonym) |
| Match pairs | DID linkage | 7 days (auto-expiry) | Yes (links two pseudonyms) |
| IP addresses | Network metadata | 1 minute (rate limiting only, RAM) | Yes |
| Timestamps | Metadata | With parent record | Contextually yes |

**What the relay never sees:**

- Raw text of items (never transmitted)
- True embeddings (only privacy-preserving hashes)
- Channel contents (E2E encrypted, relay forwards ciphertext only)
- Real identity (only pseudonymous DIDs)

**Recommended actions for relay operators:**

1. Publish a privacy notice (template below)
2. Set log retention to minimum necessary (stdout only, no persistent logs)
3. Enable auto-expiry on all stored data (default: 7 days)
4. Respond to erasure requests by purging the DID from all stored data
5. If operating in the EU, consider registering with your local Data Protection Authority

### You are a **Professional** (using Resonance for clients)

If you use Resonance to provide services to others (therapy, legal advice, healthcare, education), additional obligations may apply based on your domain.

| Domain | Additional Regulation | Key Requirements |
|--------|----------------------|-----------------|
| Healthcare / Therapy | EU AI Act (high-risk), GDPR Art. 9 (special categories) | Conformity assessment, human oversight, clinical validation, explicit consent for health data |
| Legal services | EU AI Act (high-risk for justice/legal), professional liability rules | Human review of all AI outputs, professional insurance |
| Recruitment / HR | EU AI Act (high-risk), Employment law | Bias auditing, transparency to candidates, human decision-making |
| Education | EU AI Act (high-risk), student data protection | Parental consent for minors, bias testing, right to human teacher |
| General matching | EU AI Act (minimal risk) | Transparency that AI is involved |

**Key principle:** The AI Act regulates the **application**, not the protocol. Using Resonance for general matching is minimal risk. Using it to assist clinical decisions is high risk. The same code, different obligations depending on deployment context.

---

## What the Protocol Provides for Compliance

Resonance's privacy-by-design architecture helps deployers meet regulatory requirements:

| GDPR Requirement | How Resonance Helps |
|-----------------|-------------------|
| **Data minimization** (Art. 5) | Only LSH hashes transmitted to relay, not raw data |
| **Privacy by design** (Art. 25) | Local-first architecture, field-level encryption, pseudonymous DIDs |
| **Security** (Art. 32) | E2E encrypted channels (XSalsa20-Poly1305), Ed25519 signatures, Argon2id KDF |
| **Right to erasure** (Art. 17) | Item withdrawal, DID purge capability on relay |
| **Data portability** (Art. 20) | All user data stored locally in standard formats |
| **Pseudonymization** (Art. 4) | DID-based identity with no real-name requirement |

| AI Act Requirement | How Resonance Helps |
|-------------------|-------------------|
| **Transparency** | Open-source code, published architecture docs, eval results |
| **Human oversight** | Cluster model: human professional orchestrates AI agents |
| **Technical documentation** | Architecture docs, wire protocol spec, security audit published |
| **Risk management** | Security audit with 18 vulnerabilities addressed |

---

## Privacy Notice Template for Relay Operators

Relay operators may adapt this template for their privacy notice:

```
PRIVACY NOTICE — [Your Relay Name]

This relay is part of the Resonance decentralized matching network.

WHAT WE PROCESS:
- Privacy-preserving hashes of your published items (not your raw text)
- Your pseudonymous identifier (DID) — not linked to your real identity
- Match notifications when your items match with other users
- Your IP address for rate limiting only (stored in memory, deleted after 1 minute)

WHAT WE NEVER SEE:
- The text of your items
- Your real identity
- The contents of your channels with other users (end-to-end encrypted)

RETENTION:
- Hashes and match data: automatically deleted after 7 days
- IP addresses: deleted after 1 minute
- Logs: [specify your log retention policy]

YOUR RIGHTS:
- You can withdraw any published item at any time
- You can request deletion of all your data by contacting [your contact info]
- You can disconnect from this relay at any time and use a different one

LEGAL BASIS:
[Legitimate interest / Consent — choose based on your jurisdiction]

CONTACT:
[Your contact information]
```

---

## Frequently Asked Questions

**Q: Is Resonance itself regulated under the EU AI Act?**
A: No. The EU AI Act exempts open-source components released under permissive licenses (Article 2, Recital 102). Regulation applies to those who deploy AI systems, not those who publish open-source tools.

**Q: Do I need to do a DPIA (Data Protection Impact Assessment)?**
A: If you operate a relay, probably yes — especially if it serves EU users or processes data that could be considered profiling. If you only run the desktop app for personal use, no.

**Q: What if someone uses Resonance for something illegal?**
A: The same as any open-source tool. The authors of the software are not liable for misuse. Relay operators may need to respond to lawful interception requests in their jurisdiction.

**Q: Does the decentralized architecture help with compliance?**
A: Yes. There is no single point of data collection, no centralized user database, and no cross-user data aggregation. Each relay operator is responsible only for the data they process. Users control their own data locally.

**Q: What about GDPR's "right to be forgotten"?**
A: Users can withdraw items (relay marks them as withdrawn and stops matching). Relay operators should implement DID purging to fully erase a user's presence. The protocol supports this — the relay can delete all records associated with a DID.

**Q: Do I need cookie consent banners?**
A: No. The desktop app uses no cookies, no web tracking, and no analytics. The ePrivacy Directive does not apply.

---

_This document is informational guidance, not legal advice. Consult a qualified legal professional for compliance obligations specific to your jurisdiction and use case._

_Last updated: 2026-04-08_
