import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSigningKeyPair, createAdmissionRequestBindingV2 } from '@resonance/core';
import { admissionKeyFingerprint, admissionPolicyDigest, signAdmissionPolicy, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyProofReference, prepareAdmissionPolicyV3Successor, signAdmissionPolicyV3,
  resolveAdmissionPolicy, createResolvedAdmissionPolicyAdvance, type AdmissionPolicyArchiveLimits } from '@resonance/core/admission-policy-archive';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { historyOriginalPoolFixture } from './fixtures/history-original-pool-fixture.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { replayAdmissionHistory } from '../admission-history-replay.js';
import { prepareAdmissionHistoryRestore } from '../admission-history-restore.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import type { AdmissionHistoryImage } from '../admission-history-records.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); vi.restoreAllMocks(); });

it('retains relay spends, denials and original v3 proof through 100 real pooled transitions and restores 101 generations', async () => {
  const started = performance.now(), h = historyCheckpointFixture(), signingKey = generateSigningKeyPair();
  const authority = Buffer.from(signingKey.publicKey).toString('base64url'), now = Date.now();
  const entries: AdmissionPolicyKey[] = [0, 1].map(i => ({
    profile: { version: 1, scope: { issuer: 'paged-relay', community: 'public', epoch: 'period-' + i },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      relayUrls: ['ws://127.0.0.1:39000/'] },
    notBefore: now - 5000, issueUntil: now + (i ? 200000 : -4000),
    spendUntil: now + (i ? 400000 : -3000), retryUntil: now + (i ? 600000 : -2000),
  }));
  const oldKey = admissionKeyFingerprint(entries[0].profile.issuerPublicKey), activeKey = admissionKeyFingerprint(entries[1].profile.issuerPublicKey);
  const genesis = await signAdmissionPolicy({ version: 2, kind: 'admission-policy', revision: 1, issuedAt: now - 1000,
    expiresAt: now + 3600000, activeKey, keys: [entries[1]], archivedKeys: [entries[0]] }, authority, signingKey.secretKey);
  const members = h.memberKeys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: 'ws://127.0.0.1:' + (38000 + i) + '/history-checkpoint' }));
  const observers = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(genesis), quorum: 4, members });
  const limits: AdmissionPolicyArchiveLimits = { maxPages: 256, maxEntries: 16384, maxArchiveBytes: 64 * 1024 * 1024,
    maxHistoryBytes: 256 * 1024 * 1024, maxTransitions: 100, maxPageReads: 20000, timeoutMs: 3000 };
  const pages = new Map<string, Uint8Array>();
  const reader = async (digest: string) => { const bytes = pages.get(digest); if (!bytes) throw new Error('Missing original page'); return bytes; };
  const resolved = await resolveAdmissionPolicy({ context: observers, genesis, advances: [], selectedHead: observers.genesis, reader, limits });
  const plan = await prepareAdmissionPolicyV3Successor({ previous: resolved, next: { revision: 2, issuedAt: now,
    expiresAt: now + 3600000, activeKey, keys: [entries[1]] }, reader, limits });
  plan.pages.forEach(page => pages.set(page.digest, page.bytes));
  const policy = await signAdmissionPolicyV3(plan.body, authority, signingKey.secretKey);
  const advance = await createResolvedAdmissionPolicyAdvance({ previous: resolved, policy, key: signingKey, reader, limits });
  const head = advance.advance.commitment.next;
  const context = { ...h.context, authority, policyDigest: 'sha256:' + admissionPolicyDigest(genesis) };
  const binding = createAdmissionRequestBindingV2('search', { retained: 'paged relay obligations' });
  const legacy = { spend: randomBytes(32).toString('base64url'), action: 'search', binding, issuerKey: null };
  const old = { ...legacy, spend: randomBytes(32).toString('base64url'), issuerKey: oldKey };
  const rows = [0, 64, 100].map(generation => ({ spend: randomBytes(32).toString('base64url'), action: 'search', binding, issuerKey: activeKey, generation }));
  const image: AdmissionHistoryImage = { version: 1, kind: 'admission-spend-checkpoint', policy: genesis,
    state: { version: 2, authority, spends: [legacy, old], retiredIssuerKeys: [] }, proofVersion: 1,
    policyProof: admissionPolicyProofReference(observers, observers.genesis, limits),
    policyProofAppend: { version: 1, kind: 'genesis', policy: genesis },
    policyTrust: { context: observers, installed: observers.genesis, observed: observers.genesis } };
  const root = sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
    plaintext: Buffer.from(JSON.stringify(image)), encryptionKey: h.key, signingKey: h.owner });
  const n = historyOriginalPoolFixture({ context, root, encryptionKey: h.key, owner: h.owner, memberKeys: h.memberKeys }); cleanup.push(n.close);
  const installed: AdmissionHistoryImage = { ...image, policy, policyProof: admissionPolicyProofReference(observers, head, limits),
    policyProofAppend: { version: 1, kind: 'advance', advance: advance.advance,
      pages: plan.pages.map(page => ({ digest: page.digest, data: Buffer.from(page.bytes).toString('base64url') })) },
    policyTrust: { context: observers, installed: head, observed: head } };
  n.append({ version: 1, kind: 'admission-policy-proof-checkpoint', at: now, image: installed });
  n.append({ version: 1, kind: 'retire', at: now, issuerKey: oldKey }, 'delta');
  let proposal!: ReturnType<typeof n.select>;
  for (let generation = 0; generation <= 100; generation++) {
    const row = rows.find(row => row.generation === generation);
    if (row) { const { generation: _, ...retained } = row; n.append({ version: 1, kind: 'spend', at: now, row: retained }, 'delta'); }
    proposal = n.select();
    if (generation === 0 || generation === 64 || generation === 100) {
      n.reopen(); const blocks = n.blocks();
      const result = await replayAdmissionHistory({ context, genesisId: n.genesisId, proposal, encryptionKey: h.key, blocks, blockSource: () => blocks });
      expect(result.generations).toBe(generation + 1);
      expect(result.image.state).toEqual({ version: 2, authority, spends: [legacy, ...rows.filter(row => row.generation <= generation).map(({ generation: _, ...row }) => row)], retiredIssuerKeys: [oldKey] });
      expect(result.image.policyProof).toEqual(installed.policyProof); expect(result.image.policyTrust).toEqual(installed.policyTrust);
      expect(n.services().every(service => service.describe().generations === generation + 1)).toBe(true);
      const checkpoint = n.measurement();
      expect(checkpoint.pools.every(pool => pool!.peakBytes <= 256 * 1024 * 1024)).toBe(true);
      writeFileSync(join(tmpdir(), 'resonance-original-pool-relay-' + (generation + 1) + '.json'), JSON.stringify(checkpoint, null, 2));
      process.stdout.write(JSON.stringify({ test: 'relay-paged-replay', generations: generation + 1, elapsedMs: performance.now() - started }) + '\n');
    }
    if (generation < 100) n.rotate(proposal);
  }
  const blocks = n.blocks(), boundary = blocks.findIndex(block => block.generation === 64);
  const replay = (extra: Partial<Parameters<typeof replayAdmissionHistory>[0]> = {}) => replayAdmissionHistory({
    context, genesisId: n.genesisId, proposal, encryptionKey: h.key, blocks, blockSource: () => blocks, ...extra });
  for (const damage of ['gap', 'reorder', 'mismatch', 'blocks', 'bytes', 'incomplete'] as const) {
    const altered = [...blocks];
    if (damage === 'gap') altered.splice(boundary, 1);
    if (damage === 'reorder') [altered[boundary - 1], altered[boundary]] = [altered[boundary], altered[boundary - 1]];
    if (damage === 'mismatch') altered[boundary] = altered[boundary + 1];
    if (damage === 'incomplete') altered.splice(boundary);
    await expect(replay({ blocks: altered,
      ...(damage === 'blocks' ? { maxBlocks: boundary + 1 } : {}),
      ...(damage === 'bytes' ? { maxBytes: blocks.slice(0, boundary + 1).reduce((total, block) => total + Buffer.byteLength(JSON.stringify(block)), 0) } : {}) })).rejects.toThrow();
  }
  const controller = new AbortController(); let closed = false;
  function* cancelled() { try { for (const block of blocks) { if (block.generation === 64) controller.abort(); yield block; } } finally { closed = true; } }
  await expect(replay({ blocks: cancelled(), signal: controller.signal })).rejects.toThrow(/cancelled|timed out/); expect(closed).toBe(true);
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  function* delayed() { for (const block of blocks) { if (block.generation === 64 && !clock) { const now = performance.now.bind(performance); clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + 30001); } yield block; } }
  try { await expect(replay({ blocks: delayed() })).rejects.toThrow(/cancelled|timed out/); } finally { clock?.mockRestore(); }
  const download = n.download(proposal); cleanup.push(download.close);
  expect((await download.run({ maxBlocks: blocks.length })).complete).toBe(true);
  const selected = () => download.blocks();
  const selectedResult = await replay({ blocks: selected(), blockSource: selected });
  expect(selectedResult.generations).toBe(101);
  const expected = { version: 2, authority,
    spends: [legacy, ...rows.map(({ generation: _, ...row }) => row)], retiredIssuerKeys: [oldKey] };
  expect(selectedResult.image.state).toEqual(expected);
  expect(selectedResult.image.policyProof).toEqual(installed.policyProof);
  expect(selectedResult.image.policyTrust).toEqual(installed.policyTrust);
  n.rotate(proposal);
  const continuation = n.blocks().at(-1)!; if (continuation.kind !== 'continuation') throw new Error('Expected provisioned continuation');
  const destination = join(n.directory, 'restored-owner');
  const preparation = await prepareAdmissionHistoryRestore({ directory: destination, context, genesisId: n.genesisId, continuation,
    policy, now: () => now, encryptionKey: h.key, blocks: selected(), blockSource: selected }); cleanup.push(preparation.close!);
  const history = await n.run(() => openProtectedAdmissionSpendHistory({ directory: destination, authority, policy, now: () => now, encryptionKey: h.key, initialize: true,
    protection: { context, signingKey: h.owner, members: n.members, timeoutMs: 30000, ancestrySource: selected, initializeWriter: true, initializeArchive: true,
      transport: async (member, frame) => n.services()[context.members.indexOf(member.publicKey)].checkpoint(frame),
      restore: { preparation, approvedDigest: preparation.review.approvalDigest } } })); cleanup.push(history.close);
  await history.ready(); expect(history.read().image.state).toEqual(expected);
  expect(() => history.planCheckpointCertification()).toThrow('proof-preserving');
  const measured = { role: 'relay-admission-spends', durationMs: performance.now() - started, selectedGenerations: selectedResult.generations, ...n.measurement() };
  writeFileSync(join(tmpdir(), 'resonance-original-pool-relay.json'), JSON.stringify(measured, null, 2));
  expect(measured.pools.every(pool => pool!.pages === 2 && pool!.peakBytes <= 256 * 1024 * 1024)).toBe(true);
}, 300000);
