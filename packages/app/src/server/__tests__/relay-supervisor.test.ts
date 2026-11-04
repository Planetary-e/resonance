import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  linuxServiceUnit, macServicePlist, windowsServiceTask, windowsServiceScript, relayServiceRuntime, relayServiceEnvironment, validateRelayServicePaths,
  type RelayServiceOptions,
} from '../relay-supervisor.js';

afterEach(() => vi.unstubAllEnvs());

describe('desktop relay service definitions', () => {
  it('retains the observer and its explicit routes across GUI restarts and renders them in each native service format', () => {
    vi.stubEnv('RESONANCE_RELAY_ENTRY', '/opt/Resonance/relay.mjs');
    vi.stubEnv('RESONANCE_RELAY_POLICY_OBSERVER_FILE', undefined);
    vi.stubEnv('RESONANCE_RELAY_POLICY_OBSERVER_LINKS_FILE', undefined);
    const retained = { policyObserverFile: '/private/observer.json', policyObserverLinksFile: '/private/observer-links.json' };
    const runtime = relayServiceRuntime(retained);
    expect(runtime.policyObserverFile).toBe(resolve(retained.policyObserverFile));
    expect(runtime.policyObserverLinksFile).toBe(resolve(retained.policyObserverLinksFile));
    expect(() => relayServiceRuntime({ policyObserverLinksFile: retained.policyObserverLinksFile })).toThrow('require');
    const directory = mkdtempSync(join(tmpdir(), 'observer-service-'));
    const options: RelayServiceOptions = { dataDir: directory, port: 9091, adminKey: 'test-only', contacts: [],
      nodePath: process.execPath, entryPath: '/opt/Resonance/relay.mjs', workingDirectory: directory, ...retained };
    try {
      expect(relayServiceEnvironment(options)).toMatchObject({ RELAY_POLICY_OBSERVER_FILE: retained.policyObserverFile, RELAY_POLICY_OBSERVER_LINKS_FILE: retained.policyObserverLinksFile });
      for (const text of [macServicePlist(options), linuxServiceUnit(options), windowsServiceScript(options)]) {
        expect(text).toContain('RELAY_POLICY_OBSERVER_FILE'); expect(text).toContain(retained.policyObserverFile);
        expect(text).toContain('RELAY_POLICY_OBSERVER_LINKS_FILE'); expect(text).toContain(retained.policyObserverLinksFile);
      }
      vi.stubEnv('RESONANCE_RELAY_POLICY_OBSERVER_FILE', '');
      expect(() => relayServiceRuntime(retained)).toThrow('require');
      vi.stubEnv('RESONANCE_RELAY_POLICY_OBSERVER_LINKS_FILE', '');
      expect(relayServiceRuntime(retained)).toMatchObject({ policyObserverFile: '', policyObserverLinksFile: '' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('retains an explicit history collection across GUI restarts and carries only its path into all service definitions', () => {
    vi.stubEnv('RESONANCE_RELAY_ENTRY', '/opt/Resonance/relay.mjs');
    vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', undefined);
    vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_COLLECTION_FILE', undefined);
    const retained = { historyVolunteerCollectionFile: '/private/collection.json' };
    expect(relayServiceRuntime(retained)).toMatchObject(retained);
    expect(() => relayServiceRuntime({ ...retained, historyVolunteerFile: '/private/single.json' })).toThrow('Choose one');
    const directory = mkdtempSync(join(tmpdir(), 'collection-service-'));
    const options: RelayServiceOptions = { dataDir: directory, port: 9091, adminKey: 'test-only', contacts: [],
      nodePath: process.execPath, entryPath: '/opt/Resonance/relay.mjs', workingDirectory: directory, ...retained };
    try {
      expect(relayServiceEnvironment(options)).toMatchObject({ RELAY_HISTORY_VOLUNTEER_COLLECTION_FILE: retained.historyVolunteerCollectionFile, RELAY_HISTORY_VOLUNTEER_FILE: '' });
      for (const text of [macServicePlist(options), linuxServiceUnit(options), windowsServiceScript(options)]) {
        expect(text).toContain('RELAY_HISTORY_VOLUNTEER_COLLECTION_FILE'); expect(text).toContain(retained.historyVolunteerCollectionFile);
      }
      vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_COLLECTION_FILE', '');
      expect(relayServiceRuntime(retained).historyVolunteerCollectionFile).toBe('');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('validates prepared directory paths separately from regular files before any native service action', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-role-paths-')), file = join(directory, 'fixture-file'), history = join(directory, 'history');
    writeFileSync(file, 'path validation fixture'); mkdirSync(history);
    const options: RelayServiceOptions = { dataDir: directory, port: 9091, adminKey: 'test-only', contacts: [],
      nodePath: process.execPath, entryPath: file, workingDirectory: directory,
      admissionHistoryFile: file, admissionAuthorityFile: file, admissionPolicyFile: file, admissionPolicyKeyFile: file,
      admissionHistoryDirectory: history };
    try {
      expect(() => validateRelayServicePaths(options)).not.toThrow();
      expect(() => validateRelayServicePaths({ ...options, admissionHistoryDirectory: file })).toThrow('not a directory');
      expect(() => validateRelayServicePaths({ ...options, admissionHistoryDirectory: join(directory, 'absent') })).toThrow('missing');
      expect(() => validateRelayServicePaths({ ...options, admissionHistoryFile: history })).toThrow('not regular');
      expect(() => validateRelayServicePaths({ ...options, admissionHistoryFile: undefined })).toThrow('require');
      expect(() => validateRelayServicePaths({ ...options, entryPath: history })).toThrow('runtime is missing');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('retains complete owner/bridge paths, applies only explicit overrides and refuses partial admission configuration', () => {
    vi.stubEnv('RESONANCE_RELAY_ENTRY', '/opt/Resonance/relay.mjs');
    const retained = { identityPassphraseFile: '/private/passphrase.txt', historyBridgeFile: '/private/bridge.json', admissionHistoryFile: '/private/history.json',
      admissionHistoryLinksFile: '/private/links.json', admissionAuthorityFile: '/private/authority.pub',
      admissionObserversFile: '/private/observers.json', admissionPolicyAdvanceFile: '/private/policy-advance.json',
      admissionPolicyFile: '/private/policy.json', admissionPolicyKeyFile: '/private/storage.hex', admissionHistoryDirectory: '/private/restored history', publicEndpoints: ['wss://bridge.example/'] };
    for (const variable of ['IDENTITY_PASSPHRASE', 'HISTORY_VOLUNTEER', 'HISTORY_BRIDGE', 'ADMISSION_HISTORY', 'ADMISSION_HISTORY_LINKS', 'ADMISSION_AUTHORITY', 'ADMISSION_POLICY', 'ADMISSION_POLICY_KEY', 'ADMISSION_OBSERVERS', 'ADMISSION_POLICY_ADVANCE']) {
      vi.stubEnv(`RESONANCE_RELAY_${variable}_FILE`, undefined);
    }
    vi.stubEnv('RESONANCE_RELAY_PUBLIC_ENDPOINTS', undefined);
    vi.stubEnv('RESONANCE_RELAY_ADMISSION_HISTORY_DIRECTORY', undefined);
    const runtime = relayServiceRuntime(retained);
    for (const [key, value] of Object.entries(retained)) {
      expect(runtime[key as keyof typeof retained]).toEqual(Array.isArray(value) ? value : resolve(value));
    }
    expect(relayServiceRuntime(JSON.parse(JSON.stringify(runtime)))).toEqual(runtime);
    vi.stubEnv('RESONANCE_RELAY_HISTORY_BRIDGE_FILE', './replacement-bridge.json');
    vi.stubEnv('RESONANCE_RELAY_PUBLIC_ENDPOINTS', '');
    expect(relayServiceRuntime(retained)).toMatchObject({ historyBridgeFile: resolve('./replacement-bridge.json'), publicEndpoints: [] });
    vi.stubEnv('RESONANCE_RELAY_ADMISSION_POLICY_KEY_FILE', '');
    expect(() => relayServiceRuntime(retained)).toThrow(/all three/);
    expect(() => relayServiceRuntime({ admissionHistoryLinksFile: '/private/links.json' })).toThrow(/require/);
    expect(() => relayServiceRuntime({ admissionHistoryDirectory: '/private/restored' })).toThrow(/require/);
    expect(() => relayServiceRuntime({ historyVolunteerFile: '/private/config\nEnvironment=UNSAFE' })).toThrow(/path/);
    vi.stubEnv('RESONANCE_RELAY_PUBLIC_ENDPOINTS', 'ws://public.example/');
    expect(() => relayServiceRuntime()).toThrow();
  });
  it('preserves enrollment across GUI restarts and distinguishes an explicit disable from a missing override', () => {
    vi.stubEnv('RESONANCE_RELAY_ENTRY', '/opt/Resonance/relay.mjs');
    vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', undefined);
    const retained = { historyVolunteerFile: '/private/retained-volunteer.json' };
    expect(relayServiceRuntime(retained).historyVolunteerFile).toBe(resolve('/private/retained-volunteer.json'));
    expect(relayServiceRuntime().historyVolunteerFile).toBeUndefined();
    vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', '/private/replacement.json');
    expect(relayServiceRuntime(retained).historyVolunteerFile).toBe(resolve('/private/replacement.json'));
    vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', '');
    expect(relayServiceRuntime(retained).historyVolunteerFile).toBe('');
  });
  it('keeps relay credentials in a user service that restarts independently of the UI', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resonance-service-'));
    const options: RelayServiceOptions = {
      port: 9091, dataDir, adminKey: 'private<&"key',
      contacts: ['wss://relay.example/one?tag=a&b=2'],
      nodePath: '/opt/Resonance/node', entryPath: '/opt/Resonance/relay.mjs',
      workingDirectory: '/opt/Resonance',
      historyVolunteerFile: "/private/owner's history/volunteer.json",
      historyBridgeFile: '/private/bridge.json', admissionHistoryFile: '/private/history.json',
      admissionHistoryLinksFile: '/private/links.json', admissionAuthorityFile: '/private/authority.pub',
      admissionPolicyFile: '/private/policy.json', admissionPolicyKeyFile: '/private/storage.hex',
      admissionHistoryDirectory: '/private/restored history',
      publicEndpoints: ['wss://bridge.example/'],
      identityPassphraseFile: '/private/identity-passphrase.txt',
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
      expect(mac).toContain('<key>StandardOutPath</key><string>/dev/null</string>');
      expect(mac).toContain('<key>StandardErrorPath</key><string>/dev/null</string>');
      expect(mac).not.toContain('relay-service.log');
      expect(mac).toContain('RELAY_DIAGNOSTICS_DIRECTORY');
      expect(mac).toContain('RELAY_NEW_WORK_CPU_MS_PER_MINUTE');
      expect(mac).toContain('RELAY_TOTAL_BANDWIDTH_BYTES_PER_HOUR');
      expect(mac).toContain('<key>RELAY_HISTORY_VOLUNTEER_FILE</key><string>/private/owner&apos;s history/volunteer.json</string>');

      const linux = linuxServiceUnit(options);
      expect(linux).toContain('Restart=always');
      expect(linux).toContain('StandardOutput=null\nStandardError=null');
      expect(linux).toContain('ExecStart="/opt/Resonance/node" "/opt/Resonance/relay.mjs"');
      expect(linux).not.toContain('server.mjs');
      expect(linux).toContain("Environment=\"RELAY_HISTORY_VOLUNTEER_FILE=/private/owner's history/volunteer.json\"");

      const windows = windowsServiceTask(options);
      const script = windowsServiceScript(options);
      expect(windows).toContain('<RestartOnFailure><Interval>PT1M</Interval><Count>255</Count>');
      expect(windows).toContain('<LogonTrigger>');
      expect(script).toContain("$env:RELAY_ADMIN_API_KEY='private<&\"key';");
      expect(script).toContain("& '/opt/Resonance/node' '/opt/Resonance/relay.mjs' 1>$null 2>$null");
      expect(script).toContain("$env:RELAY_ACTIVE_HOURS='08:00-22:00';");
      expect(script).toContain("$env:RELAY_HISTORY_VOLUNTEER_FILE='/private/owner''s history/volunteer.json';");
      for (const [variable, value] of Object.entries(relayServiceEnvironment(options))) {
        if (!variable.includes('HISTORY') && !variable.includes('POLICY') && !variable.includes('AUTHORITY') && !variable.includes('PASSPHRASE') && variable !== 'RELAY_PUBLIC_ENDPOINTS') continue;
        expect(mac).toContain(variable); expect(linux).toContain(variable); expect(script).toContain(variable);
        if (value && !value.includes("'")) for (const output of [mac, linux, script]) expect(output).toContain(value);
      }
      expect(relayServiceEnvironment(options)).toMatchObject({ RELAY_ADMISSION_POLICY_INITIALIZE: 'false', RELAY_ADMISSION_WITNESS_INITIALIZE: 'false', RELAY_DIAGNOSTICS_DIRECTORY: join(dataDir, 'relay-diagnostics') });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
