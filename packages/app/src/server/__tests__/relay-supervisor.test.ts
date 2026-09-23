import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  linuxServiceUnit, macServicePlist, windowsServiceTask,
  type RelayServiceOptions,
} from '../relay-supervisor.js';

describe('desktop relay service definitions', () => {
  it('keeps relay credentials in a user service that restarts independently of the UI', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resonance-service-'));
    const options: RelayServiceOptions = {
      port: 9091, dataDir, adminKey: 'private<&"key',
      contacts: ['wss://relay.example/one?tag=a&b=2'],
      nodePath: '/opt/Resonance/node', entryPath: '/opt/Resonance/relay.mjs',
      workingDirectory: '/opt/Resonance',
      controls: {
        publicationStorageMiB: 256, newWorkIngressMiBPerHour: 32,
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

      const linux = linuxServiceUnit(options);
      expect(linux).toContain('Restart=always');
      expect(linux).toContain('ExecStart="/opt/Resonance/node" "/opt/Resonance/relay.mjs"');
      expect(linux).not.toContain('server.mjs');

      const windows = windowsServiceTask(options);
      const script = readFileSync(join(dataDir, 'relay-service.ps1'), 'utf8');
      expect(windows).toContain('<RestartOnFailure><Interval>PT1M</Interval><Count>255</Count>');
      expect(windows).toContain('<LogonTrigger>');
      expect(script).toContain("$env:RELAY_ADMIN_API_KEY='private<&\"key';");
      expect(script).toContain("& '/opt/Resonance/node' '/opt/Resonance/relay.mjs'");
      expect(script).toContain("$env:RELAY_ACTIVE_HOURS='08:00-22:00';");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
