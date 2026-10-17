import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStorageReservationAuthority, withStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES } from '@resonance/core/storage-reservations';
import { stopRelayServiceForStorageActivation } from '../relay-service-stop.js';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn() }));
afterEach(() => { vi.mocked(execFileSync).mockReset(); vi.restoreAllMocks(); });
it.skipIf(!process.getuid)('targets the macOS service directly and preserves definitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'checked-native-stop-')), file = join(root, 'retained.plist'); writeFileSync(file, 'preserve');
  try {
    vi.mocked(execFileSync).mockReturnValue(''); stopRelayServiceForStorageActivation('darwin');
    expect(vi.mocked(execFileSync).mock.calls[0].slice(0, 2)).toEqual(['launchctl', ['bootout', `gui/${process.getuid!()}/earth.planetary.resonance.relay`]]);
    expect(readFileSync(file, 'utf8')).toBe('preserve');
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error('absent'), { status: 3 }); });
    expect(() => stopRelayServiceForStorageActivation('darwin')).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it.skipIf(!process.getuid).each([1, 5, 13, null])('does not treat macOS native status %s as service absence', status => {
  vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error('private command with secret path'), { status }); });
  expect(() => stopRelayServiceForStorageActivation('darwin')).toThrow('Native relay supervision could not be confirmed stopped; retain maintenance and retry');
});
function linux(before: string, registration: string, after: string, registrationAfter: string) {
  const output = [before, registration, ...(before || registration ? [''] : []), after, registrationAfter];
  vi.mocked(execFileSync).mockImplementation(() => output.shift() ?? 'unexpected command');
}
it('checks Linux runtime and automatic registration after disabling, without deleting the unit', () => {
  linux('resonance-relay.service loaded active running Relay', 'resonance-relay.service enabled enabled', 'resonance-relay.service loaded inactive dead Relay', 'resonance-relay.service disabled enabled');
  stopRelayServiceForStorageActivation('linux');
  expect(vi.mocked(execFileSync).mock.calls[2][1]).toEqual(['--user', 'disable', '--now', 'resonance-relay.service']);
  expect(vi.mocked(execFileSync).mock.calls).toHaveLength(5);
});
it('accepts confirmed absence and stops a loaded Linux unit whose file has disappeared', () => {
  linux('', '', '', ''); stopRelayServiceForStorageActivation('linux'); expect(vi.mocked(execFileSync).mock.calls).toHaveLength(4);
  vi.mocked(execFileSync).mockClear(); linux('resonance-relay.service not-found active running Relay', '', 'resonance-relay.service not-found inactive dead Relay', '');
  stopRelayServiceForStorageActivation('linux'); expect(vi.mocked(execFileSync).mock.calls[2][1]).toEqual(['--user', 'stop', 'resonance-relay.service']);
});
it.each(['active', 'activating', 'deactivating', 'unknown'])('refuses Linux state %s after a nominally successful stop', state => {
  linux('resonance-relay.service loaded active running Relay', 'resonance-relay.service enabled', `resonance-relay.service loaded ${state} running Relay`, 'resonance-relay.service disabled');
  expect(() => stopRelayServiceForStorageActivation('linux')).toThrow(/could not be confirmed/);
});
it.each(['enabled', 'enabled-runtime', 'static', 'masked'])('refuses retained Linux registration %s', state => {
  linux('resonance-relay.service loaded active running Relay', 'resonance-relay.service enabled', 'resonance-relay.service loaded inactive dead Relay', `resonance-relay.service ${state}`);
  expect(() => stopRelayServiceForStorageActivation('linux')).toThrow(/could not be confirmed/);
});
it('refuses malformed, ambiguous, oversized and failed native queries', () => {
  for (const output of ['other.service loaded inactive dead Other', 'resonance-relay.service loaded inactive dead\nsecond.service loaded active running', 'x'.repeat(256 * 1024 + 1), '\0']) {
    vi.mocked(execFileSync).mockReturnValue(output); expect(() => stopRelayServiceForStorageActivation('linux')).toThrow(/could not be confirmed/);
  }
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error('unavailable user manager'); });
  expect(() => stopRelayServiceForStorageActivation('linux')).toThrow(/could not be confirmed/);
});
it('uses a fixed Windows task removal script with explicit failure handling and confirmation', () => {
  vi.mocked(execFileSync).mockReturnValue('{"state":"absent"}'); stopRelayServiceForStorageActivation('win32');
  const call = vi.mocked(execFileSync).mock.calls[0]; expect(call[0]).toBe('powershell.exe');
  const script = (call[1] as string[]).at(-1)!; expect(script).toContain("$ErrorActionPreference = 'Stop'"); expect(script).toContain('Unregister-ScheduledTask -InputObject');
  expect(script).toContain('$remaining.Count -ne 0'); expect(script).not.toContain('SilentlyContinue |');
  for (const result of ['', '{"state":"running"}', 'warning\n{"state":"absent"}']) {
    vi.mocked(execFileSync).mockReturnValue(result); expect(() => stopRelayServiceForStorageActivation('win32')).toThrow(/could not be confirmed/);
  }
});
it('bounds all native work together and refuses native actions inside a managed writer scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-stop-scope-'));
  const authority = openStorageReservationAuthority({ directory: join(root, 'authority'), mode: 'create-new', limitBytes: STORAGE_RESERVATION_CONTROL_BYTES });
  try {
    expect(() => withStorageReservationAuthority(authority, () => stopRelayServiceForStorageActivation('linux'))).toThrow(/Leave the managed writer scope/);
    expect(execFileSync).not.toHaveBeenCalled();
    let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.mocked(execFileSync).mockImplementation(() => { elapsed += 10000; return ''; });
    expect(() => stopRelayServiceForStorageActivation('linux')).toThrow(/could not be confirmed/);
    expect(vi.mocked(execFileSync).mock.calls.map(call => (call[2] as { timeout: number }).timeout)).toEqual([15000, 5000]);
  } finally { authority.close(); rmSync(root, { recursive: true, force: true }); }
});
