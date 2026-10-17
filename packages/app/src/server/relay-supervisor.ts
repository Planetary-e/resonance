/** Install the volunteer relay as a user-level service, independent of the GUI. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';

const LABEL = 'earth.planetary.resonance.relay';

const SERVICE_FILES = {
  identityPassphraseFile: 'RELAY_IDENTITY_PASSPHRASE_FILE',
  historyVolunteerFile: 'RELAY_HISTORY_VOLUNTEER_FILE',
  historyBridgeFile: 'RELAY_HISTORY_BRIDGE_FILE',
  admissionHistoryFile: 'RELAY_ADMISSION_HISTORY_FILE',
  admissionHistoryLinksFile: 'RELAY_ADMISSION_HISTORY_LINKS_FILE',
  admissionAuthorityFile: 'RELAY_ADMISSION_AUTHORITY_FILE',
  admissionPolicyFile: 'RELAY_ADMISSION_POLICY_FILE',
  admissionPolicyKeyFile: 'RELAY_ADMISSION_POLICY_KEY_FILE',
} as const;
type ServiceFile = keyof typeof SERVICE_FILES;
export type RelayServiceRoleFiles = Partial<Record<ServiceFile, string>>;

export interface RelayServiceOptions extends RelayServiceRoleFiles {
  port: number;
  dataDir: string;
  adminKey: string;
  contacts: string[];
  nodePath: string;
  entryPath: string;
  workingDirectory: string;
  nodePathEnv?: string;
  tsxImportPath?: string;
  /** A separately configured TLS proxy must expose these endpoints to peers. */
  publicEndpoints?: string[];
  controls?: RelayOwnerControls;
}

export interface RelayOwnerControls {
  publicationStorageMiB?: number;
  newWorkIngressMiBPerHour?: number;
  totalBandwidthMiBPerHour?: number;
  cpuMillisecondsPerMinute?: number;
  activeHours?: string;
  onlyWhenCharging?: boolean;
}

function validateRoleFiles(files: RelayServiceRoleFiles): void {
  for (const key of Object.keys(SERVICE_FILES) as ServiceFile[]) {
    const path = files[key];
    if (path !== undefined && (typeof path !== 'string' || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) {
      throw new Error('Invalid relay role configuration path');
    }
  }
  const policy = [files.admissionAuthorityFile, files.admissionPolicyFile, files.admissionPolicyKeyFile];
  if ((policy.some(Boolean) && !policy.every(Boolean)) || (files.admissionHistoryFile && !policy.every(Boolean))
    || (files.admissionHistoryLinksFile && !files.admissionHistoryFile)) {
    throw new Error('Protected admission requires its history and all three signed-policy files; relay links also require history');
  }
}

function validatePublicEndpoints(endpoints: string[]): void {
  if (!Array.isArray(endpoints) || endpoints.length > 8 || new Set(endpoints).size !== endpoints.length) {
    throw new Error('Relay public endpoints must be distinct and bounded');
  }
  for (const endpoint of endpoints) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\x00-\x20\x7f]/.test(endpoint)) throw new Error('Invalid relay public endpoint');
    assertSecureRelayTransportEndpoint(endpoint);
  }
  if (new Set(endpoints.map(endpoint => new URL(endpoint).href)).size !== endpoints.length) throw new Error('Duplicate relay public endpoint');
}

export function relayServiceRuntime(retained: RelayServiceRoleFiles & { publicEndpoints?: string[] } = {}): Pick<RelayServiceOptions,
  'nodePath' | 'entryPath' | 'workingDirectory' | 'nodePathEnv' | 'tsxImportPath' | 'publicEndpoints'> & RelayServiceRoleFiles {
  const entryPath = process.env.RESONANCE_RELAY_ENTRY
    ?? resolve(process.cwd(), '../relay/src/main.ts');
  // Preserve an enrolled service across GUI launches without the original environment.
  // An explicit empty override disables participation without deleting retained state.
  const files: RelayServiceRoleFiles = {};
  for (const key of Object.keys(SERVICE_FILES) as ServiceFile[]) {
    const value = process.env[`RESONANCE_${SERVICE_FILES[key]}`] ?? retained[key];
    files[key] = value;
  }
  validateRoleFiles(files);
  for (const key of Object.keys(SERVICE_FILES) as ServiceFile[]) if (files[key]) files[key] = resolve(files[key]!);
  const endpointOverride = process.env.RESONANCE_RELAY_PUBLIC_ENDPOINTS;
  const publicEndpoints = endpointOverride === undefined ? retained.publicEndpoints ?? []
    : endpointOverride.split(',').map(value => value.trim()).filter(Boolean);
  validatePublicEndpoints(publicEndpoints);
  if (publicEndpoints.some(endpoint => new URL(endpoint).protocol === 'wss:') && !files.identityPassphraseFile) {
    throw new Error('A reachable WSS service requires an identity passphrase file');
  }
  return {
    nodePath: process.env.RESONANCE_RELAY_NODE ?? process.execPath,
    entryPath,
    workingDirectory: process.env.RESONANCE_RELAY_CWD ?? process.cwd(),
    nodePathEnv: process.env.NODE_PATH,
    tsxImportPath: entryPath.endsWith('.ts') ? createRequire(import.meta.url).resolve('tsx') : undefined,
    ...files, publicEndpoints: [...publicEndpoints],
  };
}

