import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createPublicationRecord, generatePublicationKeyMaterial, createPublicationOperationFrame, createPublicationTombstone,
  createSearchRequestV2, createSearchRequestFrameV2, createMailboxRequest, createMailboxRequestFrame,
  createMailboxDepositRequest, createMailboxDepositFrame, createConsentOfferV2, createDeterministicMatchId,
  generateRelationshipKeyMaterial, encryptRelationshipMessage, createPairwiseChannelId, createChannelMessageOperationV2,
  encryptChannelOperationV2, createRelationshipMailboxDepositV2, createRelationshipMailboxDepositFrameV2,
  createRelationshipMailboxRequestV2, createRelationshipMailboxRequestFrameV2, createRelayDescriptorV1, createRelayContactHintV1, generateIdentity, type AdmissionCapabilityV2 } from '@resonance/core';
import { createRelayServer } from '../server.js';
import { connectRelayLinkV1, type RelayLinkConnection } from '../relay-link-client.js';
import { createDeferredAdmission } from '../deferred-admission.js';

it('refuses new admission while listening and permits only bounded owner-signed acknowledgement maintenance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deferred-admission-')), gate = createDeferredAdmission();
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: directory, admissionVerifier: gate.verifier, adminApiKey: 'test',
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  let link: RelayLinkConnection | undefined;
  await relay.start(); const port = relay.getListeningPort()!;
  async function send(frame: unknown) {
    return new Promise<{ type: string; payload: { message?: string } }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`), timer = setTimeout(() => { socket.terminate(); reject(new Error('Deferred frame timed out')); }, 5000);
      socket.once('open', () => socket.send(JSON.stringify(frame)));
      socket.once('message', raw => { clearTimeout(timer); socket.close(); resolve(JSON.parse(raw.toString())); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
  }
  try {
    const now = Date.now(), publicationKeys = generatePublicationKeyMaterial();
    const input = { groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64).fill(0x42),
      itemType: 'offer' as const, createdAt: now, expiresAt: now + 86400000 };
    const alice = createPublicationRecord(input, publicationKeys), bob = createPublicationRecord({ ...input, itemType: 'need' }, generatePublicationKeyMaterial());
    const matchId = createDeterministicMatchId(alice.publicationId, bob.publicationId);
    const offer = createConsentOfferV2(matchId, alice, bob, publicationKeys, generateRelationshipKeyMaterial(), now, now + 60000);
    const envelope = encryptRelationshipMessage(offer, bob);
    const sender = generateRelationshipKeyMaterial(), recipient = generateRelationshipKeyMaterial();
    const channelId = createPairwiseChannelId(matchId, sender.relationshipId, recipient.relationshipId);
    const operation = createChannelMessageOperationV2(channelId, recipient.relationshipId, 1,
      { kind: 'disclosure', text: 'test', level: 'general', createdAt: now }, randomBytes(32), sender);
    const channelEnvelope = encryptChannelOperationV2(operation, { id: recipient.mailboxId, encryptionKey: Buffer.from(recipient.mailboxKeyPair.publicKey).toString('base64') });
    const capability: AdmissionCapabilityV2 = { version: 2, kind: 'admission-capability', scheme: 'test-blind-token-v1',
      issuer: 'community:test', token: 'A'.repeat(43), requestProof: `admreq_${'a'.repeat(86)}` };
    const search = createSearchRequestFrameV2(createSearchRequestV2({ ...input, k: 5, threshold: 0.7, expiresAt: now + 30000 }), capability);
    const relationshipFetch = createRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestV2('fetch', recipient), capability);
    const frames = [createPublicationOperationFrame(alice, capability),
      createPublicationOperationFrame(createPublicationTombstone(alice, 'withdrawn', publicationKeys.signingKeyPair, now), capability), search,
      createMailboxRequestFrame(createMailboxRequest('fetch', alice, publicationKeys), capability),
      createMailboxDepositFrame(createMailboxDepositRequest(matchId, alice, bob, publicationKeys, envelope, now), capability),
      relationshipFetch,
      createRelationshipMailboxDepositFrameV2(createRelationshipMailboxDepositV2(recipient.relationshipId, sender, channelEnvelope), capability)];
    for (const frame of frames) expect((await send(frame)).payload.message).toBe('admission_unavailable');
    expect((await send(createMailboxRequestFrame(createMailboxRequest('ack', alice, publicationKeys, [envelope.envelopeId])))).payload.message).toBe('unknown_mailbox');
    expect((await send(createRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestV2('ack', recipient, [channelEnvelope.envelopeId])))).payload.message).toBe('acknowledged:0');
    expect(relay.getStats()).toMatchObject({ admission_ready: false, stored_publications: 0, mailbox_envelopes: 0, journal_entries: 0 });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(503);
    expect(await (await fetch(`http://127.0.0.1:${port}/stats?key=test`)).json()).toMatchObject({ admission_ready: false });
    const identity = generateIdentity(), local = createRelayDescriptorV1({ sequence: 1, endpoints: [], reachability: 'outbound-only',
      capabilities: { storesPublications: false, storesMailboxes: false, answersQueries: true, forwardsQueries: false, replicaExchange: false },
      supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 }, issuedAt: now, expiresAt: now + 30000 }, identity);
    link = await connectRelayLinkV1(createRelayContactHintV1('configured', `ws://127.0.0.1:${port}/`, relay.getRelayDescriptor()!.relayId), local, identity);
    const forwarded = createSearchRequestV2({ ...input, k: 5, threshold: 0.7, expiresAt: now + 30000 });
    expect((await link.querySearch(forwarded, capability, 0, 2000)).status).toBe('unavailable');
    const verifyAndSpend = vi.fn(() => ({ status: 'accepted' as const })); gate.install({ verifyAndSpend, close() {} });
    expect((await send(search)).type).toBe('search_response_v2'); // Rejected startup request did not consume its search ID.
    expect((await send(relationshipFetch)).payload.message).toBeUndefined(); expect(verifyAndSpend).toHaveBeenCalledTimes(2);
    expect((await link.querySearch(forwarded, capability, 0, 2000)).status).toBe('ok');
    expect(relay.getStats().admission_ready).toBe(true); expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    gate.close(); expect((await send(search)).payload.message).toBe('replayed_search');
    expect((await send(relationshipFetch)).payload.message).toBe('admission_unavailable'); expect(verifyAndSpend).toHaveBeenCalledTimes(3);
  } finally { link?.close(); gate.close(); await relay.stop({ graceful: false }); rmSync(directory, { recursive: true, force: true }); }
});
