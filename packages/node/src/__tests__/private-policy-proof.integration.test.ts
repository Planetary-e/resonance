import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { policyTransferFixture } from '../../../core/src/__tests__/fixtures/policy-transfer-fixture.js';
import { createAdmissionPolicyEvidenceRequest } from '@resonance/core/admission-policy-transfer';
import { resolveAdmissionPolicy, prepareAdmissionPolicyV3Successor, signAdmissionPolicyV3, createResolvedAdmissionPolicyAdvance, decodeAdmissionPolicyArchivePage, encodeAdmissionPolicyArchivePage, admissionPolicyArchivePageDigest } from '@resonance/core/admission-policy-archive';
import { createAdmissionPolicyTransferResponder } from '../../../relay/src/admission-policy-transfer.js';
import { createRelayServer, type RelayServer } from '../../../relay/src/server.js';
import { createRelayClient, type RelayClient } from '../relay-client.js';

let n: Awaited<ReturnType<typeof policyTransferFixture>>, responder: ReturnType<typeof createAdmissionPolicyTransferResponder>;
let entry: RelayServer, destination: RelayServer, directory: string, entryUrl: string, destinationUrl: string;
let advance: Awaited<ReturnType<typeof createResolvedAdmissionPolicyAdvance>>['advance'], pages: { digest: string; bytes: Uint8Array }[];
let wrongGenesis = false, missingPage = false, corruptPage = false;
const requests = vi.fn(), capabilities = vi.fn(), clients: RelayClient[] = [];
beforeAll(async () => {
  n = await policyTransferFixture(true); directory = mkdtempSync(join(tmpdir(), 'private-policy-proof-'));
  const limits = { maxPages: 100, maxEntries: 100, maxArchiveBytes: 8 * 1024 * 1024, maxHistoryBytes: 8 * 1024 * 1024, maxTransitions: 100, maxPageReads: 100, timeoutMs: 3000 };
  const reader = async (digest: string) => { const page = pages?.find(page => page.digest === digest); if (!page || missingPage) throw new Error('missing proof page'); return corruptPage ? Uint8Array.from([1]) : page.bytes; };
  const previous = await resolveAdmissionPolicy({ context: n.context, genesis: n.first, advances: [n.advance], selectedHead: n.advance.commitment.next, reader, limits });
  const plan = await prepareAdmissionPolicyV3Successor({ previous, next: { revision: 3, issuedAt: n.second.issuedAt, expiresAt: n.second.expiresAt, activeKey: n.second.activeKey, keys: n.second.keys }, reader, limits });
  // Two immutable appended pages exercise the composite maximum without a large RSA fixture.
  const original = await decodeAdmissionPolicyArchivePage(plan.pages[0].bytes);
  const first = await encodeAdmissionPolicyArchivePage({ ...original, entries: original.entries.slice(0, 16) });
  const firstDigest = admissionPolicyArchivePageDigest(first);
  const second = await encodeAdmissionPolicyArchivePage({ ...original, previous: firstDigest, index: 1, firstEntry: 16, entries: original.entries.slice(16) });
  pages = [{ digest: firstDigest, bytes: first }, { digest: admissionPolicyArchivePageDigest(second), bytes: second }];
  plan.body.archive = { ...plan.body.archive, root: pages[1].digest, pageCount: 2, archiveBytes: first.byteLength + second.byteLength };
  const policy = await signAdmissionPolicyV3(plan.body, n.context.authority, n.key.secretKey);
  advance = (await createResolvedAdmissionPolicyAdvance({ previous, policy, key: n.key, reader, limits })).advance;
  responder = createAdmissionPolicyTransferResponder({ context: n.context, successor: async () => advance,
    genesis: async () => wrongGenesis ? n.second : n.first, page: async (head, digest) => { expect(head).toEqual(advance.commitment.next); return reader(digest); } });
  requests.mockImplementation((value, signal) => responder.exchange(value, signal));
  const discovery = { reachability: 'direct' as const, supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } };
  entry = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, 'entry'), relayDiscovery: { ...discovery, endpoints: ['ws://127.0.0.1:0/'] } });
  destination = createRelayServer({ host: '::1', port: 0, persistDir: join(directory, 'destination'), relayDiscovery: { ...discovery, endpoints: ['ws://[::1]:0/'] }, policyTransfer: requests });
  await entry.start(); await destination.start();
  entryUrl = `ws://127.0.0.1:${entry.getListeningPort()}/`; destinationUrl = `ws://[::1]:${destination.getListeningPort()}/`;
  expect(entry.observeRelayDescriptor(destination.getRelayDescriptor()!)).toBe('accepted');
}, 30000);
afterEach(() => { clients.splice(0).forEach(c => c.disconnect()); requests.mockClear(); capabilities.mockClear(); wrongGenesis = false; missingPage = false; corruptPage = false; });
afterAll(async () => { await responder?.close(); await destination?.stop({ graceful: false }); await entry?.stop({ graceful: false }); n?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
function client() {
  const value = createRelayClient({ relayUrl: destinationUrl, privateEntryUrls: [entryUrl], privateTraffic: { batchWindowMs: 10, jitterMs: 0 }, admissionCapabilityProvider: capabilities });
  clients.push(value); return value;
}
it('returns pinned original genesis and an authenticated two-page composite v3 step across the private route', async () => {
  const c = client(); expect(await c.fetchAdmissionPolicyGenesis!(n.context)).toEqual(n.first);
  const result = await c.fetchAdmissionPolicyProofStep!(n.context, { head: n.advance.commitment.next, policy: n.second });
  expect(result.advance).toEqual(advance); expect(result.pages).toEqual(pages); expect(pages.length).toBe(2);
  expect(requests.mock.calls.some(([value]) => value.kind === 'page')).toBe(true); expect(capabilities).not.toHaveBeenCalled();
  await expect(c.fetchAdmissionPolicySuccessor!(n.context, n.advance.commitment.next)).rejects.toThrow();
}, 15000);
it.each(['missing', 'corrupt'] as const)('refuses %s appended evidence without returning the advance alone', async kind => {
  missingPage = kind === 'missing'; corruptPage = kind === 'corrupt';
  await expect(client().fetchAdmissionPolicyProofStep!(n.context, { head: n.advance.commitment.next, policy: n.second })).rejects.toThrow();
  expect(capabilities).not.toHaveBeenCalled();
}, 15000);
it('refuses wrong genesis, wrong cursor and cancellation without direct personal observer fanout', async () => {
  wrongGenesis = true; await expect(client().fetchAdmissionPolicyGenesis!(n.context)).rejects.toThrow();
  requests.mockClear();
  await expect(client().fetchAdmissionPolicyProofStep!(n.context, { head: n.context.genesis, policy: n.second })).rejects.toThrow('cursor');
  expect(requests).not.toHaveBeenCalled();
  const controller = new AbortController(); controller.abort();
  await expect(client().fetchAdmissionPolicyGenesis!(n.context, { signal: controller.signal })).rejects.toThrow(); expect(requests).not.toHaveBeenCalled();
  const socket = new WebSocket(destinationUrl), closed = once(socket, 'close'); await once(socket, 'open');
  socket.send(JSON.stringify(createAdmissionPolicyEvidenceRequest(n.context, 'genesis', n.context.genesis))); await closed;
  expect(requests).not.toHaveBeenCalled();
}, 15000);

it('cancels an in-flight composite proof promptly and starts no later page request', async () => {
  const c = client(), controller = new AbortController(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  requests.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = () => resolve({}); }); });
  const pending = c.fetchAdmissionPolicyProofStep!(n.context, { head: n.advance.commitment.next, policy: n.second }, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'PRIVATE_OPERATION_CANCELLED' });
  await started; const time = performance.now(); controller.abort();
  try { await rejected; } finally { release(); }
  expect(performance.now() - time).toBeLessThan(500); expect(requests).toHaveBeenCalledTimes(1);
  await new Promise(resolve => setTimeout(resolve, 50)); expect(requests).toHaveBeenCalledTimes(1);
}, 15000);

