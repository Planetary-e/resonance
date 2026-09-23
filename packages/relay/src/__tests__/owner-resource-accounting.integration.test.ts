import { rmSync } from 'node:fs';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import {
  createPublicationOperationFrame, createPublicationRecord, generatePublicationKeyMaterial,
  parseMessage, serializePublicationOperationFrame,
} from '@resonance/core';
import { createRelayServer } from '../server.js';

const PORT = 37_000 + Math.floor(Math.random() * 1_000);
const DIRECTORY = `/tmp/resonance-owner-accounting-${Date.now()}-${PORT}`;

function publish(raw: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('request timed out')); }, 5_000);
    socket.on('open', () => socket.send(raw));
    socket.on('message', data => {
      clearTimeout(timeout);
      socket.close();
      resolve(parseMessage(data.toString()).payload);
    });
    socket.on('error', error => { clearTimeout(timeout); reject(error); });
  });
}

describe('relay resource accounting and storage commitments', () => {
  it('reports accepted-work cost and refuses a quota below retained promises on restart', async () => {
    const original = createRelayServer({
      port: PORT, host: '127.0.0.1', persistDir: DIRECTORY,
      publicationStorageQuotaBytes: 1_000_000,
      maxJournalStorageBytes: 1_000_000,
    });
    try {
      await original.start();
      const keys = generatePublicationKeyMaterial();
      const now = Date.now();
      const record = createPublicationRecord({
        groupId: 'public', fingerprintEpoch: 'owner-accounting',
        fingerprint: new Uint8Array(64).fill(0x44), itemType: 'offer',
        createdAt: now, expiresAt: now + 60_000,
      }, keys);
      expect(await publish(serializePublicationOperationFrame(
        createPublicationOperationFrame(record),
      ))).toMatchObject({ status: 'ok' });
      const before = original.getStats();
      expect(before.transport_ingress_bytes).toBeGreaterThan(0);
      expect(before.transport_egress_bytes).toBeGreaterThan(0);
      expect(before.data_file_bytes).toBeGreaterThan(0);
      expect(before.publication_commitment_floor_bytes)
        .toBeGreaterThan(before.publication_storage_reserved_bytes);
      expect(before.journal_commitment_floor_bytes).toBeGreaterThan(before.journal_bytes);
      expect(before.process_cpu_milliseconds).toBeGreaterThanOrEqual(0);
      await original.stop({ graceful: false });

      const tooSmall = createRelayServer({
        port: PORT, host: '127.0.0.1', persistDir: DIRECTORY,
        publicationStorageQuotaBytes: before.publication_commitment_floor_bytes - 1,
        maxJournalStorageBytes: 1_000_000,
      });
      await expect(tooSmall.start()).rejects.toThrow('below existing relay commitments');

      const restored = createRelayServer({
        port: PORT, host: '127.0.0.1', persistDir: DIRECTORY,
        publicationStorageQuotaBytes: 1_000_000,
        maxJournalStorageBytes: 1_000_000,
        acceptNewWork: () => false,
      });
      try {
        await restored.start();
        expect(restored.getStats().active_publications).toBe(1);
        expect(restored.getStats().publication_commitment_floor_bytes)
          .toBeGreaterThan(0);
      } finally {
        await restored.stop({ graceful: false });
      }
    } finally {
      // A failed start has no listener; the first relay was already stopped above.
      rmSync(DIRECTORY, { recursive: true, force: true });
    }
  }, 20_000);
});
