/** Checked native stop for storage activation. The caller retains desktop/runtime
 * exclusion and maintenance. This only stops supervision; it preserves definitions
 * and does not prove protocol readiness or authorize clearing maintenance. */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:os';
import { assertNoStorageReservationContext } from '@resonance/core/storage-reservations';
import { RELAY_SERVICE_LABEL } from './relay-supervisor.js';
const UNIT = 'resonance-relay.service';
const WINDOWS_STOP = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tasks = @(Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq 'ResonanceRelay' })
if ($tasks.Count -gt 1) { throw 'Ambiguous relay task' }
if ($tasks.Count -eq 1) {
  if ($tasks[0].State -notin @('Ready', 'Disabled')) { Stop-ScheduledTask -InputObject $tasks[0] -ErrorAction Stop | Out-Null }
  Unregister-ScheduledTask -InputObject $tasks[0] -Confirm:$false -ErrorAction Stop | Out-Null
}
$remaining = @(Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq 'ResonanceRelay' })
if ($remaining.Count -ne 0) { throw 'Relay task remains registered' }
[Console]::Out.Write('{"state":"absent"}')`;

export function stopRelayServiceForStorageActivation(platform: NodeJS.Platform = process.platform): void {
  assertNoStorageReservationContext('Leave the managed writer scope before changing native supervision');
  const deadline = performance.now() + 15000;
  const command = (program: string, args: string[]) => {
    const timeout = Math.floor(deadline - performance.now());
    if (timeout < 1) throw new Error('Native relay stop exceeded its deadline');
    const output = execFileSync(program, args, { timeout, maxBuffer: 256 * 1024, stdio: 'pipe', encoding: 'utf8' });
    if (Buffer.byteLength(output) > 256 * 1024 || output.includes('\0')) throw new Error('Invalid native relay stop output');
    return output.trim();
  };
  try {
    if (platform === 'darwin') {
      const uid = process.getuid?.(); if (!Number.isSafeInteger(uid)) throw new Error('Missing GUI user identity');
      try { command('launchctl', ['bootout', `gui/${uid}/${RELAY_SERVICE_LABEL}`]); }
      catch (error) {
        // launchctl returns a decodable error code. Only ESRCH (no such
        // service/process) is idempotent; permissions, I/O and timeouts refuse.
        if ((error as { status?: number }).status !== constants.errno.ESRCH) throw error;
      }
    } else if (platform === 'linux') {
      const units = () => {
        const text = command('systemctl', ['--user', 'list-units', '--all', '--full', '--no-legend', '--no-pager', '--plain', UNIT]);
        if (!text) return null;
        const lines = text.split(/\r?\n/); if (lines.length !== 1) throw new Error('Ambiguous relay units');
        const fields = lines[0].trim().split(/\s+/);
        if (fields.length < 4 || fields[0] !== UNIT || !fields.slice(1, 4).every(value => /^[a-z-]+$/.test(value))) throw new Error('Invalid relay unit state');
        return { load: fields[1], active: fields[2] };
      };
      const registration = () => {
        const text = command('systemctl', ['--user', 'list-unit-files', '--full', '--no-legend', '--no-pager', UNIT]);
        if (!text) return null;
        const lines = text.split(/\r?\n/); if (lines.length !== 1) throw new Error('Ambiguous relay unit files');
        const fields = lines[0].trim().split(/\s+/);
        if (fields.length < 2 || fields.length > 3 || fields[0] !== UNIT || !/^[a-z-]+$/.test(fields[1])) throw new Error('Invalid relay registration');
        return fields[1];
      };
      const previous = units(), registered = registration();
      if (registered) command('systemctl', ['--user', 'disable', '--now', UNIT]);
      else if (previous) command('systemctl', ['--user', 'stop', UNIT]);
      const after = units(), registrationAfter = registration();
      if (after && !['inactive', 'failed'].includes(after.active) || registrationAfter !== null && registrationAfter !== 'disabled') throw new Error('Relay supervision is still active or uncertain');
    } else if (platform === 'win32') {
      const output = command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_STOP]);
      if (output !== '{"state":"absent"}') throw new Error('Windows relay task removal is unconfirmed');
    } else throw new Error('Unsupported native relay service platform');
  } catch {
    // Native stderr can contain private paths and commands. Keep it out of API
    // errors, and never reinterpret an unknown native failure as absence.
    throw new Error('Native relay supervision could not be confirmed stopped; retain maintenance and retry');
  }
}
