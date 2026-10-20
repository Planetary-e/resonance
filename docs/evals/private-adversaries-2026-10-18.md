# Colluding relays and multiple-domain Sybils

## Results

**Two cooperating hop operators link all 32 of the test requests to their
modeled sources.** The entry alone exposes none of their signed search IDs.
The attack joins the request identifier observed at both hops, even after the
destination observations are reversed. The test uses actual signed search
frames and production HPKE sealing/opening, but runs in one process. Source
labels stand for the addresses an entry operator would observe; no public
network or TLS capture is involved.

The production route eligibility check accepts all eight independently signed
entry identities with different modeled IPv6 /48 domains. It correctly rejects
one repeated identity and one repeated domain. It has no evidence about who
operates those different keys/domains. The endpoint authentication normally done
before selection is assumed in this experiment, not performed against its
documentation addresses.

## Availability amplifies conditional capture

The current client chooses a random starting configured entry and tries entries
in cyclic order on failure. Its destination is already chosen; it does **not**
choose two independent uniform relays from one population. The model enumerates
every start position and every honest-entry availability state, using independent
Bernoulli availability and always-online attacker entries. It assumes the fixed
destination is malicious and the configured list already contains the specified
attacker entries. It does not demonstrate an injection exploit.

| Malicious entries out of 8 | Honest-entry availability | Arrangement | Conditional source/operation capture |
| --- | ---: | --- | ---: |
| 2 | 100% | Spread | 25% |
| 2 | 50% | Spread | 46.875% |
| 4 | 100% | Spread | 50% |
| 4 | 50% | Spread | 75% |

These are exact probabilities **under the stated synthetic model**, not measured
capture rates on the volunteer network. The [JSON report](private-adversaries-2026-10-18.json)
contains 48 cases, including clustered placement and zero/all-attacker controls.
With all entries available, every case matches the attacker fraction; with all
entries malicious, capture is certain.

## What the result permits us to say

Distinct keys and address domains are useful rejection checks. They do not
establish independent operators or Sybil resistance. Padding, shuffling and
shorter sessions do not protect against an operator controlling both hops.
Removing the common request identifier alone would not fix this: the entry can
retain the mapping to the ciphertext it forwarded, which its cooperating
destination receives.

The two-hop architecture therefore retains its non-collusion assumption. Stronger
claims require a separately evaluated architecture and operator-selection trust
model. Admission tokens control allowed operations; they do not prove that relay
operators are distinct. This report does not close independent-network, timing,
membership-governance or eligibility-distribution requirements.

## Reproduce

From the repository root, with a new output path:

```sh
npm run eval:private-adversaries -- --out /tmp/resonance-private-adversaries.json
```

The exercise makes no network connections, writes only the requested report and
retains no private keys, source labels, encrypted payloads or individual searches
in that report. It is separate from the
[actual protected application exercise](v04-real-app-2026-10-18.md) and
[measured timing traces](private-windows-500-2026-10-18.md).
