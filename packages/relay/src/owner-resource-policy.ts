/** Owner limits apply to discretionary new work; retained obligations remain serviceable. */

import { execFileSync } from 'node:child_process';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const POLICY_FILE = 'relay-owner-budget.json';

export interface OwnerResourcePolicyOptions {
  maxNewWorkIngressBytesPerHour?: number;
  /** Observed TCP plus LAN payload traffic; exceeding it pauses discretionary work. */
  maxTotalBandwidthBytesPerHour?: number;
  maxCpuMillisecondsPerMinute?: number;
  activeHours?: string;
  requireExternalPower?: boolean;
  now?: () => number;
  cpuMicros?: () => number;
  totalBandwidthBytes?: () => number;
  /** Persist the measured counter before granting more discretionary work. */
  checkpointUsage?: () => void;
  persistDir?: string;
  externalPower?: () => boolean;
}

export class OwnerResourcePolicy {
  private readonly now: () => number;
  private readonly cpuMicros: () => number;
  private readonly externalPower: () => boolean;
  private readonly schedule: { start: number; end: number } | null;
  private hourStarted: number;
  private minuteStarted: number;
  private minuteCpuStarted: number;
  private hourTotalBandwidthStarted: number;
  private newWorkIngressBytes = 0;

  constructor(private readonly options: OwnerResourcePolicyOptions) {
    for (const value of [
      options.maxNewWorkIngressBytesPerHour,
      options.maxTotalBandwidthBytesPerHour,
      options.maxCpuMillisecondsPerMinute,
    ]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error('Owner resource limits must be non-negative safe integers');
      }
    }
    this.schedule = options.activeHours === undefined ? null : parseActiveHours(options.activeHours);
    this.now = options.now ?? Date.now;
    this.cpuMicros = options.cpuMicros ?? (() => {
      const usage = process.cpuUsage();
      return usage.user + usage.system;
    });
    this.externalPower = options.externalPower ?? measuredExternalPower;
    this.hourStarted = this.now();
    this.minuteStarted = this.hourStarted;
    this.minuteCpuStarted = this.cpuMicros();
    this.hourTotalBandwidthStarted = options.totalBandwidthBytes?.() ?? 0;
    if (options.persistDir) {
      const path = join(options.persistDir, POLICY_FILE);
      if (existsSync(path)) {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!isStoredBudget(parsed)) throw new Error('Invalid persisted relay owner budget');
        this.hourStarted = parsed.hourStarted;
        this.minuteStarted = parsed.minuteStarted;
        this.minuteCpuStarted = parsed.minuteCpuStarted;
        this.hourTotalBandwidthStarted = parsed.hourTotalBandwidthStarted;
        this.newWorkIngressBytes = parsed.newWorkIngressBytes;
      }
    }
  }

  allowNewWork(ingressBytes: number): boolean {
    if (!Number.isSafeInteger(ingressBytes) || ingressBytes < 0) return false;
    const now = this.now();
    if (now - this.hourStarted >= HOUR_MS || now < this.hourStarted) {
      this.hourStarted = now;
      this.newWorkIngressBytes = 0;
      this.hourTotalBandwidthStarted = this.options.totalBandwidthBytes?.() ?? 0;
    }
    if (now - this.minuteStarted >= MINUTE_MS || now < this.minuteStarted) {
      this.minuteStarted = now;
      this.minuteCpuStarted = this.cpuMicros();
    }
    if (this.schedule) {
      const date = new Date(now);
      const minutes = date.getHours() * 60 + date.getMinutes();
      const { start, end } = this.schedule;
      if (start !== end && (start < end
        ? minutes < start || minutes >= end
        : minutes < start && minutes >= end)) return false;
    }
    if (this.options.requireExternalPower && !this.externalPower()) return false;
    if (this.options.maxCpuMillisecondsPerMinute !== undefined
      && this.cpuMicros() - this.minuteCpuStarted
        >= this.options.maxCpuMillisecondsPerMinute * 1_000) return false;
    if (this.options.maxTotalBandwidthBytesPerHour !== undefined) {
      const total = this.options.totalBandwidthBytes?.();
      if (total === undefined || total - this.hourTotalBandwidthStarted
        > this.options.maxTotalBandwidthBytesPerHour) return false;
    }
    if (this.options.maxNewWorkIngressBytesPerHour !== undefined
      && this.newWorkIngressBytes + ingressBytes
        > this.options.maxNewWorkIngressBytesPerHour) return false;
    this.newWorkIngressBytes += ingressBytes;
    if (this.options.persistDir) {
      try {
        this.options.checkpointUsage?.();
        this.persist();
      } catch {
        // A failed budget write must not grant work that could exceed limits on restart.
        return false;
      }
    }
    return true;
  }

  private persist(): void {
    const dir = this.options.persistDir!;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, POLICY_FILE);
    const temporary = `${path}.next`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({
        version: 1, hourStarted: this.hourStarted, minuteStarted: this.minuteStarted,
        minuteCpuStarted: this.minuteCpuStarted,
        hourTotalBandwidthStarted: this.hourTotalBandwidthStarted,
        newWorkIngressBytes: this.newWorkIngressBytes,
      }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directoryFd = openSync(dir, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
}

function isStoredBudget(value: unknown): value is {
  version: 1; hourStarted: number; minuteStarted: number; minuteCpuStarted: number;
  hourTotalBandwidthStarted: number; newWorkIngressBytes: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && [
    'hourStarted', 'minuteStarted', 'minuteCpuStarted',
    'hourTotalBandwidthStarted', 'newWorkIngressBytes',
  ].every(key => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0);
}

function parseActiveHours(value: string): { start: number; end: number } {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Active hours must use HH:MM-HH:MM');
  const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    throw new Error('Active hours contain an invalid time');
  }
  return { start: startHour * 60 + startMinute, end: endHour * 60 + endMinute };
}

let powerSample: { at: number; online: boolean } | null = null;

/** Unknown power state conservatively declines discretionary work. */
export function measuredExternalPower(): boolean {
  const now = Date.now();
  if (powerSample && now - powerSample.at < 30_000) return powerSample.online;
  let online = false;
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 2_000 });
      online = output.includes("Now drawing from 'AC Power'");
    } else if (process.platform === 'linux') {
      const root = '/sys/class/power_supply';
      const supplies = existsSync(root) ? readdirSync(root) : [];
      const batteries = supplies.filter(name => {
        try { return readFileSync(join(root, name, 'type'), 'utf8').trim() === 'Battery'; }
        catch { return false; }
      });
      if (batteries.length === 0) online = true;
      else online = supplies.some(name => {
        try {
          return readFileSync(join(root, name, 'type'), 'utf8').trim() !== 'Battery'
            && readFileSync(join(root, name, 'online'), 'utf8').trim() === '1';
        } catch { return false; }
      });
    } else if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '$b=Get-CimInstance Win32_Battery; if(-not $b){"AC"} elseif($b.BatteryStatus -in 3,6,7,8,9){"AC"}else{"BAT"}',
      ], { encoding: 'utf8', timeout: 3_000 });
      online = output.trim() === 'AC';
    }
  } catch { online = false; }
  powerSample = { at: now, online };
  return online;
}
