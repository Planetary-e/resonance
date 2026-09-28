import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RELAY_PEER_REQUEST_FRAME_TYPE, RELAY_PRIVATE_FORWARD_FRAME_TYPE,
  createPublicationRecord, generatePublicationKeyMaterial,
} from '@resonance/core';
import { createRelayClient } from '../relay-client.js';

const BASE_PORT = 47_000 + Math.floor(Math.random() * 1_000);
const ENTRY = `ws://127.0.0.1:${BASE_PORT}/`;
const DESTINATION = `ws://[::1]:${BASE_PORT + 1}/`;
const dirs = [0, 1].map(index => `/tmp/resonance-private-process-${Date.now()}-${BASE_PORT}-${index}`);
const fixture = fileURLToPath(new URL('./fixtures/private-relay-process.mjs', import.meta.url));

interface Observation { event: string; raw?: string; remoteAddress?: string; remotePort?: number;
  localPort?: number; url?: string; descriptor?: unknown; error?: string }

class ProcessRelay {
  readonly events: Observation[] = [];
  private child: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly ready: Promise<unknown>;

  constructor(port: number, host: string, endpoint: string, persistDir: string) {
    this.child = fork(fixture, [], {
      cwd: process.cwd(), execArgv: ['--import', 'tsx'],
      env: { ...process.env,
        RESONANCE_TEST_RELAY_CONFIG: JSON.stringify({ port, host, endpoint, persistDir }) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    this.child.stderr?.on('data', chunk => { stderr += String(chunk); });
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Relay process did not start: ${stderr}`)), 10_000);
      this.child.on('message', (message: any) => {
        if (message.event) {
          this.events.push(message);
          if (message.event === 'ready') { clearTimeout(timeout); resolve(message.descriptor); }
          if (message.event === 'failed') { clearTimeout(timeout); reject(new Error(message.error)); }
        } else if (typeof message.id === 'number') {
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error));
          else request.resolve(message.result);
        }
      });
      this.child.on('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`Relay process exited ${code}: ${stderr}`));
      });
    });
  }

  request(command: string, descriptor?: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, command, descriptor });
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await this.request('stop');
  }
}

let entry: ProcessRelay;
let destination: ProcessRelay;

beforeAll(async () => {
  entry = new ProcessRelay(BASE_PORT, '127.0.0.1', ENTRY, dirs[0]);
  destination = new ProcessRelay(BASE_PORT + 1, '::1', DESTINATION, dirs[1]);
  const [, descriptor] = await Promise.all([entry.ready, destination.ready]);
  expect(await entry.request('observe', descriptor)).toBe('accepted');
}, 20_000);

afterAll(async () => {
  await Promise.allSettled([entry?.stop(), destination?.stop()]);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('private transport observations in separate relay processes', () => {
  it('keeps the operation off the entry wire and sends destination work from the entry process', async () => {
    const client = createRelayClient({ relayUrl: DESTINATION,
      privateRouteUrls: [ENTRY, DESTINATION] });
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xd5), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, keys);
    expect((await client.submitPublicationOperation(record)).status).toBe('ok');

    const entryRequest = entry.events.find(event => {
      try { return JSON.parse(event.raw ?? '').stage === 'entry'; } catch { return false; }
    });
    const forwarded = destination.events.find(event => {
      try { return JSON.parse(event.raw ?? '').type === RELAY_PRIVATE_FORWARD_FRAME_TYPE; }
      catch { return false; }
    });
    const outbound = entry.events.find(event => event.event === 'outbound'
      && event.url === DESTINATION && event.localPort === forwarded?.remotePort);
    expect(entryRequest?.raw).toBeDefined();
    expect(entryRequest?.raw).not.toContain(record.publicationId);
    expect(forwarded?.raw).toBeDefined();
    expect(forwarded?.raw).not.toContain(record.publicationId);
    expect(outbound).toBeDefined();
    expect((await entry.request('stats')).stored_publications).toBe(0);
    expect((await destination.request('stats')).stored_publications).toBe(1);

    // This discovery connection is a known blocker for the privacy claim.
    expect(destination.events.some(event => {
      try { return JSON.parse(event.raw ?? '').type === RELAY_PEER_REQUEST_FRAME_TYPE; }
      catch { return false; }
    })).toBe(true);
  }, 20_000);
});
