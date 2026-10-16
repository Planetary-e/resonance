import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  linuxServiceUnit, macServicePlist, windowsServiceTask, relayServiceRuntime,
  type RelayServiceOptions,
} from '../relay-supervisor.js';

afterEach(() => vi.unstubAllEnvs());

describe('desktop relay service definitions', () => {
  it('preserves enrollment across GUI restarts and distinguishes an explicit disable from a missing override', () => {
    vi.stubEnv('RESONANCE_RELAY_ENTRY', '/opt/Resonance/relay.mjs');
    vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', undefined);
    expect(relayServiceRuntime('/private/retained-volunteer.json').historyVolunteerFile).toBe(resolve('/private/retained-volunteer.json'));
    expect(relayServiceRuntime().historyVolunteerFile).toBeUndefined();
    vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', '/private/replacement.json');
    expect(relayServiceRuntime('/private/retained-volunteer.json').historyVolunteerFile).toBe(resolve('/private/replacement.json'));
    vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', '');
    expect(relayServiceRuntime('/private/retained-volunteer.json').historyVolunteerFile).toBe('');
  });
  it('keeps relay credentials in a user service that restarts independently of the UI', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resonance-service-'));
    const options: RelayServiceOptions = {
      port: 9091, dataDir, adminKey: 'private<&"key',
      contacts: ['wss://relay.example/one?tag=a&b=2'],
      nodePath: '/opt/Resonance/node', entryPath: '/opt/Resonance/relay.mjs',
      workingDirectory: '/opt/Resonance',
      historyVolunteerFile: "/private/owner's history/volunteer.json",
      controls: {
        publicationStorageMiB: 256, newWorkIngressMiBPerHour: 32,
        totalBandwidthMiBPerHour: 128,
        cpuMillisecondsPerMinute: 10_000, activeHours: '08:00-22:00',
        onlyWhenCharging: true,
      },
    };
    try {
      const mac = macServicePlist(options);
      expect(mac).toContain('<key>KeepAlive</key><true/>');
      expect(mac).toContain('private&lt;&amp;&quot;key');
      expect(mac).toContain('wss://relay.example/one?tag=a&amp;b=2');
      expect(mac).not.toContain('server.mjs');
      expect(mac).toContain('RELAY_NEW_WORK_CPU_MS_PER_MINUTE');
      expect(mac).toContain('RELAY_TOTAL_BANDWIDTH_BYTES_PER_HOUR');
      expect(mac).toContain('<key>RELAY_HISTORY_VOLUNTEER_FILE</key><string>/private/owner&apos;s history/volunteer.json</string>');

      const linux = linuxServiceUnit(options);
      expect(linux).toContain('Restart=always');
      expect(linux).toContain('ExecStart="/opt/Resonance/node" "/opt/Resonance/relay.mjs"');
      expect(linux).not.toContain('server.mjs');
      expect(linux).toContain("Environment=\"RELAY_HISTORY_VOLUNTEER_FILE=/private/owner's history/volunteer.json\"");

      const windows = windowsServiceTask(options);
      const script = readFileSync(join(dataDir, 'relay-service.ps1'), 'utf8');
      expect(windows).toContain('<RestartOnFailure><Interval>PT1M</Interval><Count>255</Count>');
      expect(windows).toContain('<LogonTrigger>');
      expect(script).toContain("$env:RELAY_ADMIN_API_KEY='private<&\"key';");
      expect(script).toContain("& '/opt/Resonance/node' '/opt/Resonance/relay.mjs'");
      expect(script).toContain("$env:RELAY_ACTIVE_HOURS='08:00-22:00';");
      expect(script).toContain("$env:RELAY_HISTORY_VOLUNTEER_FILE='/private/owner''s history/volunteer.json';");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
