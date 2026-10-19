/** Real stores, signed freeze/recovery, persisted agreement and provisioned children. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, lstatSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { HISTORY_SHARED_CATALOG, openSharedHistoryPool } from '../../history-shared-pool.js';
import type { SigningKeyPair } from '@resonance/core';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { createHistoryFreeze, historyCheckpointContextId, historyCheckpointEnvelopeId, sealHistoryCheckpoint, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal, historySuccessorProposalId, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryAgreementRequest, historyAgreementEvidenceId, parseHistoryAgreementCertificate, parseHistoryViewCertificate, type HistoryAgreementFrame, type HistoryAgreementRequest } from '@resonance/core/history-agreement';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryProvisionRequest } from '@resonance/core/history-provision';
import { createHistoryAncestryDownload } from '../../history-ancestry-download.js';
import { openHistoryVolunteerService } from '../../history-volunteer-service.js';
export function historyOriginalPoolFixture(o: { context: HistoryCheckpointContext; root: HistoryCheckpointEnvelope; encryptionKey: Uint8Array; owner: SigningKeyPair; memberKeys: SigningKeyPair[] }) {
  const directory = mkdtempSync(join(tmpdir(), 'original-pool-v2-')), genesisId = historyCheckpointEnvelopeId(o.root);
  const authority = openStorageReservationAuthority({ directory: join(directory, 'funding'), mode: 'create-new', limitBytes: 2 * 1024 * 1024 * 1024 });
  const memberKeys = o.context.members.map(member => o.memberKeys.find(k => Buffer.from(k.publicKey).toString('base64url') === member)!);
  const localKeys = memberKeys.map(() => randomBytes(32)), members = o.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${38000 + i}/history-checkpoint` }));
  const options = memberKeys.map((signingKey, i) => ({ storageVersion: 2 as const, directory: join(directory, `replica-${i}`), localKey: localKeys[i], context: o.context, signingKey, genesisId }));
  let services = withStorageReservationAuthority(authority, () => options.map(p => openHistoryVolunteerService({ ...p, initialize: o.root })));
  let root = o.root, chain: HistoryCheckpointEnvelope[] = [root];
  function append(value: unknown) {
    const previous = chain.at(-1)!, block = sealHistoryCheckpoint({ context: o.context, header: { kind: 'checkpoint', generation: root.generation, sequence: previous.sequence + 1,
      previous: historyCheckpointEnvelopeId(previous) }, plaintext: Buffer.from(JSON.stringify(value)), encryptionKey: o.encryptionKey, signingKey: o.owner });
    const issuedAt = Date.now();
    services.forEach((s, i) => s.checkpoint({ request: createHistoryExchangeRequest({ action: 'append', rootId: historyCheckpointEnvelopeId(root), generation: root.generation,
      replica: o.context.members[i], challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000, sequence: block.sequence, envelopeId: historyCheckpointEnvelopeId(block) }, o.context, o.owner), envelope: block }));
    chain.push(block);
  }
  function select() {
    const rootId = historyCheckpointEnvelopeId(root), generation = root.generation, nextGeneration = generation + 1, issuedAt = Date.now(), expiresAt = issuedAt + 30000, challenge = randomBytes(32).toString('base64url');
    const freeze = createHistoryFreeze(o.context, generation, nextGeneration, challenge, o.owner);
    const receipts = services.map((s, i) => s.checkpoint({ request: createHistoryExchangeRequest({ action: 'freeze', rootId, generation, replica: o.context.members[i], challenge,
      issuedAt, expiresAt, sequence: nextGeneration, envelopeId: null }, o.context, o.owner), envelope: null, freeze }));
    return createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation, nextGeneration, receipts: receipts.slice(0, 4), envelopes: chain }, o.context, o.owner);
  }
  function rotate(proposal: HistorySuccessorProposal) {
    const issuedAt = Date.now(), expiresAt = issuedAt + 30000, challenge = randomBytes(32).toString('base64url');
    function frames(action: HistoryAgreementRequest['action'], proof: HistoryAgreementFrame['viewCertificate'] | HistoryAgreementFrame['preparedCertificate'] = null): HistoryAgreementFrame[] {
      return o.context.members.map(replica => ({ request: createHistoryAgreementRequest({ action, rootId: proposal.rootId, generation: proposal.generation, nextGeneration: proposal.nextGeneration,
        replica, view: 1, challenge, issuedAt, expiresAt, proposalId: action === 'promise' ? null : historySuccessorProposalId(proposal), evidenceId: proof && historyAgreementEvidenceId(proof) }, o.context, o.owner),
        proposal: action === 'promise' ? null : proposal, viewCertificate: proof?.kind === 'history-view-certificate' ? proof : null,
        preparedCertificate: proof?.kind === 'history-agreement-certificate' ? proof : null }));
    }
    const promise = frames('promise'), view = parseHistoryViewCertificate({ version: 2, kind: 'history-view-certificate', reports: services.slice(0, 4).map((s, i) => s.exchange(promise[i])) }, o.context);
    const preparing = frames('prepare', view), prepared = parseHistoryAgreementCertificate({ version: 2, kind: 'history-agreement-certificate', phase: 'prepared', votes: services.slice(0, 4).map((s, i) => s.exchange(preparing[i])) }, o.context);
    const confirming = frames('confirm', prepared), confirmed = parseHistoryAgreementCertificate({ version: 2, kind: 'history-agreement-certificate', phase: 'confirmed', votes: services.slice(0, 4).map((s, i) => s.exchange(confirming[i])) }, o.context, 'confirmed');
    root = createHistoryContinuationRoot(proposal, confirmed, o.context);
    services.forEach((s, i) => s.provision(createHistoryProvisionRequest({ replica: o.context.members[i], challenge, issuedAt, expiresAt, root: root as ReturnType<typeof createHistoryContinuationRoot> }, o.context, o.owner)));
    chain = [root];
  }
  function reopen() { services.forEach(s => s.close()); services = withStorageReservationAuthority(authority, () => options.map(p => openHistoryVolunteerService(p))); }
  function measurement() {
    const files: Array<{ path: string; bytes: number }> = [];
    function scan(path: string) { for (const name of readdirSync(path)) { const file = join(path, name), stat = lstatSync(file); if (stat.isDirectory()) scan(file); else files.push({ path: file.slice(directory.length + 1), bytes: stat.size }); } }
    scan(directory); return { generations: services[0].describe().generations, files: files.length, actualBytes: files.reduce((n, f) => n + f.bytes, 0), pools: services.map(s => s.originalStorageUsage()), funding: authority.status(), memory: process.memoryUsage() };
  }
  return { directory, services: () => services, members, genesisId, append, select, rotate, reopen, measurement,
    blocks: () => [...services[0].originalBlocks()],
    refuseCatalogMutation(mutate: (value: any) => void) {
      services.forEach(s => s.close()); const path = join(options[0].directory, HISTORY_SHARED_CATALOG), original = readFileSync(path);
      const state = openEncryptedLocalState<any>({ path, key: localKeys[0], domain: `resonance:history-original-pool:v2\n${JSON.stringify([historyCheckpointContextId(o.context), genesisId, o.context.members[0]])}`,
        maxBytes: 2 * 1024 * 1024, initial: null, validate: (value): value is any => true, mode: 'open-existing' });
      const value = state.read(); mutate(value); state.write(value); state.close();
      let refused = false;
      try { const p = withStorageReservationAuthority(authority, () => openSharedHistoryPool({ directory: options[0].directory, context: o.context, replica: o.context.members[0], genesisId, localKey: localKeys[0] })); p.close(); }
      catch { refused = true; }
      finally { writeFileSync(path, original); reopen(); }
      return refused;
    },
    download(proposal: HistorySuccessorProposal, initialize = true, extra: Partial<Parameters<typeof createHistoryAncestryDownload>[0]> = {}) {
      return withStorageReservationAuthority(authority, () => createHistoryAncestryDownload({ directory: join(directory, 'download'), localKey: localKeys[0], context: o.context,
        signingKey: o.owner, proposal, members, initialize, transport: async (member, frame) => services[o.context.members.indexOf(member.publicKey)].checkpoint(frame), ...extra }));
    },
    close() { services.forEach(s => s.close()); authority.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
