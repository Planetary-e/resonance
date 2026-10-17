/** Process-local resource measurements for the relay operator. */

import { readdirSync, statSync } from 'node:fs';
import { openResourceCheckpoint } from './resource-checkpoint.js';
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

type StoredUsage = { version: 1; totals: ResourceTotals };
export class RelayTrafficMeter {
  private readonly checkpointFile?: { write(value: StoredUsage): void };
  private readonly active = new Set<Socket>();
  private readonly cpuAtStart = process.cpuUsage();
  private previous: ResourceTotals = {
    ingressBytes: 0, egressBytes: 0, lanIngressBytes: 0, lanEgressBytes: 0, cpuMicros: 0,
  };
  private completedIngress = 0;
  private completedEgress = 0;
  private lanIngress = 0;
  private lanEgress = 0;

  constructor(directory?: string) {
    if (!directory) return;
    const checkpoint = openResourceCheckpoint(join(directory, USAGE_FILE), isStoredUsage);
    this.checkpointFile = checkpoint;
    this.previous = checkpoint.read()?.totals ?? this.previous;
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
    if (!Number.isSafeInteger(this.lanIngress + bytes)) throw new Error('LAN ingress counter exceeds its bound');
    this.lanIngress += bytes;
  }

  recordLanEgress(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid LAN egress bytes');
    if (!Number.isSafeInteger(this.lanEgress + bytes)) throw new Error('LAN egress counter exceeds its bound');
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
    const totals = {
      ingressBytes, egressBytes, lanIngressBytes, lanEgressBytes,
      cpuMicros: this.previous.cpuMicros + cpu.user + cpu.system,
      totalBandwidthBytes: ingressBytes + egressBytes + lanIngressBytes + lanEgressBytes,
    };
    if (!Object.values(totals).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Resource measurement exceeds its counter bound');
    return totals;
  }

  /** Atomic, fsynced checkpoint. A crash can lose only traffic since the previous checkpoint. */
  checkpoint(): void {
    if (!this.checkpointFile) return;
    const { totalBandwidthBytes: _total, ...totals } = this.snapshot();
    this.checkpointFile.write({ version: 1, totals });
  }
}

function isStoredUsage(value: unknown): value is StoredUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; totals?: unknown };
  if (Object.keys(value).sort().join(',') !== 'totals,version' || candidate.version !== 1 || !candidate.totals
    || typeof candidate.totals !== 'object' || Array.isArray(candidate.totals)) return false;
  const totals = candidate.totals as Record<string, unknown>;
  const keys = ['ingressBytes', 'egressBytes', 'lanIngressBytes', 'lanEgressBytes', 'cpuMicros'];
  return Object.keys(totals).length === keys.length
    && keys.every(key => Number.isSafeInteger(totals[key]) && (totals[key] as number) >= 0)
    && Number.isSafeInteger((totals.ingressBytes as number) + (totals.egressBytes as number)
      + (totals.lanIngressBytes as number) + (totals.lanEgressBytes as number));
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
