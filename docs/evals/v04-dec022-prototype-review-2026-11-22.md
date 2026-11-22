# DEC-022 bounded client-held discovery prototype review — November 22, 2026

## Final verdict

**ACCEPT BOUNDED IN-PROCESS PROTOTYPE.** The implementation is a plausible, reviewed protocol prototype using real stores, cryptography and durable local files. This is not live-RPC, external-network, process-kill-campaign, production, K1–K8/R, model-selection or release acceptance.

Authorization is `delivery/decisions/DEC-022.md`; the accepted design is `docs/developers/v0.4-client-held-discovery-architecture.md`.

## Implemented scope

- Strict Ed25519 leased-index operations, independent lease/semantic counters, HMAC original commitments, exact replay and retained conflict evidence.
- Encrypted atomic client originals/keys/operations/outbox/writer/dedup state and relay refresh/withdrawal/conflict/replica-repair state.
- Lease-only refresh without re-matching or duplicate logical notification; controlled semantic revision and stable notification identity across restart/repair.
- Real fixed-padding NaCl offline-request envelopes, stable logical request IDs, generation-scoped storage/ACK/replica identities, signed receipts, stored/queued distinctions, active+draining generations, admission replay and inclusive 16-request/4-MiB quota.
- Encrypted recipient inbox commit before owner-signed generation ACK, withdrawal/ACK-before-deposit controls, bounded anti-entropy and causal journal/compaction.
- Explicit content requests/single-use grants/channel-encrypted responses, durable delivery state and recipient HMAC verification before returning original content.
- No generative model, new queue dependency, offline original archive, deployment or production routing.

## Composed validation

A new `packages/node/src/__tests__/client-held-discovery.integration.test.ts` composes the actual local/relay stores through publication, offline-owner repair, lease refresh, encrypted mailbox redeposit, three signed queued receipts, recipient restart/inbox-before-ACK, generation-scoped ACK, authorized original delivery, withdrawal and quota ceilings.

Final affected validation:

- **173/173 tests passed across 29 files** in 34.16 seconds.
- Actual-source TypeScript noEmit passed.
- `npm run build` passed.
- Diff checks passed.

An isolated composed-suite `/usr/bin/time -l` run reported 2.11 seconds wall time, 1.63 seconds user CPU, 0.32 seconds system CPU and 208,257,024 B maximum RSS. These are local test-command facts only, not physical-power, real-network or K7 qualification.

## Defects found and corrected

1. A negative request-ID test occasionally replaced trailing `A` with `A`; the mutation is now deterministically different. Ten consecutive four-suite repetitions passed after correction.
2. Exact deposit replay could bypass a later terminal withdrawal. Withdrawal now precedes replay handling, including after restart.
3. A foreign signer could withdraw another client's mailbox lease. Direct withdrawal now binds exact authorized index publication/key/lease/counters; replica events carry byte-exact authorized index evidence and replay rechecks it. Direct, sync and restart foreign-withdrawal controls reject without mutation.
4. Changed authenticated bytes after ACK were misclassified as duplicate. Only exact bytes replay; different valid bytes use the bounded retained conflict path without resurrection or repeated growth.

Independent follow-up source review returned **ACCEPT BOUNDED IN-PROCESS PROTOTYPE** after confirming those fixes and their focused controls.

## Explicit remaining boundaries

- Stores are not wired into live relay server RPC, network relay client, PairwiseChannelManagerV2, CLI or UI. The composed path uses direct in-process method calls; existing loopback suites exercise other protocol paths.
- Three-receipt queued behavior uses real signed receipts, not a new three-relay deployed transport.
- Crash evidence uses durable reopen, injected append/rename failures and torn journals, not a full process-kill campaign.
- Quota accounting is per selected replica per lease. No relay-global identity/cardinality bound or production resource closure is claimed.
- Stable lease pseudonymity and existing K5/K6 failures remain open privacy limitations.
- Permanent client/key/original loss is not repaired by relay replicas; FEAT-001 control-plane recovery remains open.
- No model runtime, model selection, economic, production or release approval follows.

## Next decision

The bounded prototype is complete for independent evaluation. Any live integration, process-death matrix, physical-resource qualification, model arm or production routing requires a separate owner decision and must not inherit acceptance from this in-process result.