function command(options: RelayServiceOptions): string[] {
  return [options.nodePath,
    ...(options.entryPath.endsWith('.ts') ? ['--import', options.tsxImportPath ?? 'tsx'] : []),
    options.entryPath];
}

export function relayServiceEnvironment(options: RelayServiceOptions): Record<string, string> {
  validateRoleFiles(options); validatePublicEndpoints(options.publicEndpoints ?? []);
  if (options.publicEndpoints?.some(endpoint => new URL(endpoint).protocol === 'wss:') && !options.identityPassphraseFile) {
    throw new Error('A reachable WSS service requires an identity passphrase file');
  }
  const controls = options.controls ?? {};
  const publicationBytes = controls.publicationStorageMiB === undefined ? undefined
    : String(controls.publicationStorageMiB * 1_048_576);
  return {
    RELAY_PORT: String(options.port),
    RELAY_HOST: '127.0.0.1',
    RELAY_DATA_DIR: join(options.dataDir, 'relay-data'),
    RELAY_CONTACTS: options.contacts.join(','),
    // Explicit empty values also prevent inheriting an obsolete role from the service manager.
    ...Object.fromEntries(Object.entries(SERVICE_FILES).map(([key, variable]) => [variable, options[key as ServiceFile] ?? ''])),
    RELAY_PUBLIC_ENDPOINTS: (options.publicEndpoints ?? []).join(','),
    RELAY_IDENTITY_PASSPHRASE: '',
    RELAY_ADMISSION_POLICY_INITIALIZE: 'false',
    RELAY_ADMISSION_WITNESS_INITIALIZE: 'false',
    ...(publicationBytes ? {
      RELAY_STORAGE_CAPACITY_BYTES: publicationBytes,
      RELAY_STORAGE_AVAILABLE_BYTES: publicationBytes,
      RELAY_PUBLICATION_STORAGE_QUOTA_BYTES: publicationBytes,
    } : {}),
    ...(controls.newWorkIngressMiBPerHour === undefined ? {} : {
      RELAY_NEW_WORK_BANDWIDTH_BYTES_PER_HOUR:
        String(controls.newWorkIngressMiBPerHour * 1_048_576),
    }),
    ...(controls.totalBandwidthMiBPerHour === undefined ? {} : {
      RELAY_TOTAL_BANDWIDTH_BYTES_PER_HOUR:
        String(controls.totalBandwidthMiBPerHour * 1_048_576),
    }),
    ...(controls.cpuMillisecondsPerMinute === undefined ? {} : {
      RELAY_NEW_WORK_CPU_MS_PER_MINUTE: String(controls.cpuMillisecondsPerMinute),
    }),
    ...(controls.activeHours ? { RELAY_ACTIVE_HOURS: controls.activeHours } : {}),
    ...(controls.onlyWhenCharging ? { RELAY_ONLY_WHEN_CHARGING: 'true' } : {}),
    ...(options.nodePathEnv ? { NODE_PATH: options.nodePathEnv } : {}),
    RELAY_ADMIN_API_KEY: options.adminKey,
  };
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function macServicePlist(options: RelayServiceOptions): string {
  const args = command(options).map(value => `    <string>${xml(value)}</string>`).join('\n');
  const env = Object.entries(relayServiceEnvironment(options))
    .map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`).join('\n');
  const logPath = join(options.dataDir, 'relay-service.log');
  return `<?xml version="1.0" encoding="UTF-8"?>\n`+
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`+
    `<plist version="1.0"><dict>\n`+
    `  <key>Label</key><string>${LABEL}</string>\n`+
    `  <key>ProgramArguments</key><array>\n${args}\n  </array>\n`+
    `  <key>WorkingDirectory</key><string>${xml(options.workingDirectory)}</string>\n`+
    `  <key>EnvironmentVariables</key><dict>\n${env}\n  </dict>\n`+
    `  <key>StandardOutPath</key><string>${xml(logPath)}</string>\n`+
    `  <key>StandardErrorPath</key><string>${xml(logPath)}</string>\n`+
    `  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n`+
    `</dict></plist>\n`;
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

export function linuxServiceUnit(options: RelayServiceOptions): string {
  const env = Object.entries(relayServiceEnvironment(options))
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n');
  return `[Unit]\nDescription=Resonance volunteer relay\n`+
    `[Service]\nType=simple\nWorkingDirectory=${systemdQuote(options.workingDirectory)}\n`+
    `${env}\nExecStart=${command(options).map(systemdQuote).join(' ')}\n`+
    `Restart=always\nRestartSec=5\n`+
    `[Install]\nWantedBy=default.target\n`;
}

function windowsArg(value: string): string {
  return `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, match => match + match)}"`;
}

export function windowsServiceTask(options: RelayServiceOptions): string {
  const args = command(options);
  const env = Object.entries(relayServiceEnvironment(options))
    .map(([key, value]) => `$env:${key}='${value.replaceAll("'", "''")}';`).join(' ');
  // The task runs a generated PowerShell script so environment values never
  // pass through cmd.exe, and it restarts the relay after crashes.
  const script = join(options.dataDir, 'relay-service.ps1');
  writeFileSync(script,
    `${env}\n& ${args.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}\nexit $LASTEXITCODE\n`,
    { mode: 0o600 },
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n`+
    `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`+
    `<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>`+
    `<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType>`+
    `<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`+
    `<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`+
    `<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`+
    `<RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>`+
    `</Settings><Actions Context="Author"><Exec>`+
    `<Command>powershell.exe</Command>`+
    `<Arguments>${xml(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${windowsArg(script)}`)}</Arguments>`+
    `<WorkingDirectory>${xml(options.workingDirectory)}</WorkingDirectory>`+
    `</Exec></Actions></Task>`;
}

function run(program: string, args: string[]): void {
  execFileSync(program, args, { timeout: 15_000, stdio: 'pipe' });
}

export function installRelayService(options: RelayServiceOptions): void {
  if (!existsSync(options.nodePath) || !existsSync(options.entryPath)) {
    throw new Error('The bundled relay runtime is missing');
  }
  relayServiceEnvironment(options); // Validate the complete configuration before stopping an existing service.
  for (const key of Object.keys(SERVICE_FILES) as ServiceFile[]) {
    const path = options[key];
    if (path && (!existsSync(path) || !statSync(path).isFile())) throw new Error('A relay role configuration file is missing or not regular');
  }
  mkdirSync(options.dataDir, { recursive: true });
  if (process.platform === 'darwin') {
    const path = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
    mkdirSync(dirname(path), { recursive: true });
    const domain = `gui/${process.getuid?.()}`;
    try { run('launchctl', ['bootout', domain, path]); } catch { /* absent */ }
    writeFileSync(path, macServicePlist(options), { mode: 0o600 });
    run('launchctl', ['bootstrap', domain, path]);
    run('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
  } else if (process.platform === 'linux') {
    const path = join(homedir(), '.config/systemd/user', 'resonance-relay.service');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, linuxServiceUnit(options), { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'resonance-relay.service']);
    run('systemctl', ['--user', 'restart', 'resonance-relay.service']);
  } else if (process.platform === 'win32') {
    const path = join(options.dataDir, 'relay-service.xml');
    writeFileSync(path, windowsServiceTask(options), { mode: 0o600 });
    try { run('schtasks.exe', ['/End', '/TN', 'ResonanceRelay']); } catch { /* absent */ }
    run('schtasks.exe', ['/Create', '/F', '/TN', 'ResonanceRelay', '/XML', path]);
    run('schtasks.exe', ['/Run', '/TN', 'ResonanceRelay']);
  } else {
    throw new Error(`Unsupported relay service platform: ${process.platform}`);
  }
}

export function uninstallRelayService(): void {
  if (process.platform === 'darwin') {
    const path = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
    try { run('launchctl', ['bootout', `gui/${process.getuid?.()}`, path]); } catch { /* absent */ }
    rmSync(path, { force: true });
  } else if (process.platform === 'linux') {
    const path = join(homedir(), '.config/systemd/user', 'resonance-relay.service');
    try { run('systemctl', ['--user', 'disable', '--now', 'resonance-relay.service']); } catch { /* absent */ }
    rmSync(path, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (process.platform === 'win32') {
    try { run('schtasks.exe', ['/End', '/TN', 'ResonanceRelay']); } catch { /* absent */ }
    try { run('schtasks.exe', ['/Delete', '/F', '/TN', 'ResonanceRelay']); } catch { /* absent */ }
  }
}

export async function relayServiceStats(port: number, adminKey: string): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return; settled = true; clearTimeout(deadline); resolve(value);
    };
    const req = request({
      hostname: '127.0.0.1', port,
      path: `/stats?key=${encodeURIComponent(adminKey)}`,
      method: 'GET', timeout: 1_000,
    }, response => {
      if (response.statusCode !== 200) { finish(null); response.destroy(); return; }
      let body = '', bytes = 0;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 100_000) { finish(null); req.destroy(); } else body += chunk;
      });
      response.on('aborted', () => finish(null));
      response.on('error', () => finish(null));
      response.on('end', () => {
        try {
          const value: unknown = JSON.parse(body);
          finish(value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
        } catch { finish(null); }
      });
    });
    const deadline = setTimeout(() => { finish(null); req.destroy(); }, 1000);
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(null));
    req.end();
  });
}
