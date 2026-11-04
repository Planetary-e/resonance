# RSO5 independent-process economic evidence receipt — DEC-008

**Status: diagnostic reproduction reproduction-16 PASS; independent re-review may proceed; E2 blocked; prototype-only; no K/R acceptance.**
This receipt is generated programmatically from the exact reproduction-16 artifact set. It
is not a 20-run matrix, production deployment, campaign or economic verdict.

## Frozen identity and environment

- Run: `reproduction-16`; scenario: `full-smoke`; manifest: `delivery/results/econ-lab-manifest-reproduction-16.json`.
- Host: Mac15,6, Apple M3 Pro/arm64, 18 GiB; macOS 27.0 (26A428), Node.js 24.19.0.
- Transport: authenticated serialized WebSocket loopback with per-run/per-sender/
  per-recipient/per-channel credentials and explicit method authorization.
- Matrix driver: 20 frozen order/seed identities validated by selection smoke;
  **zero matrix lifecycles executed**. Execution remains gated by independent review.
- New-view path: every `runtime:newView` is followed by per-member
  `runtime:startup` and durable serving sequence/digest evidence. Selection smoke
  verifies this required path; no new-view matrix lifecycle was executed here.
- Randomness: `node:crypto.randomBytes` is nondeterministic and runs are not exact
  business replays. Seeds, source, scenarios, run count and analysis are frozen before
  results; no seed retrofitting or draw discard is allowed.
- Power: **blocked** — `powermetrics requires superuser; no calibrated external AC meter authorized`.
- Prices, budget, value and affordability: **pending**.

## Reproduction gates

- Focused RSO5 manifest: **17/17 PASS**.
- Actual-source `./node_modules/.bin/tsc -p docs/handover/2026-10-24/source-tsconfig.json --noEmit`: **PASS**.
- Independent-process reproduction: **1/1 PASS**, with 8 runtimes, 40 RSO5 replicas,
  4 observers and **52/52 clean stops**.
- Exact-path post-run sweep: **zero surviving workers**. Bounded stop uses graceful
  wait, SIGTERM escalation and SIGKILL fallback.
- Forged cross-runtime role and privileged replica `runtime:read`: **refused**.
- Predecessor runtimes/replicas stopped before recovery: yes.
- Recovered proofs: **164**. Logical process-held copy audits:
  **164**, with RSO5 signature/scope/challenge/identity verification.
  These are not physical devices or crash-durability proof.
- Process trees: recursive `ps` parent-link enumeration; observed child IDs are
  retained per role, not hardcoded.

## Exact current measurements

| Metric | reproduction-16 artifact value |
| --- | ---: |
| Authenticated WebSocket messages | 18215 |
| Application payload bytes | 103159105 |
| Application WebSocket frame bytes | 103269285 |
| Separate work metric | 677397548 B |
| Worker user CPU | 28.882461 s |
| Worker system CPU | 8.889759 s |
| Maximum sampled process-tree RSS | 171032576 B |
| Clean worker stops | 52/52 |
| Remaining workers after exact-path sweep | 0 |

Work was independently recomputed as `sum(roles.used_bytes)` from
`delivery/results/econ-work-reproduction-16.json`; per-role operations are retained for review. CPU and maximum RSS
were computed from `delivery/results/econ-process-reproduction-16.json`.

## Limitations retained

- Application WebSocket payload/frame bytes only; handshake/control frames and
  TCP/IP bytes are excluded. Loopback is not Internet/Wi-Fi/last-mile evidence.
- `nettop` matched zero worker rows; no host-network byte reconciliation is inferred.
- `iostat` is whole-host only. Per-process physical disk counters and fsync latency
  remain unavailable; logical arena files are not physical disk I/O.
- RSS sampling is best effort on one host, not whole-host isolation.
- Matrix-specific business randomness remains unseeded; frozen seeds currently derive
  run identity and channel credentials. Matrix execution was not performed.
- Power remains blocked with no samples. No work-byte/CPU-to-energy conversion or
  economic affordability claim is made.

## Attempts and evidence lineage

`delivery/results/econ-lab-attempts.json` retains 24 invalid attempts plus subsequent
reproductions. The earlier same-name reproduction is preserved separately as
`reproduction-02`; this receipt uses only reproduction-16 files. Failure/reconciliation
artifacts remain retained. No invalid run was silently replaced.

E1 is complete for local planning only. E2 remains **blocked** by incomplete aggregate
matrix/30-minute window evidence and blocked physical power. Run artifacts otherwise
carry their own run-specific completion status rather than matrix-not-run labels.
E3 needs separate owner authorization. D4 prototype-only remains.

**Independent re-review can proceed** on matrix scenario selection, identity
immutability, role/channel authorization, process-tree evidence, signed logical-copy
audits, cleanup, and exact resource accounting. No E2, K/R or production acceptance
is claimed.
