# DEC-023 live client-held discovery integration review — November 22, 2026

## Verdict

**ACCEPT LIVE INTEGRATION.** Real relay listeners and Node network clients now execute the reviewed leased-index, encrypted offline-mailbox and online-content protocol. This is local live-transport acceptance only. Packet impairment, process-kill, physical-resource and independent-deployment qualification remain open; no production/K1–K8/R or release acceptance follows.

Authorization is `delivery/decisions/DEC-023.md`; implementation is on `feature/client-held-discovery`.

## Live scope

- Signed bounded RPC for publication, exact replay, refresh/semantic revision, withdrawal, lookup/search and authorized repair.
- Encrypted offline deposit/fetch/ACK, generation/admission evidence, stored/queued receipt collection, anti-entropy and restart persistence.
- Online content forwarding through existing private channels, with relationship-signed polls and exact pending-recipient binding. Offline counterparties are refused rather than archived.
- Direct and private Node clients validate signed responses, preserve current policy/admission and stop work after disconnect.
- Server reopen preserves accepted leased-index/mailbox obligations. No unauthenticated debug endpoint or plaintext original-content journal was added.

The live suite uses actual listeners and covers publish/search/repair/restart, three-relay queued evidence, generation-scoped ACK, recipient dedup, direct online delivery and two-relay private forwarding across separate IPv4-entry/IPv6-destination loopback domains.

## Defects found and corrected

Independent review iterations found and corrected:

1. Repaired terminal withdrawals did not propagate to the mailbox; repair now uses the authenticated terminal path and blocks fetch/deposit after restart.
2. A conflicted index could still authorize mailbox activity; selection now fails closed for the exact quarantined publication/generation, including when another clean publication shares the lease.
3. Live changed-ciphertext-after-ACK conflicts were not committed; an explicit no-spend conflict path journals them before reply and preserves them through restart.
4. Search could collapse distinct publications sharing lease/item type; results now carry exact publication/generation identity and resolve independently.

The final A/B control proves conflicted publication A cannot fetch/create changed deposits while clean B remains valid, including after restart. Earlier withdrawal, conflict and search controls remain intact.

## Validation

- Focused real-listener live suite: **7/7 passed** after all corrections.
- Full affected run: **211/211 tests passed across 32 files** in 87.48 seconds.
- Actual-source TypeScript noEmit, `npm run build` and diff checks passed.
- Final independent source review returned **ACCEPT LIVE INTEGRATION**.

## Remaining production-qualification gaps

- No external-network or packet-loss/impairment matrix, actual process-kill matrix, cold/warm deployment matrix or physical-power measurement.
- No relay-global capacity qualification; mailbox accounting remains per selected replica per lease.
- Online original delivery requires an active recipient poll and both required clients online; no offline original archive exists.
- No model runtime, UI, installer or deployment.
- K5/K6, FEAT-001 and full K1–K8 qualification remain open. This local live-integration result must not be presented as production acceptance.

## Next action

Run real-network impairment and actual process-death qualification, then measure local resource profiles and obtain another independent review before considering independent deployment.
