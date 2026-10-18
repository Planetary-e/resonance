/** Install the volunteer relay as a user-level service, independent of the GUI. */

import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync, statSync, type Stats } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { assertNoStorageReservationContext } from '@resonance/core/storage-reservations';
import { reserveOperatorAtomicOutput, writeOperatorTextAtomic, readRelayStorageSnapshot, assertStoppedRelayStorageOwner } from '@resonance/relay';
import { readPolicyObserverConfigurationFile } from '../../../relay/src/policy-observer-config.js';
import { parseAdmissionHistoryConfiguration, readAdmissionHistoryLinksFile } from '../../../relay/src/admission-history-config.js';
import { readOperatorJson } from '../../../relay/src/admission-operator-files.js';
import { shareHistoryOwnerRoutes } from '../../../relay/src/history-owner-routing.js';
export const RELAY_SERVICE_FILE_MAX_BYTES = 1024 * 1024;

export const RELAY_SERVICE_LABEL = 'earth.planetary.resonance.relay';
const LABEL = RELAY_SERVICE_LABEL;

const SERVICE_FILES = {
  storageSelectionFile: 'RELAY_STORAGE_SELECTION_FILE',
  identityPassphraseFile: 'RELAY_IDENTITY_PASSPHRASE_FILE',
  historyVolunteerFile: 'RELAY_HISTORY_VOLUNTEER_FILE',
  historyVolunteerCollectionFile: 'RELAY_HISTORY_VOLUNTEER_COLLECTION_FILE',
  policyObserverFile: 'RELAY_POLICY_OBSERVER_FILE',
  policyObserverLinksFile: 'RELAY_POLICY_OBSERVER_LINKS_FILE',
  historyBridgeFile: 'RELAY_HISTORY_BRIDGE_FILE',
  admissionHistoryFile: 'RELAY_ADMISSION_HISTORY_FILE',
  admissionHistoryDirectory: 'RELAY_ADMISSION_HISTORY_DIRECTORY',
  admissionHistoryLinksFile: 'RELAY_ADMISSION_HISTORY_LINKS_FILE',
  admissionAuthorityFile: 'RELAY_ADMISSION_AUTHORITY_FILE',
  admissionPolicyFile: 'RELAY_ADMISSION_POLICY_FILE',
  admissionPolicyKeyFile: 'RELAY_ADMISSION_POLICY_KEY_FILE',
  admissionObserversFile: 'RELAY_ADMISSION_OBSERVERS_FILE',
  admissionPolicyAdvanceFile: 'RELAY_ADMISSION_POLICY_ADVANCE_FILE',
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
  if (files.historyVolunteerFile && files.historyVolunteerCollectionFile) throw new Error('Choose one volunteer role configuration or collection');
  if (files.policyObserverLinksFile && !files.policyObserverFile) throw new Error('Policy observer links require an observer configuration');
  const policy = [files.admissionAuthorityFile, files.admissionPolicyFile, files.admissionPolicyKeyFile];
  if ((policy.some(Boolean) && !policy.every(Boolean)) || (files.admissionHistoryFile && !policy.every(Boolean))
    || ((files.admissionObserversFile || files.admissionPolicyAdvanceFile) && !policy.every(Boolean))
    || ((files.admissionHistoryLinksFile || files.admissionHistoryDirectory) && !files.admissionHistoryFile)) {
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

export function relayServiceRuntime(retained: RelayServiceRoleFiles & { publicEndpoints?: string[] } = {}, reviewed: RelayServiceRoleFiles = {}): Pick<RelayServiceOptions,
  'nodePath' | 'entryPath' | 'workingDirectory' | 'nodePathEnv' | 'tsxImportPath' | 'publicEndpoints'> & RelayServiceRoleFiles {
  const entryPath = process.env.RESONANCE_RELAY_ENTRY
    ?? resolve(process.cwd(), '../relay/src/main.ts');
  // Preserve an enrolled service across GUI launches without the original environment.
  // An explicit empty override disables participation without deleting retained state.
  const files: RelayServiceRoleFiles = {};
  for (const key of Object.keys(SERVICE_FILES) as ServiceFile[]) {
    const value = Object.hasOwn(reviewed, key) ? reviewed[key] : process.env[`RESONANCE_${SERVICE_FILES[key]}`] ?? retained[key];
    files[key] = key === 'storageSelectionFile' && value === '' ? undefined : value;
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
    tsxImportPath: entryPath.endsWith('.ts') ? pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href : undefined,
    ...files, publicEndpoints: [...publicEndpoints],
  };
}

function command(options: RelayServiceOptions): string[] {
  const selected = options.tsxImportPath ?? 'tsx';
  const loader = isAbsolute(selected) ? pathToFileURL(selected).href : selected;
  return [options.nodePath,
    ...(options.entryPath.endsWith('.ts') ? ['--import', loader] : []),
    options.entryPath];
}

export function relayServiceEnvironment(options: RelayServiceOptions): Record<string, string> {
  validateRoleFiles(options); validatePublicEndpoints(options.publicEndpoints ?? []);
  if (options.publicEndpoints?.some(endpoint => new URL(endpoint).protocol === 'wss:') && !options.identityPassphraseFile) {
    throw new Error('A reachable WSS service requires an identity passphrase file');
  }
  if (options.storageSelectionFile) {
    const selected = readRelayStorageSnapshot(options.storageSelectionFile).configuration;
    if (resolve(selected.runtimeDirectory) !== resolve(join(options.dataDir, 'relay-data'))
      || selected.runtimePort !== options.port || selected.runtimeHost !== '127.0.0.1') throw new Error('Service settings differ from their storage selection');
  }
  const controls = options.controls ?? {};
  const publicationBytes = controls.publicationStorageMiB === undefined ? undefined
    : String(controls.publicationStorageMiB * 1_048_576);
  return {
    RELAY_PORT: String(options.port),
    RELAY_HOST: '127.0.0.1',
    RELAY_DATA_DIR: join(options.dataDir, 'relay-data'),
    RELAY_DIAGNOSTICS_DIRECTORY: join(options.dataDir, 'relay-diagnostics'),
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
  // Structured startup/runtime diagnostics have their own bounded files. Never
  // append arbitrary process output to an unlimited supervisor-owned file.
  const logPath = '/dev/null';
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
    `[Service]\nType=simple\nStandardOutput=null\nStandardError=null\nWorkingDirectory=${systemdQuote(options.workingDirectory)}\n`+
    `${env}\nExecStart=${command(options).map(systemdQuote).join(' ')}\n`+
    `Restart=always\nRestartSec=5\n`+
    `[Install]\nWantedBy=default.target\n`;
}

function windowsArg(value: string): string {
  return `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, match => match + match)}"`;
}

export function windowsServiceScript(options: RelayServiceOptions): string {
  const args = command(options);
  const env = Object.entries(relayServiceEnvironment(options))
    .map(([key, value]) => `$env:${key}='${value.replaceAll("'", "''")}';`).join(' ');
  return `${env}\n& ${args.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')} 1>$null 2>$null\nexit $LASTEXITCODE\n`;
}
export function windowsServiceTask(options: RelayServiceOptions): string {
  relayServiceEnvironment(options);
  // Rendering is pure: all definitions are validated and reserved before output.
  const script = join(options.dataDir, 'relay-service.ps1');
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

/** Read-only preparation shared with reviewed desktop activation. */
export function validateRelayServicePaths(options: RelayServiceOptions): void {
  if (![options.nodePath, options.entryPath].every(path => existsSync(path) && statSync(path).isFile())) {
    throw new Error('The bundled relay runtime is missing');
  }
  relayServiceEnvironment(options); // Validate the complete configuration before stopping an existing service.
  for (const key of Object.keys(SERVICE_FILES) as ServiceFile[]) {
    const path = options[key];
    if (!path) continue;
    if (key === 'admissionHistoryDirectory') {
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('The prepared protected history directory is missing or is not a directory');
    } else if (!existsSync(path) || !statSync(path).isFile()) throw new Error('A relay role configuration file is missing or not regular');
  }
  if (options.policyObserverFile && options.policyObserverLinksFile && options.admissionHistoryFile && options.admissionHistoryLinksFile) {
    const observer = readPolicyObserverConfigurationFile(options.policyObserverFile);
    const owner = parseAdmissionHistoryConfiguration(readOperatorJson(options.admissionHistoryFile, 65536));
    shareHistoryOwnerRoutes(readAdmissionHistoryLinksFile(options.admissionHistoryLinksFile, owner.context).members,
      readAdmissionHistoryLinksFile(options.policyObserverLinksFile, observer.historyContext).members);
  }
  relayServiceOutputFiles(options); // Rendering/encoded limits are part of read-only preparation too.
}

/** Exact native paths, without rendering configuration or touching the filesystem. */
export function relayServiceOutputPaths(dataDir: string, platform: NodeJS.Platform = process.platform, userDirectory = homedir()): string[] {
  if (platform === 'darwin') return [join(userDirectory, 'Library/LaunchAgents', `${LABEL}.plist`)];
  if (platform === 'linux') return [join(userDirectory, '.config/systemd/user', 'resonance-relay.service')];
  if (platform === 'win32') return [join(dataDir, 'relay-service.ps1'), join(dataDir, 'relay-service.xml')];
  throw new Error(`Unsupported relay service platform: ${platform}`);
}
/** Exact generated files only; operating-system service databases are outside this budget. */
export function relayServiceOutputFiles(options: RelayServiceOptions, platform: NodeJS.Platform = process.platform, userDirectory = homedir()) {
  const paths = relayServiceOutputPaths(options.dataDir, platform, userDirectory);
  const texts = platform === 'darwin' ? [macServicePlist(options)] : platform === 'linux' ? [linuxServiceUnit(options)]
    : [windowsServiceScript(options), windowsServiceTask(options)];
  const files = paths.map((path, i) => ({ path, text: texts[i] }));
  if (files.some(file => Buffer.byteLength(file.text) > RELAY_SERVICE_FILE_MAX_BYTES)) throw new Error('Relay service definition exceeds its encoded byte limit');
  return files;
}
/** Verify exact bounded bytes and the published inode before starting native
 * supervision. Desktop control exclusion must span preparation and start. */
function servicePublication(file: { path: string; text: string }): string {
  const ordinary = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= RELAY_SERVICE_FILE_MAX_BYTES;
  const stamp = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.nlink}`;
  const before = lstatSync(file.path), resolved = realpathSync(file.path);
  if (!ordinary(before)) throw new Error('Prepared relay service definition is not a bounded ordinary file');
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  const bytes = Buffer.alloc(RELAY_SERVICE_FILE_MAX_BYTES + 1);
  try {
    const opened = fstatSync(fd);
    if (!ordinary(opened) || stamp(opened) !== stamp(before)) throw new Error('Prepared relay service definition changed');
    let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    const after = fstatSync(fd), named = lstatSync(file.path);
    if (!ordinary(named) || stamp(after) !== stamp(opened) || stamp(named) !== stamp(opened)
      || realpathSync(file.path) !== resolved || used !== opened.size || !bytes.subarray(0, used).equals(Buffer.from(file.text))) {
      throw new Error('Prepared relay service definition changed');
    }
    return `${resolved}:${stamp(opened)}`;
  } finally { bytes.fill(0); closeSync(fd); }
}

/** Publish definitions while holding the storage authority, then release it
 * before calling start(). The returned handle performs no application file writes.
 * Native commands do not establish runtime/admission readiness. */
export function prepareRelayServiceInstallation(options: RelayServiceOptions): { start(): void } {
  validateRelayServicePaths(options);
  const selectionFile = options.storageSelectionFile, selected = selectionFile ? readRelayStorageSnapshot(selectionFile) : undefined;
  if (selected) assertStoppedRelayStorageOwner(selected.configuration);
  const selection = selected?.source;
  const host = process.platform, domain = `gui/${process.getuid?.()}`, files = relayServiceOutputFiles(options);
  // A later file cannot exhaust the shared budget after an earlier one was written.
  const reserved = files.map(file => ({ ...file, reservation: reserveOperatorAtomicOutput(file.path, RELAY_SERVICE_FILE_MAX_BYTES) }));
  for (const file of reserved) writeOperatorTextAtomic(file.path, file.text, RELAY_SERVICE_FILE_MAX_BYTES, file.reservation);
  const published = files.map(file => ({ ...file, stamp: servicePublication(file) }));
  let started = false;
  return { start() {
    assertNoStorageReservationContext('Release the storage authority and leave its scope before starting the relay service');
    if (started) throw new Error('Relay service start was already attempted; prepare and review the current configuration again');
    if (process.platform !== host) throw new Error('Prepared relay service platform changed');
    for (const file of published) if (servicePublication(file) !== file.stamp) throw new Error('Prepared relay service definition changed');
    if (selectionFile && JSON.stringify(readRelayStorageSnapshot(selectionFile).source) !== JSON.stringify(selection)) {
      throw new Error('Prepared relay storage selection changed');
    }
    // Partial native registration can have effects even if its command throws.
    // Never retry a stale handle after a start attempt.
    started = true;
    if (host === 'darwin') {
      const path = files[0].path;
      try { run('launchctl', ['bootout', domain, path]); } catch { /* absent */ }
      run('launchctl', ['bootstrap', domain, path]);
      run('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
    } else if (host === 'linux') {
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', 'resonance-relay.service']);
      run('systemctl', ['--user', 'restart', 'resonance-relay.service']);
    } else if (host === 'win32') {
      const path = files.find(file => file.path.endsWith('.xml'))!.path;
      try { run('schtasks.exe', ['/End', '/TN', 'ResonanceRelay']); } catch { /* absent */ }
      run('schtasks.exe', ['/Create', '/F', '/TN', 'ResonanceRelay', '/XML', path]);
      run('schtasks.exe', ['/Run', '/TN', 'ResonanceRelay']);
    }
  } };
}

/** Convenience for callers without a managed authority. Managed callers must
 * prepare and start separately, keeping desktop control exclusion throughout. */
export function installRelayService(options: RelayServiceOptions): void {
  assertNoStorageReservationContext('Prepare the relay service separately and release its storage authority before starting');
  prepareRelayServiceInstallation(options).start();
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

export { relayPortClosed } from '@resonance/relay';
