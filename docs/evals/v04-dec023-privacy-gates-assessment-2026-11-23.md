# DEC-023 remaining privacy-gate assessment — November 23, 2026

## Verdict

**K5 and K6 remain open.** Client-held originals and local generation do not make derived indexes or traffic private. Live integration, process-death evidence and scaling corrections cannot be used to claim these gates. No production acceptance follows.

Authorization is `delivery/decisions/DEC-023.md`.

## K5: derived-index confidentiality

The current leased-index representation cannot satisfy K5 as an integrated candidate:

- Public deterministic 512-bit LSH fingerprints permit known-text recomputation and correlation.
- Live search returns complete signed indexes, including fingerprints, publication/lease identifiers, commitments and mailbox metadata.
- Stable lease/publication/fingerprint/commitment identifiers link revisions and sessions.
- HMAC with a random client-held key protects exact-original confirmation until an authorized grant, but does not repair fingerprint inversion or stable-identifier linkage.
- Private online content delivery starts only after that earlier index disclosure.

Existing evidence remains decisive: top-1 reconstruction 86–97%, known-text identification 100%, and 78–98% negative-pair false positives. Existing small-fixture recall and LSH parameter choices do not change those failures. Required bilingual ≥1,000-query/≥10,000-publication evaluation and epoch-migration evidence are still missing.

A credible replacement requires confidential vector shares and an actively secure full-scan/top-k protocol, returning authorized opaque match capabilities rather than complete indexes/fingerprints/scores/stable IDs. A TEE or semi-honest public-search shortcut does not satisfy the declared adversary. The smallest authorized experiment must compare exact plaintext and secure selections, measure each language independently, run both privacy games among 100 candidates including authorized-output views, exercise a real share/epoch refresh, and apply joint K1/K7 resource falsifiers.

## K6: observer privacy

Current loopback tests establish protocol correctness, not observer privacy:

- Direct RPC creates a new TCP connection per operation, exposing connection timing and operation boundaries.
- Search exposes group, item type, epoch, fingerprint and result shape; lookup exposes publication/generation.
- Mailbox IDs, lease IDs, publication IDs, generation IDs, timestamps and request progress remain visible even when plaintext is padded/encrypted.
- Exact retries repeat ciphertext; fetch→ACK→empty-fetch reveals processing state.
- Refresh deliberately retains stable semantic/identity fields and has a distinguishable multi-replica maintenance signature.
- Content polls reveal relationship/channel activity and counterparty presence; response length and timing remain observable.
- Current private-content tests explicitly disable entry and reply mixing. IPv4/IPv6 loopback separation is not operator independence.

No current client-held suite reports activity-detection or source-linking AUC, passive/cooperating-hop/Sybil/cross-session traces, chosen-operation games, ordinary polling/refresh power, or physical packet/power measurements.

A meaningful treatment requires client→entry→honest independent re-encrypting mix→destination, fixed-size per-hop cells, independent delays and operation-independent client/relay cover. Lookup, mailbox, refresh and content operations must share that cell stream with dummies; exact retries cannot create operation-triggered bursts. Baseline and treatment must use identical observer/scoring games and joint success, latency, traffic, memory, CPU and physical-power gates.

Before running such an experiment, actual serialized payload/cell distributions must be costed, including setup, three transport edges, sparse daily bytes/wakeups and the previous failed TLS first-slot allocation. Below-TCP impairment and independent physical measurements remain explicit missing evidence.

## Decision

Do not infer K5/K6 from client-held originals, HMAC commitments, encrypted envelopes or loopback correctness. Keep the public-LSH arm as a negative control and require separate R3/R4 authorization before any confidential-compute or background-mix implementation.
