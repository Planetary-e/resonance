import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { historyCheckpointEnvelopeId, historyDigest, createHistoryFreeze, sealHistoryCheckpoint, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal, historySuccessorProposalId } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryAgreementRequest, createHistoryAgreementVote } from '@resonance/core/history-agreement';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { historyCheckpointFixture } from '../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { createHistoryCheckpointWriter, HISTORY_WRITER_FILENAME } from '../../../relay/src/history-checkpoint-quorum.js';
import { HISTORY_WRITER_ARCHIVE_FILENAME } from '../../../relay/src/history-writer-archive.js';
import type { HistoryCheckpointTransport } from '../../../relay/src/history-checkpoint-exchange.js';
import type { ProtectedCheckpointOwnerState } from '../../../relay/src/protected-checkpoint-owner.js';
import { PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN } from '../../../relay/src/protected-allocation-authority-history.js';
import { allocationAuthorityHistoryAnchor, deriveAdmissionAllocationAuthorityEncryptionKey, type AdmissionAllocationAuthorityState as State } from '../admission-allocation-authority-state.js';
import { prepareProtectedAllocationAuthorityRestore } from '../admission-allocation-authority-history-restore.js';
import { openProtectedAdmissionAllocationAuthority } from '../protected-admission-allocation-authority.js';
import { openProtectedAllocationAuthorityRestoreResumption, type ProtectedAllocationAuthorityRestoreResumptionOptions } from '../admission-allocation-authority-restore-resumption.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(stage: 'owner' | 'writer' | 'archive' = 'owner') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'authority-resumption-'))), h = historyCheckpointFixture(), authorityKey = generateSigningKeyPair();
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => { h.owner.secretKey.fill(0); h.memberKeys.forEach(member => member.secretKey.fill(0)); authorityKey.secretKey.fill(0); key.fill(0); });
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url'), key = deriveAdmissionAllocationAuthorityEncryptionKey(authorityKey.secretKey, authority);
  const context = { ...h.context, role: 'admission-allocation-authority' as const, authority, policyDigest: allocationAuthorityHistoryAnchor(authority) };
  const image: State = { version: 2, authority, manifests: [], assignments: [] };
  const genesis = sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null }, plaintext: Buffer.from(JSON.stringify(image)), encryptionKey: key, signingKey: h.owner });
  const genesisId = historyCheckpointEnvelopeId(genesis), challenge = randomBytes(32).toString('base64url'), freeze = createHistoryFreeze(context, 0, 1, challenge, h.owner);
  const receipts = h.memberKeys.slice(0, 4).map((member, i) => {
    const request = createHistoryExchangeRequest({ action: 'freeze', rootId: genesisId, generation: 0, replica: context.members[i], challenge, issuedAt: 100, expiresAt: 200, sequence: 1, envelopeId: null }, context, h.owner);
    return createHistoryExchangeResponse(request, 'frozen', { rootId: genesisId, generation: 0, sequence: 0, envelopeId: genesisId, freeze }, null, context, member);
  });
  const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId: genesisId, generation: 0, nextGeneration: 1, receipts, envelopes: [genesis] }, context, h.owner);
  const votes = h.memberKeys.slice(0, 4).map((member, i) => createHistoryAgreementVote(createHistoryAgreementRequest({ action: 'confirm', rootId: genesisId, generation: 0, nextGeneration: 1,
    replica: context.members[i], challenge, view: 1, issuedAt: 100, expiresAt: 200, proposalId: historySuccessorProposalId(proposal), evidenceId: historyDigest('prepared') }, context, h.owner), context, member));
  const root = createHistoryContinuationRoot(proposal, { version: 2, kind: 'history-agreement-certificate', phase: 'confirmed', votes }, context);
  const destination = { path: join(directory, 'authority.json'), writerDirectory: join(directory, 'writer') }, members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${45001 + i}/history-checkpoint` }));
  let online = 5, head: HistoryCheckpointEnvelope = root, frozen = false, calls = 0;
  const transport: HistoryCheckpointTransport = async (member, frame) => {
    calls++; const i = context.members.indexOf(member.publicKey); if (i >= online) throw new Error('offline');
    if (frame.envelope) head = frame.envelope;
    const currentFreeze = frozen ? createHistoryFreeze(context, head.generation, head.generation + 1, challenge, h.owner) : null;
    return createHistoryExchangeResponse(frame.request, frame.request.action === 'head' ? 'head' : frame.request.action === 'install' ? 'installed' : 'stored',
      { rootId: historyCheckpointEnvelopeId(root), generation: root.generation, sequence: head.sequence, envelopeId: historyCheckpointEnvelopeId(head), freeze: currentFreeze }, null, context, h.memberKeys[i]);
  };
  const replay = { context, genesisId, authority, encryptionKey: key, blocks: [genesis], continuation: root };
  const preparation = await prepareProtectedAllocationAuthorityRestore({ ...replay, destination });
  const business = { path: destination.path, authority, secretKey: authorityKey.secretKey, mode: 'open-existing' as const,
    protection: { context, signingKey: h.owner, members, writerDirectory: destination.writerDirectory, transport, timeoutMs: 1000 } };
  const restored = await openProtectedAdmissionAllocationAuthority({ ...business, mode: 'create-new', restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); restored.close();
  if (stage === 'owner') rmSync(destination.writerDirectory, { recursive: true });
  if (stage === 'writer') rmSync(join(destination.writerDirectory, 'payloads'), { recursive: true });
  const options: ProtectedAllocationAuthorityRestoreResumptionOptions = { ...replay, destination, secretKey: authorityKey.secretKey, signingKey: h.owner, members, transport, timeoutMs: 1000 };
  return { directory, options, destination, key, h, image, business, get calls() { return calls; }, online(count: number) { online = count; }, later() {
    head = sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: root.generation, sequence: 1, previous: historyCheckpointEnvelopeId(root) }, plaintext: Buffer.from(JSON.stringify(image)), encryptionKey: key, signingKey: h.owner });
  }, freeze() { frozen = true; } };
}
it.each(['owner', 'writer', 'archive'] as const)('resumes the authenticated pristine %s prefix without changing owner bytes or granting readiness', async stage => {
  const n = await fixture(stage), before = readFileSync(n.destination.path), resumption = await openProtectedAllocationAuthorityRestoreResumption(n.options); cleanup.push(resumption.close);
  const review = resumption.review(), { approvalDigest, ...details } = review;
  expect(review).toMatchObject({ kind: 'protected-allocation-authority-restoration-resumption', initializeWriter: stage === 'owner', initializeArchive: stage !== 'archive', readiness: 'unverified', startsService: false });
  expect(approvalDigest).toBe(historyDigest(`resonance:protected-allocation-authority-restoration-resumption:v1\n${JSON.stringify([details, historyDigest(n.key)])}`));
  if (stage !== 'archive') { n.online(3); await expect(resumption.apply(approvalDigest)).rejects.toThrow('Four current'); }
  n.online(4); expect(await resumption.apply(approvalDigest)).toMatchObject({ result: 'protected-allocation-authority-restoration-resumed', readiness: 'unverified', startsService: false, status: { ready: false, pending: true } });
  expect(readFileSync(n.destination.path)).toEqual(before); resumption.close();
  const ledger = await openProtectedAdmissionAllocationAuthority(n.business); cleanup.push(ledger.close); expect(ledger.status().protection.ready).toBe(false); await ledger.ready();
  expect(ledger.status().protection).toMatchObject({ ready: true, pending: false });
});
it.each(['later', 'frozen'] as const)('requires four exact unfrozen root heads before creating missing components: %s', async mode => {
  const n = await fixture(), handle = await openProtectedAllocationAuthorityRestoreResumption(n.options); cleanup.push(handle.close);
  if (mode === 'later') n.later(); else n.freeze();
  await expect(handle.apply(handle.review().approvalDigest)).rejects.toThrow('Four current'); expect(existsSync(n.destination.writerDirectory)).toBe(false);
});
it('rejects wrong independent keys, bounds, replay and raw semantic or role overrides', async () => {
  const n = await fixture(), before = readFileSync(n.destination.path);
  await expect(openProtectedAllocationAuthorityRestoreResumption({ ...n.options, secretKey: generateSigningKeyPair().secretKey })).rejects.toThrow('does not match');
  await expect(openProtectedAllocationAuthorityRestoreResumption({ ...n.options, signingKey: generateSigningKeyPair() })).rejects.toThrow('pins or keys');
  await expect(openProtectedAllocationAuthorityRestoreResumption({ ...n.options, encryptionKey: randomBytes(32) })).rejects.toThrow();
  await expect(openProtectedAllocationAuthorityRestoreResumption({ ...n.options, blocks: [] })).rejects.toThrow('selected generation');
  await expect(openProtectedAllocationAuthorityRestoreResumption({ ...n.options, maxArchiveBlocks: 0 })).rejects.toThrow('bounds');
  await expect(openProtectedAllocationAuthorityRestoreResumption({ ...n.options, maxArchiveBytes: 1 })).rejects.toThrow('bounds');
  for (const override of [{ role: 'admission-issuer' }, { domain: 'other' }, { validate: () => n.image }, { restore: {} }, { strategy: {} }]) {
    await expect(openProtectedAllocationAuthorityRestoreResumption(Object.assign({}, n.options, override))).rejects.toThrow('fixed');
  }
  expect(readFileSync(n.destination.path)).toEqual(before); expect(existsSync(n.destination.writerDirectory)).toBe(false);
});
it('preserves retained evidence instead of repairing a later writer, committed missing archive or changed owner baseline', async () => {
  const n = await fixture('writer'), root = n.options.continuation;
  const writer = createHistoryCheckpointWriter({ directory: n.destination.writerDirectory, localKey: n.key, signingKey: n.h.owner, context: n.options.context,
    rootId: historyCheckpointEnvelopeId(root), generation: root.generation, continuation: root, members: n.options.members, timeoutMs: 1000, transport: n.options.transport });
  await writer.replicate(root); writer.close(); const before = readFileSync(join(n.destination.writerDirectory, HISTORY_WRITER_FILENAME));
  await expect(openProtectedAllocationAuthorityRestoreResumption(n.options)).rejects.toThrow('Committed allocation authority archive is missing');
  expect(readFileSync(join(n.destination.writerDirectory, HISTORY_WRITER_FILENAME))).toEqual(before);
  expect(existsSync(join(n.destination.writerDirectory, 'payloads', HISTORY_WRITER_ARCHIVE_FILENAME))).toBe(false);
  const raw = openEncryptedLocalState<ProtectedCheckpointOwnerState<State>>({ path: n.destination.path, key: n.key, domain: PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN,
    mode: 'open-existing', maxBytes: 32 * 1024 * 1024, initial: undefined as unknown as ProtectedCheckpointOwnerState<State>, validate: (value): value is ProtectedCheckpointOwnerState<State> => !!value });
  const state = raw.read(); if (state.version !== 2) throw new Error('fixture'); state.restoration.replayDigest = historyDigest('tampered'); raw.write(state); raw.close();
  await expect(openProtectedAllocationAuthorityRestoreResumption(n.options)).rejects.toThrow('independently replayed');
});
it('refuses a later accepted writer suffix even when its original owner remains pending', async () => {
  const n = await fixture('archive'), root = n.options.continuation;
  const writer = createHistoryCheckpointWriter({ directory: n.destination.writerDirectory, localKey: n.key, signingKey: n.h.owner, context: n.options.context,
    rootId: historyCheckpointEnvelopeId(root), generation: root.generation, continuation: root, members: n.options.members, timeoutMs: 1000, transport: n.options.transport });
  await writer.replicate(root);
  const later = sealHistoryCheckpoint({ context: n.options.context, header: { kind: 'checkpoint', generation: root.generation, sequence: 1, previous: historyCheckpointEnvelopeId(root) },
    plaintext: Buffer.from(JSON.stringify(n.image)), encryptionKey: n.key, signingKey: n.h.owner });
  await writer.replicate(later); writer.close();
  const before = readFileSync(join(n.destination.writerDirectory, HISTORY_WRITER_FILENAME));
  await expect(openProtectedAllocationAuthorityRestoreResumption(n.options)).rejects.toThrow('later accepted suffix');
  expect(readFileSync(join(n.destination.writerDirectory, HISTORY_WRITER_FILENAME))).toEqual(before);
});
it('binds retained file bytes and preserves applied history with missing components', async () => {
  const n = await fixture(), handle = await openProtectedAllocationAuthorityRestoreResumption(n.options); cleanup.push(handle.close);
  mkdirSync(n.destination.writerDirectory); writeFileSync(join(n.destination.writerDirectory, 'unexpected'), 'evidence');
  await expect(handle.apply(handle.review().approvalDigest)).rejects.toThrow('files changed'); handle.close(); rmSync(n.destination.writerDirectory, { recursive: true });
  const next = await openProtectedAllocationAuthorityRestoreResumption(n.options); cleanup.push(next.close); await next.apply(next.review().approvalDigest); next.close();
  const ledger = await openProtectedAdmissionAllocationAuthority(n.business); await ledger.ready(); ledger.close();
  rmSync(join(n.destination.writerDirectory, 'payloads'), { recursive: true });
  await expect(openProtectedAllocationAuthorityRestoreResumption(n.options)).rejects.toThrow('Missing components beside applied');
});
it('snapshots and wipes owned authority secrets on early and asynchronous failures and successful close', async () => {
  const n = await fixture(), secret = Uint8Array.from(n.options.secretKey), copy = vi.spyOn(Uint8Array, 'from');
  async function ownedFailure(options: ProtectedAllocationAuthorityRestoreResumptionOptions, message: string) {
    copy.mockClear(); await expect(openProtectedAllocationAuthorityRestoreResumption(options)).rejects.toThrow(message);
    const index = copy.mock.calls.findIndex(args => args[0] === secret); expect(index).toBeGreaterThanOrEqual(0);
    const owned = copy.mock.results[index].value as Uint8Array; expect(owned.every(byte => byte === 0)).toBe(true);
  }
  await ownedFailure({ ...n.options, secretKey: secret, signingKey: { publicKey: n.h.owner.publicKey, secretKey: new Uint8Array(1) } }, 'key');
  await ownedFailure({ ...n.options, secretKey: secret, members: [] }, 'five');
  const controller = new AbortController(); controller.abort(); await ownedFailure({ ...n.options, secretKey: secret, signal: controller.signal }, 'cancelled');
  copy.mockClear(); const opening = openProtectedAllocationAuthorityRestoreResumption({ ...n.options, secretKey: secret }); secret.fill(0);
  const handle = await opening; cleanup.push(handle.close); const index = copy.mock.calls.findIndex(args => args[0] === secret);
  const owned = copy.mock.results[index].value as Uint8Array; expect(owned.every(byte => byte === 0)).toBe(true);
  handle.close(); expect(owned.every(byte => byte === 0)).toBe(true); expect(n.options.secretKey.some(byte => byte !== 0)).toBe(true);
});
it('snapshots encryption key, independent signer, member endpoints and limits before awaiting replay', async () => {
  const n = await fixture(), encryptionKey = Uint8Array.from(n.key), signer = structuredClone(n.h.owner), members = structuredClone(n.options.members);
  const options = { ...n.options, encryptionKey, signingKey: signer, members, maxArchiveBlocks: 16, maxArchiveBytes: 1024 * 1024 };
  const opening = openProtectedAllocationAuthorityRestoreResumption(options);
  encryptionKey.fill(0); signer.secretKey.fill(0); members[0].endpoint = 'ws://127.0.0.1:1/changed'; options.maxArchiveBlocks = 0; options.maxArchiveBytes = 0; options.timeoutMs = 1;
  const handle = await opening; cleanup.push(handle.close);
  expect(handle.review()).toMatchObject({ limits: { archiveBytes: 1024 * 1024, archiveBlocks: 16 }, timeoutMs: 1000, members: n.options.members });
  expect(await handle.apply(handle.review().approvalDigest)).toMatchObject({ readiness: 'unverified', startsService: false });
});
it('retains construction storage authority when apply escapes and refuses switching authorities', async () => {
  const n = await fixture(), requests: string[] = [];
  const authority = { reserve(request: { path: string }) { requests.push(request.path); if (request.path.startsWith(n.destination.writerDirectory)) throw new Error('writer reservation denied'); return { assertWritable() {} }; } };
  const handle = await withStorageReservationAuthority(authority, () => openProtectedAllocationAuthorityRestoreResumption(n.options)); cleanup.push(handle.close);
  const switched = { reserve() { return { assertWritable() {} }; } };
  await expect(withStorageReservationAuthority(switched, () => handle.apply(handle.review().approvalDigest))).rejects.toThrow('switch its storage authority');
  await expect(handle.apply(handle.review().approvalDigest)).rejects.toThrow('writer reservation denied');
  expect(requests.some(path => path.startsWith(n.destination.writerDirectory))).toBe(true); expect(existsSync(n.destination.writerDirectory)).toBe(false);
});
it.skipIf(process.platform === 'win32')('retains the original requested path after alias retargeting and caller mutation', async () => {
  const n = await fixture(), first = join(n.directory, 'a'), second = join(n.directory, 'b'), link = join(n.directory, 'selected'); mkdirSync(first); mkdirSync(second);
  symlinkSync(n.directory, link, 'dir');
  const options = { ...n.options, destination: { path: join(link, 'authority.json'), writerDirectory: join(link, 'writer') } };
  const handle = await openProtectedAllocationAuthorityRestoreResumption(options); cleanup.push(handle.close);
  rmSync(link); symlinkSync(second, link, 'dir');
  options.destination.path = n.destination.path; options.destination.writerDirectory = n.destination.writerDirectory;
  await expect(handle.apply(handle.review().approvalDigest)).rejects.toThrow('destinations changed'); expect(existsSync(n.destination.writerDirectory)).toBe(false);
});
