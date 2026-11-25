# DEC-025 startup memory correction review — 2026-11-25

## Verdict

**ACCEPT FOR ONE FRESH FULL BURST DIAGNOSTIC.** Independent review finds the streaming parser and memory changes sound. A three-run campaign should proceed only if that diagnostic preserves correct operations and aggregate peak remains at or below 1.5 GiB.

## Accepted changes

- Canonical base-state publications are parsed in 64 KiB chunks with `StringDecoder`, preserving UTF-8, string/escape state and nested-object depth across boundaries. Trailing/truncated input, noncanonical fallback, duplicate-publication, exact-byte and incremental-replay validation remain enforced.
- Publication bytes and generation identity are unchanged.
- Direct fixture imports load the same implementations without unrelated barrel exports.
- Only the latest fully acknowledged original is retained for exact replay, eliminating unbounded parent history growth without changing retry selection.

No GC is forced and no measurement is suppressed.

## Evidence

- Focused leased-store tests reproduced locally: **14/14 passed**.
- Implementer affected regression: **78/78 across 15 files**.
- Actual-source noEmit, build and diff checks passed.
- Full-cardinality small diagnostic: aggregate/post-load peak **1,492,877,312 B**, below 1.5 GiB by **117,735,424 B**; parent ready 60,669,952 B; relay ready peaks 278.8–292.5 MiB; final aggregate 1,352,957,952 B.
- **24/24 good**, exact replay acknowledged, final disk reconciliation passed.

This is small-operation evidence, not a full campaign result. Run one fresh full burst diagnostic to validate operation and memory behavior at full scale. No production or K/R acceptance is implied.
