import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createMailboxRequest, createMailboxRequestFrame,
  createPublicationOperationFrame, createPublicationRecord, createPublicationTombstone,
  createSearchRequestFrameV2, createSearchRequestV2,
  generatePublicationKeyMaterial, parseMessage,
  serializeMailboxRequestFrame, serializePublicationOperationFrame,
  serializeSearchRequestFrameV2,
  type Message,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const PORT = 35_000 + Math.floor(Math.random() * 1_000);
const DIR = `/tmp/resonance-owner-limits-${Date.now()}-${PORT}`;
let relay: RelayServer;
let allowNewWork = true;

function request(raw: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('request timed out')); }, 5_000);
    socket.on('open', () => socket.send(raw));
    socket.on('message', data => {
      clearTimeout(timeout);
      socket.close();
      resolve(parseMessage(data.toString()));
    });
    socket.on('error', error => { clearTimeout(timeout); reject(error); });
  });
}

beforeAll(async () => {
  relay = createRelayServer({
    port: PORT, host: '127.0.0.1', persistDir: DIR,
    acceptNewWork: () => allowNewWork,
  });
  await relay.start();
});

afterAll(async () => {
  await relay.stop({ graceful: false });
  rmSync(DIR, { recursive: true, force: true });
});

describe('owner admission boundaries', () => {
  it('refuses new publications and searches while keeping acknowledgements and withdrawals available', async () => {
    const offerKeys = generatePublicationKeyMaterial();
    const needKeys = generatePublicationKeyMaterial();
    const now = Date.now();
    const base = {
      groupId: 'owner-limits', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x47),
      createdAt: now, expiresAt: now + 60_000,
    };
    const offer = createPublicationRecord({ ...base, itemType: 'offer' }, offerKeys);
    const need = createPublicationRecord({ ...base, itemType: 'need' }, needKeys);
    for (const record of [offer, need]) {
      const response = await request(serializePublicationOperationFrame(
        createPublicationOperationFrame(record),
      ));
      expect(response.payload).toMatchObject({ status: 'ok' });
    }
    allowNewWork = false;

    const denied = createPublicationRecord({
      ...base, groupId: 'owner-limits-new', itemType: 'offer',
    }, generatePublicationKeyMaterial());
    expect((await request(serializePublicationOperationFrame(
      createPublicationOperationFrame(denied),
    ))).payload).toMatchObject({ status: 'error', message: 'owner_limited' });
    const search = createSearchRequestV2({
      groupId: 'owner-limits', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x47), itemType: 'need',
      k: 5, threshold: 0.9,
    });
    expect((await request(serializeSearchRequestFrameV2(
      createSearchRequestFrameV2(search),
    ))).payload).toMatchObject({ status: 'error', message: 'owner_limited' });

    const fetched = await request(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('fetch', need, needKeys, [], Date.now()),
    ))) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
    expect(fetched.payload.envelopes).toHaveLength(1);
    expect((await request(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('ack', need, needKeys,
        fetched.payload.envelopes.map(envelope => envelope.envelopeId), Date.now()),
    )))).payload).toMatchObject({ status: 'ok', message: 'acknowledged:1' });

    const tombstone = createPublicationTombstone(
      offer, 'withdrawn', offerKeys.signingKeyPair, Date.now(),
    );
    expect((await request(serializePublicationOperationFrame(
      createPublicationOperationFrame(tombstone),
    ))).payload).toMatchObject({ status: 'ok' });
  });
});