it('refuses a signed step declaring more than two appended pages before requesting any page', async () => {
  const { createAdmissionPolicyAdvanceCommitment } = await import('@resonance/core/admission-policy-advance');
  const { admissionPolicyV3Digest } = await import('@resonance/core/admission-policy-archive');
  if (advance.policy.version !== 3) throw new Error('Expected v3 fixture');
  const { authority: _, signature: __, ...body } = advance.policy;
  const policy = await signAdmissionPolicyV3({ ...body, archive: { ...body.archive, pageCount: 3 } }, n.context.authority, n.key.secretKey);
  const commitment = createAdmissionPolicyAdvanceCommitment(n.advance.commitment.next, { revision: policy.revision, digest: admissionPolicyV3Digest(policy) }, n.context, n.key);
  const page = vi.fn(async () => pages[0].bytes);
  const local = createAdmissionPolicyTransferResponder({ context: n.context, successor: async () => ({ commitment, policy }), page });
  requests.mockImplementation((value, signal) => local.exchange(value, signal));
  try {
    await expect(client().fetchAdmissionPolicyProofStep!(n.context, { head: n.advance.commitment.next, policy: n.second })).rejects.toThrow('bounded step');
    expect(page).not.toHaveBeenCalled();
  } finally { await local.close(); requests.mockImplementation((value, signal) => responder.exchange(value, signal)); }
}, 15000);

it('retains failed discovery capacity charges and refuses before exhausting the absolute deadline', async () => {
  const c = createRelayClient({ relayUrl: destinationUrl,
    privateEntryUrls: Array.from({ length: 32 }, (_, i) => `ws://127.0.0.1:0/entry-${i}`),
    privateTraffic: { batchWindowMs: 10, jitterMs: 0 } }); clients.push(c);
  const started = performance.now();
  await expect(c.fetchAdmissionPolicyGenesis!(n.context)).rejects.toThrow('budget exhausted');
  expect(performance.now() - started).toBeLessThan(5000); expect(requests).not.toHaveBeenCalled();
}, 15000);
