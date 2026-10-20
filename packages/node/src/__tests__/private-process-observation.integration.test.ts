import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIVATE_DISCOVERY_REQUEST_TYPE, RELAY_PEER_REQUEST_FRAME_TYPE, RELAY_PRIVATE_FORWARD_FRAME_TYPE,
  createPublicationRecord, generatePublicationKeyMaterial,
  type RelayDescriptorV1,
} from '@resonance/core';
import { createRelayClient } from '../relay-client.js';

let ENTRY: string, DESTINATION: string, UNAWARE_ENTRY: string;
const directory = mkdtempSync(join(tmpdir(), 'resonance-private-process-'));
const dirs = [0, 1, 2].map(index => join(directory, String(index)));
const fixture = fileURLToPath(new URL('./fixtures/private-relay-process.mjs', import.meta.url));

interface Observation { event: string; raw?: string; remoteAddress?: string; remotePort?: number;
  localPort?: number; url?: string; descriptor?: unknown; error?: string }

class ProcessRelay {
  readonly events: Observation[] = [];
  private child: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly ready: Promise<RelayDescriptorV1>;

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
let unawareEntry: ProcessRelay;

beforeAll(async () => {
  entry = new ProcessRelay(0, '127.0.0.1', 'ws://127.0.0.1:0/', dirs[0]);
  destination = new ProcessRelay(0, '::1', 'ws://[::1]:0/', dirs[1]);
  unawareEntry = new ProcessRelay(0, '127.0.0.1', 'ws://127.0.0.1:0/', dirs[2]);
  const [entryDescriptor, descriptor, unawareDescriptor] = await Promise.all([entry.ready, destination.ready, unawareEntry.ready]);
  ENTRY = entryDescriptor.endpoints[0]; DESTINATION = descriptor.endpoints[0]; UNAWARE_ENTRY = unawareDescriptor.endpoints[0];
  expect([ENTRY, DESTINATION, UNAWARE_ENTRY].every(endpoint => Number(new URL(endpoint).port) > 0)).toBe(true);
  expect(new Set([ENTRY, DESTINATION, UNAWARE_ENTRY]).size).toBe(3);
  expect(await entry.request('observe', descriptor)).toBe('accepted');
}, 20_000);

afterAll(async () => {
  await Promise.allSettled([entry?.stop(), destination?.stop(), unawareEntry?.stop()]);
  rmSync(directory, { recursive: true, force: true });
});

describe('private transport observations in separate relay processes', () => {
  it('keeps the operation off the entry wire and sends destination work from the entry process', async () => {
    const client = createRelayClient({ relayUrl: DESTINATION,
      privateEntryUrls: [ENTRY] });
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

    const destinationDiscovery = destination.events.find(event => {
      try { return JSON.parse(event.raw ?? '').type === RELAY_PEER_REQUEST_FRAME_TYPE; }
      catch { return false; }
    });
    const entryDiscovery = entry.events.find(event => {
      try { return JSON.parse(event.raw ?? '').type === PRIVATE_DISCOVERY_REQUEST_TYPE; }
      catch { return false; }
    });
    expect(destinationDiscovery).toBeDefined();
    expect(entryDiscovery).toBeDefined();
    expect(JSON.parse(destinationDiscovery!.raw!).request.requestId)
      .toBe(JSON.parse(entryDiscovery!.raw!).peerRequest.requestId);
    // Both destination sockets, including key discovery, originate in entry.
    for (const inbound of [destinationDiscovery, forwarded]) {
      expect(entry.events.some(event => event.event === 'outbound'
        && event.url === DESTINATION && event.localPort === inbound?.remotePort)).toBe(true);
    }
  }, 20_000);

  it('does not contact a destination when the entry has no verified route to it', async () => {
    const before = destination.events.length;
    const client = createRelayClient({ relayUrl: DESTINATION,
      privateEntryUrls: [UNAWARE_ENTRY] });
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xe5), itemType: 'offer',
      createdAt: now, expiresAt: now + 86_400_000,
    }, keys);
    await expect(client.submitPublicationOperation(record))
      .rejects.toThrow('Indirect destination discovery closed: 4004');
    expect(destination.events.length).toBe(before);
    expect((await unawareEntry.request('stats')).stored_publications).toBe(0);
  }, 20_000);
});
