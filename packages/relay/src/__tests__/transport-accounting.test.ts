import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Socket, AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { createRelayContactHintV1, createRelayDescriptorV1, generateIdentity, generateSigningKeyPair } from '@resonance/core';
import { createAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { createHistoryAgreementRequest } from '@resonance/core/history-agreement';
import { historyDigest } from '@resonance/core/history-checkpoint';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';
import { connectRelayLinkV1 } from '../relay-link-client.js';
import { requestAdmissionWitnessVote } from '../admission-witness-transport.js';
import { exchangeHistoryCheckpoint } from '../history-checkpoint-exchange.js';
import { exchangeHistoryAgreement } from '../history-agreement-exchange.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function peer() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: true });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const messages: string[] = [], extensions: Array<string | undefined> = [];
  const closed = new Promise<void>(resolve => server.once('connection', (socket, request) => {
    extensions.push(request.headers['sec-websocket-extensions']);
    socket.on('error', () => {}); socket.on('message', data => messages.push(data.toString())); socket.once('close', () => resolve());
  }));
  await once(server, 'listening');
  return { endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, messages, extensions, closed };
}

function witness(endpoint: string, signal: AbortSignal, onSocket: (socket: Socket) => void) {
  const key = generateSigningKeyPair();
  const request = createAdmissionWitnessRequest({ setId: historyDigest('set'), issuerKey: historyDigest('issuer'),
    spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${randomBytes(64).toString('base64url')}` }, key);
  return requestAdmissionWitnessVote({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint }, request, signal, onSocket);
}

it.each(['discovery', 'link', 'witness', 'checkpoint', 'agreement'] as const)(
  'contains a throwing %s accounting callback, closes the real socket and sends no application request', async kind => {
    const p = await peer(), hint = createRelayContactHintV1('configured', p.endpoint);
    let calls = 0;
    const onSocket = () => { calls++; throw new Error('Private accounting failure details'); };
    let attempt: Promise<unknown>;
    if (kind === 'discovery') attempt = discoverRelayContactV1(hint, { onTransportSocket: onSocket, timeoutMs: 1000 });
    else if (kind === 'link') {
      const identity = generateIdentity(), now = Date.now();
      const descriptor = createRelayDescriptorV1({ sequence: 1, endpoints: [], reachability: 'outbound-only',
        capabilities: { storesPublications: true, storesMailboxes: true, answersQueries: true, forwardsQueries: true, replicaExchange: true },
        supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 }, issuedAt: now, expiresAt: now + 60000 }, identity);
      attempt = connectRelayLinkV1(hint, descriptor, identity, { onTransportSocket: onSocket, handshakeTimeoutMs: 1000 });
    } else if (kind === 'witness') attempt = witness(p.endpoint, new AbortController().signal, onSocket);
    else {
      const f = historyCheckpointFixture(), issuedAt = Date.now(), member = { publicKey: f.context.members[0], endpoint: p.endpoint };
      const shared = { rootId: f.options.rootId, generation: 0, replica: member.publicKey,
        challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 1000 };
      if (kind === 'checkpoint') {
        const request = createHistoryExchangeRequest({ ...shared, action: 'head', sequence: 0, envelopeId: null }, f.context, f.owner);
        attempt = exchangeHistoryCheckpoint(member, { request, envelope: null }, new AbortController().signal, onSocket);
      } else {
        const request = createHistoryAgreementRequest({ ...shared, action: 'promise', nextGeneration: 1, view: 1, proposalId: null, evidenceId: null }, f.context, f.owner);
        attempt = exchangeHistoryAgreement(member, { request, proposal: null, viewCertificate: null, preparedCertificate: null }, new AbortController().signal, onSocket);
      }
    }
    await expect(attempt).rejects.toThrow('socket accounting failed'); await p.closed;
    expect(calls).toBe(1); expect(p.messages).toEqual([]); expect(p.extensions).toEqual([undefined]);
  },
);

it('does not send a witness claim when its owner cancels inside the accounting callback', async () => {
  const p = await peer(), controller = new AbortController();
  await expect(witness(p.endpoint, controller.signal, () => controller.abort())).rejects.toThrow('cancelled');
  await p.closed; expect(p.messages).toEqual([]);
});
