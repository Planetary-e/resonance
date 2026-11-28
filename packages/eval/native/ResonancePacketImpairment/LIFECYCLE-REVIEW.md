# Native packet-tunnel lifecycle review — 2026-11-28

## Verdict

**ACCEPT for requesting provisioning and signed runtime verification.** This is not approval of signed runtime support or production activation.

## Accepted lifecycle behavior

- Explicit `OSSystemExtensionRequest` and `NETunnelProviderManager` operations are default-disabled and never called by the app entry point.
- IPv4 `/32` and IPv6 `/128` host routes are limited to explicit test destinations. No default route is constructed.
- Provider generations gate settings, reads, writes, shaper cleanup and counter publication. Late callbacks cannot revive stopped tunnels.
- Start completion is owned exactly once; stops coalesce. Reentrant stop avoids self-deadlock and preserves the active callback.
- Error teardown stops the failed generation's own shaper, delivers its original error, publishes final counters, then marks stopped and releases waiting stops. Restart is rejected until teardown completes.
- Controller request state is independent of connection notifications. Pending requests cannot be overwritten by status changes or competing operations.
- Shared counters use app-group `UserDefaults`, with no custom unauthenticated IPC or fallback filesystem path.
- Sandbox, hardened runtime, system-extension, packet-tunnel and app-group entitlements are narrowly scoped.

## Verification

- SwiftPM: **21/21 tests passed**.
- Unsigned Xcode test action: **21/21 passed**, `TEST SUCCEEDED`, with all five targets built and embedded-binary validation.
- `/opt/homebrew/bin/git diff --check` passed.
- Identity: `/tmp/resonance-packet-impairment-error-teardown-identity.json`.

Normal signed build currently fails before compilation because Mac App Development profiles are missing for the controller and tunnel products. Requesting `-allowProvisioningUpdates` is the next verification step. Actual activation, app-group persistence, preference saves, tunnel start/stop and packetFlow behavior remain unverified. No production or K1–K8 acceptance is implied.
