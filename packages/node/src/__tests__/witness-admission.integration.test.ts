import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublicationRecord, generatePublicationKeyMaterial, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { createConfiguredAdmissionVerifier, createRelayServer, type RelayServer } from '@resonance/relay';
import { createRelayClient } from '../relay-client.js';

import { publicVerif } from '@cloudflare/privacypass-ts';
import { generateSigningKeyPair, createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2 } from '@resonance/core';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyBody } from '@resonance/core/admission-policy';

async function witnessFixture(endpoints = Array.from({ length: 5 }, (_, i) => `ws://127.0.0.1:${45630 + i}/`)) {
  const authorityKey = generateSigningKeyPair(), witnesses = Array.from({ length: 5 }, generateSigningKeyPair), coordinators = Array.from({ length: 2 }, generateSigningKeyPair);
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]) });
  const scope = { issuer: 'witness-community', community: 'public', epoch: 'witness-period-one' };
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
  const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----\n`;
  const time = Date.now();
  const body: AdmissionPolicyBody = { version: 1, kind: 'admission-policy', revision: 1, issuedAt: time - 1000, expiresAt: time + 86400000,
    activeKey: admissionKeyFingerprint(pem), keys: [{ profile: { version: 1, scope, issuerPublicKey: pem, relayUrls: ['ws://127.0.0.1:45640/','ws://127.0.0.1:45641/'] },
      notBefore: time - 1000, issueUntil: time + 3600000, spendUntil: time + 7200000, retryUntil: time + 10800000,
      witnesses: { version: 1, quorum: 4, members: witnesses.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: endpoints[i] })),
        coordinators: coordinators.map(key => Buffer.from(key.publicKey).toString('base64url')) } }] };
  const policy = await signAdmissionPolicy(body, authority, authorityKey.secretKey);
  return { authority, authorityKey, witnesses, coordinators, keys, scope, body, policy, time,
    async token() { const blinded = await createBlindAdmissionRequestV2(scope, keys.publicKey); return blinded.finalize(await issueBlindAdmissionRequestV2(issuer, blinded.request)); } };
}

it('requires real four-of-five socket votes before two-hop publication, survives partition and restart, and refuses cross-destination token reuse', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'network-witnesses-'));
  const base = 48000 + Math.floor(Math.random() * 500);
  const endpoints = Array.from({ length: 5 }, (_, i) => `ws://127.0.0.1:${base + i}/`);
  const f = await witnessFixture(endpoints), encryptionKey = randomBytes(32), requests: string[] = [];
  let meteredWitnessBytes = 0, witnessConnections = 0;
  const verifiers = new Map<number, Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>>>();
  const servers = new Map<number, RelayServer>();
  const clients: Array<ReturnType<typeof createRelayClient>> = [];
  async function start(i: number, initialize: boolean) {
    const verifier = await createConfiguredAdmissionVerifier({ directory: join(directory, String(i)), encryptionKey, policy: f.policy, authority: f.authority, initialize,
      onWitnessSocket(socket) { witnessConnections++; socket.once('close', () => { meteredWitnessBytes += socket.bytesRead + socket.bytesWritten; }); },
      ...(i < 5 ? { witnessKey: f.witnesses[i] } : { coordinatorKey: f.coordinators[i - 5] }) });
    verifiers.set(i, verifier);
    const endpoint = i < 5 ? endpoints[i] : `ws://[::1]:${base + i}/`;
    const server = createRelayServer({ port: base + i, host: i < 5 ? '127.0.0.1' : '::1', persistDir: join(directory, String(i)), admissionVerifier: verifier,
      admissionWitness: verifier.witness ? { vote(request) { requests.push(JSON.stringify(request)); return verifier.witness!.vote(request); }, close() {} } : undefined,
      relayDiscovery: { endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 900000 }, maxKnownRelays: 8 } });
    servers.set(i, server); await server.start();
  }
  async function stop(i: number) { await servers.get(i)?.stop(); verifiers.get(i)?.close(); servers.delete(i); verifiers.delete(i); }
  const entryEndpoint = `ws://127.0.0.1:${base + 7}/`;
  const entry = createRelayServer({ port: base + 7, host: '127.0.0.1', persistDir: join(directory, 'entry'),
    relayDiscovery: { endpoints: [entryEndpoint], reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 900000 }, maxKnownRelays: 8 } });
  const record = (fill: number) => createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64).fill(fill), itemType: 'offer', createdAt: Date.now(), expiresAt: Date.now() + 86400000 }, generatePublicationKeyMaterial());
  const client = (destination: number, token: string) => {
    const instance = createRelayClient({ relayUrl: `ws://[::1]:${base + destination}/`, privateEntryUrls: [entryEndpoint],
      admissionCapabilityProvider: context => presentBlindAdmissionTokenV2(token, f.scope, context.action, context.requestBinding) });
    clients.push(instance); return instance;
  };
  try {
    for (let i = 0; i < 7; i++) await start(i, true);
    await entry.start();
    entry.observeRelayDescriptor(servers.get(5)!.getRelayDescriptor()!); entry.observeRelayDescriptor(servers.get(6)!.getRelayDescriptor()!);
    const token = await f.token(), first = record(0x35), other = record(0x73);
    const a = client(5, token), b = client(6, token);
    await a.submitPublicationOperation(first);
    expect(servers.get(5)!.getStats().stored_publications).toBe(1);
    await expect(b.submitPublicationOperation(other)).rejects.toThrow();
    expect(servers.get(6)!.getStats().stored_publications).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(witnessConnections).toBeGreaterThanOrEqual(4); expect(meteredWitnessBytes).toBeGreaterThan(0);
    expect(requests.join('')).not.toContain(token);
    expect(requests.join('')).not.toContain(first.publicationId);
    // Only three witnesses remain online. A new token cannot apply a publication.
    await stop(3); await stop(4);
    const secondToken = await f.token(), second = record(0x52), c = client(5, secondToken);
    await expect(c.submitPublicationOperation(second)).rejects.toThrow();
    expect(servers.get(5)!.getStats().stored_publications).toBe(1);
    await start(3, false); // Recover the fourth witness, preserving its previous votes.
    await c.submitPublicationOperation(second);
    expect(servers.get(5)!.getStats().stored_publications).toBe(2);
    // Restart the destination. Cached certificates permit the exact retry even
    // while all witnesses are offline, but never authorize another binding.
    await stop(5); await start(5, false);
    entry.observeRelayDescriptor(servers.get(5)!.getRelayDescriptor()!);
    for (let i = 0; i < 5; i++) await stop(i);
    await a.submitPublicationOperation(first);
    expect(servers.get(5)!.getStats().stored_publications).toBe(2);
    await expect(a.submitPublicationOperation(other)).rejects.toThrow();
    const snapshot = readFileSync(join(directory, '5', 'admission-witness-certificates.json'), 'utf8');
    expect(snapshot).not.toContain(token); expect(snapshot).not.toContain('votes');
  } finally {
    clients.forEach(c => c.disconnect()); await entry.stop();
    for (const i of [...servers.keys()]) await stop(i);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
