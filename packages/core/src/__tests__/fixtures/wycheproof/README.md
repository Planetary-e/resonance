# Pinned Ed25519 verification vectors

`ed25519_test.json` is unchanged from C2SP/Wycheproof commit
`7a325932231bd7a724c791c8b0d65ea4d6d2f435`, fetched 2026-10-17:

https://github.com/C2SP/wycheproof/blob/7a325932231bd7a724c791c8b0d65ea4d6d2f435/testvectors_v1/ed25519_test.json

The upstream Apache-2.0 license is retained in `LICENSE`. The file contains 151
cases: 88 valid and 63 invalid. Tests consume the vectors as data, without running
upstream scripts. These vectors are regression evidence, not a proof covering
every possible public key, message or implementation.
