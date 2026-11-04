import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import WebSocket from 'ws';
import { EmbeddingEngine, generateRelationshipKeyMaterial } from '@resonance/core';
import { configureAdmissionWallet, getSession, initSession, lockSession, unlockSession } from '../session.js';

let directory: string | undefined;
afterEach(() => { lockSession(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }); });

it('blocks direct maintenance for a configured session wallet and blocks the retained client after lock', async () => {
  directory = mkdtempSync(join(tmpdir(), 'session-ack-consent-'));
  vi.stubEnv('RESONANCE_DATA_DIR', directory);
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const relayUrl = 'ws://[::1]:45997/', password = 'session-ack-local-consent';
  vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', `ws://127.0.0.1:45996/,${relayUrl}`);
  await initSession(password); await unlockSession(password, relayUrl);
  const issuer = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  await configureAdmissionWallet({ version: 1, scope: { issuer: 'session-ack', community: 'public', epoch: 'one' }, relayUrls: [relayUrl],
    issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', issuer.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----` });
  lockSession(); vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', undefined); await unlockSession(password, relayUrl);
  const client = getSession()!.relayClient, keys = generateRelationshipKeyMaterial(), ids = ['env_' + 'a'.repeat(43)];
  const sent = vi.spyOn(WebSocket.prototype, 'send');
  await expect(client.acknowledgeRelationshipMailbox(keys, ids)).rejects.toThrow('private route');
  expect(sent).not.toHaveBeenCalled();
  lockSession();
  await expect(client.acknowledgeRelationshipMailbox(keys, ids)).rejects.toThrow(/closed|private route/);
  expect(sent).not.toHaveBeenCalled();
}, 15000);
