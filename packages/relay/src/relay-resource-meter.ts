/** Process-local resource measurements for the relay operator. */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';

const USAGE_FILE = 'relay-resource-usage.json';
type ResourceTotals = {
  ingressBytes: number;
  egressBytes: number;
  lanIngressBytes: number;
  lanEgressBytes: number;
  cpuMicros: number;
};

export class RelayTrafficMeter {
  private readonly active = new Set<Socket>();
  private readonly cpuAtStart = process.cpuUsage();
  private previous: ResourceTotals = {
    ingressBytes: 0, egressBytes: 0, lanIngressBytes: 0, lanEgressBytes: 0, cpuMicros: 0,
  };
  private completedIngress = 0;
  private completedEgress = 0;
  private lanIngress = 0;
  private lanEgress = 0;

  constructor(private readonly directory?: string) {
    if (!directory) return;
    const path = join(directory, USAGE_FILE);
    if (!existsSync(path)) return;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isStoredUsage(parsed)) throw new Error('Invalid persisted relay resource usage');
    this.previous = parsed.totals;
  }

  observe(socket: Socket): void {
    if (this.active.has(socket)) return;
    this.active.add(socket);
    socket.once('close', () => {
      this.completedIngress += socket.bytesRead;
      this.completedEgress += socket.bytesWritten;
      this.active.delete(socket);
    });
  }

  recordLanIngress(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid LAN ingress bytes');
    this.lanIngress += bytes;
  }

  recordLanEgress(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid LAN egress bytes');
    this.lanEgress += bytes;
  }

  snapshot(): ResourceTotals & { totalBandwidthBytes: number } {
    let ingressBytes = this.previous.ingressBytes + this.completedIngress;
    let egressBytes = this.previous.egressBytes + this.completedEgress;
    for (const socket of this.active) {
      ingressBytes += socket.bytesRead;
      egressBytes += socket.bytesWritten;
    }
    const cpu = process.cpuUsage(this.cpuAtStart);
    const lanIngressBytes = this.previous.lanIngressBytes + this.lanIngress;
    const lanEgressBytes = this.previous.lanEgressBytes + this.lanEgress;
    return {
      ingressBytes, egressBytes, lanIngressBytes, lanEgressBytes,
      cpuMicros: this.previous.cpuMicros + cpu.user + cpu.system,
      totalBandwidthBytes: ingressBytes + egressBytes + lanIngressBytes + lanEgressBytes,
    };
  }

  /** Atomic, fsynced checkpoint. A crash can lose only traffic since the previous checkpoint. */
  checkpoint(): void {
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, USAGE_FILE);
    const temporary = `${path}.next`;
    const { totalBandwidthBytes: _total, ...totals } = this.snapshot();
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, totals }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directoryFd = openSync(this.directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
}

function isStoredUsage(value: unknown): value is { version: 1; totals: ResourceTotals } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; totals?: unknown };
  if (candidate.version !== 1 || !candidate.totals
    || typeof candidate.totals !== 'object' || Array.isArray(candidate.totals)) return false;
  const totals = candidate.totals as Record<string, unknown>;
  const keys = ['ingressBytes', 'egressBytes', 'lanIngressBytes', 'lanEgressBytes', 'cpuMicros'];
  return keys.every(key => Number.isSafeInteger(totals[key]) && (totals[key] as number) >= 0);
}

/** Counts regular files under the relay data directory, without following links. */
export function relayDataFileBytes(directory: string): number {
  let total = 0;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return 0; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += relayDataFileBytes(path);
    else if (entry.isFile()) {
      try { total += statSync(path).size; } catch { /* Concurrent compaction or removal. */ }
    }
  }
  return total;
}
