/** Process-local resource measurements for the relay operator. */

import { readdirSync, statSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';

export class RelayTrafficMeter {
  private readonly active = new Set<Socket>();
  private completedIngress = 0;
  private completedEgress = 0;

  observe(socket: Socket): void {
    if (this.active.has(socket)) return;
    this.active.add(socket);
    socket.once('close', () => {
      this.completedIngress += socket.bytesRead;
      this.completedEgress += socket.bytesWritten;
      this.active.delete(socket);
    });
  }

  snapshot(): { ingressBytes: number; egressBytes: number } {
    let ingressBytes = this.completedIngress;
    let egressBytes = this.completedEgress;
    for (const socket of this.active) {
      ingressBytes += socket.bytesRead;
      egressBytes += socket.bytesWritten;
    }
    return { ingressBytes, egressBytes };
  }
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
