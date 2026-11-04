import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingEngine } from '@resonance/core';
import { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { createAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { parseAdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { policyTransferFixture } from '../../../../core/src/__tests__/fixtures/policy-transfer-fixture.js';
import { createAdmissionPolicyTransferResponder } from '../../../../relay/src/admission-policy-transfer.js';
import { createRelayServer } from '../../../../relay/src/server.js';
import { createAppServer } from '../server.js';
import { lockSession } from '../session.js';

afterEach(() => { lockSession(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('backfills a pinned desktop wallet over the private route without rolling back its installed policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-proof-update-')), personal = join(root, 'personal');
  const n = await policyTransferFixture(), genesis = vi.fn(async () => n.first);
  const source = vi.fn(async () => n.advance);
  const responder = createAdmissionPolicyTransferResponder({ context: n.context, successor: source, genesis });
  const discovery = { reachability: 'direct' as const, supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } };
  const entry = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(root, 'entry'),
    relayDiscovery: { ...discovery, endpoints: ['ws://127.0.0.1:0/'] } });
  const destination = createRelayServer({ host: '::1', port: 0, persistDir: join(root, 'destination'),
    relayDiscovery: { ...discovery, endpoints: ['ws://[::1]:0/'] },
    policyQuery: async value => {
      const request = parseAdmissionPolicyQuery(value, n.context, Date.now()).request;
      return { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate',
        votes: n.keys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(request, n.advance.commitment.next, n.context, key)) } };
    }, policyTransfer: (value, signal) => responder.exchange(value, signal) });
  let app: ReturnType<typeof createAppServer> | undefined;
  try {
    vi.stubEnv('RESONANCE_DATA_DIR', personal);
    vi.stubEnv('RESONANCE_WALLET_PROOF_STORAGE_SELECTION_FILE', undefined);
    vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
    await entry.start(); await destination.start();
    expect(entry.observeRelayDescriptor(destination.getRelayDescriptor()!)).toBe('accepted');
    const endpoint = `ws://[::1]:${destination.getListeningPort()}/`;
    vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', `ws://127.0.0.1:${entry.getListeningPort()}/,${endpoint}`);
    app = createAppServer({ port: 0, relayUrl: endpoint }); const base = `http://127.0.0.1:${await app.start()}`;
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    let token = '';
    const unlock = async () => { const result = await request('/api/unlock', { password: 'desktop-proof-password' });
      expect(result.status).toBe(200); token = result.body.token; };
    expect((await request('/api/init', { password: 'desktop-proof-password' })).status).toBe(200); await unlock();
    expect((await request('/api/admission-wallet/policy', { policy: n.first, authority: n.context.authority, observers: n.context })).status).toBe(200);
    expect((await request('/api/admission-wallet/update', {})).body).toMatchObject({ updated: true, revision: 2 });
    await request('/api/lock', {});
    const tokenBytes = readFileSync(join(personal, 'admission-wallet.json'));
    const authorityId = 'ab'.repeat(16), authorityDirectory = join(root, 'authority'), proofDirectory = join(root, 'proof');
    const authority = openStorageReservationAuthority({ directory: authorityDirectory, mode: 'create-new', authorityId, limitBytes: 128 * 1024 * 1024 });
    try {
      const existing = [{ path: personal, scope: 'directory' as const }];
      authority.adoptExisting(existing, authority.reviewExisting(existing).approvalDigest);
      const fresh = [{ path: proofDirectory, scope: 'directory' as const }];
      authority.approveNewScopes(fresh, authority.reviewNewScopes(fresh).approvalDigest);
    } finally { authority.close(); }
    const selection = join(root, 'selection.json');
    writeFileSync(selection, JSON.stringify({ version: 1, authorityDirectory, authorityId, walletDirectory: personal, directory: proofDirectory,
      maxCiphertextBytes: 8 * 1024 * 1024, maxRecords: 100,
      limits: { maxPages: 100, maxEntries: 100, maxArchiveBytes: 4 * 1024 * 1024, maxHistoryBytes: 8 * 1024 * 1024,
        maxTransitions: 100, maxPageReads: 1000, timeoutMs: 10000 } }));
    vi.stubEnv('RESONANCE_WALLET_PROOF_STORAGE_SELECTION_FILE', selection);
    await unlock();
    expect((await request('/api/admission-wallet/update', {})).body).toMatchObject({ updated: false, revision: 2, remaining: 0 });
    expect(genesis).toHaveBeenCalled();
    expect(readFileSync(join(personal, 'admission-wallet.json'))).toEqual(tokenBytes);
    await request('/api/lock', {}); await unlock();
    expect((await request('/api/admission-wallet')).body).toMatchObject({ freshness: { installedRevision: 2, observedRevision: 2, conflicted: false } });
  } finally {
    lockSession(); await app?.stop(); await responder.close(); await destination.stop({ graceful: false }); await entry.stop({ graceful: false });
    n.close(); rmSync(root, { recursive: true, force: true });
  }
}, 30000);
