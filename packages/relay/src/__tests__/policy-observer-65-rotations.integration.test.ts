import { afterEach, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { parseAdmissionWitnessSet } from '@resonance/core/admission-witness';
import { createResolvedAdmissionPolicyAdvance, inspectResolvedAdmissionPolicy, lookupResolvedAdmissionPolicyKey, prepareAdmissionPolicyV3Successor,
  resolveAdmissionPolicy, signAdmissionPolicyV3, visitResolvedAdmissionPolicyArchive, type ArchivedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
import { historyCheckpointEnvelopeId, openHistoryCheckpoint, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver, exchangeAdmissionPolicyObserverFrame, exchangeAdmissionPolicyObservation } from '../admission-policy-observation-transport.js';
import { POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES } from '../policy-observer-page-transfer.js';
import { createPolicyObserverPageReader, policyObserverArchiveLimits } from '../policy-observer-page-reader.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function retainDiagnostic(trace: unknown[], value: unknown) { if (trace.length === 16) trace.shift(); trace.push(value); }
function observerDiagnosticFailure(error: unknown, evidence: { operation: string; elapsedMs: number; completed: unknown[]; handlerFailures: unknown[]; pageExchanges: unknown[] }) {
  const details = { operation: evidence.operation, elapsedMs: evidence.elapsedMs, error: String(error).slice(0, 512),
    completed: evidence.completed.slice(-6), handlerFailures: evidence.handlerFailures.slice(-4), pageExchanges: evidence.pageExchanges.slice(-8) };
  // Error text survives CI reporters that suppress successful console output.
  return new Error(`Observer65 diagnostic: ${JSON.stringify(details)}`, { cause: error });
}

it('retains the local handler cause and stage in diagnostic errors after a real transport 4003 refusal', async () => {
  const handlerFailures: unknown[] = [];
  const listener = await listenAdmissionPolicyObserver(async () => {
    const error = new Error('fixture page refused before reply'); retainDiagnostic(handlerFailures, { observer: 0, type: 'page', error: String(error) }); throw error;
  }, { port: 0 }); cleanup.push(listener.close);
  let refusal: unknown;
  try { await exchangeAdmissionPolicyObserverFrame({ endpoint: listener.endpoint, publicKey: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url') },
    { type: 'diagnostic' }, new AbortController().signal, POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES); }
  catch (error) { refusal = error; }
  expect(String(refusal)).toContain('closed (4003)');
  const error = observerDiagnosticFailure(refusal, { operation: 'target-remote-page', elapsedMs: 1, completed: [], handlerFailures, pageExchanges: [] });
  expect(error.message).toContain('target-remote-page'); expect(error.message).toContain('fixture page refused before reply'); expect(error.message).toContain('closed (4003)');
  expect(error.cause).toBe(refusal);
});

// Fixed B-HISTORY-LIFECYCLE prerequisite: no operation deadline, storage cap or
// performance clock is changed. The wrapper includes real RSA fixture generation.
it('retains 65 real rotations through two protected observers, remote pages and reopening', async () => {
  const started = new Date().toISOString(), durations: Array<{ operation: string; ms: number }> = [];
  const diagnosticPath = join(tmpdir(), 'observer-65-diagnostic.json');
  const handlerFailures: unknown[] = [], pageExchanges: unknown[] = [];
  async function measured<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await run(); }
    catch (error) {
      const evidence = { operation, elapsedMs: performance.now() - start, completed: durations, handlerFailures, pageExchanges };
      writeFileSync(diagnosticPath, JSON.stringify({ started, ended: new Date().toISOString(), error: String(error), ...evidence }));
      throw observerDiagnosticFailure(error, evidence);
    }
    finally { durations.push({ operation, ms: performance.now() - start }); }
  }
  const directory = mkdtempSync(join(tmpdir(), 'observer-65-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const authorityKey = generateSigningKeyPair(), keys = Array.from({ length: 5 }, generateSigningKeyPair);
  cleanup.push(() => { authorityKey.secretKey.fill(0); keys.forEach(key => key.secretKey.fill(0)); });
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  let wallTime = Date.now(); const initialTime = wallTime;
  const exchanges: Array<ReturnType<typeof createAdmissionPolicyObserverExchange> | undefined> = [];
  const listeners: Array<Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>> = [];
  for (let i = 0; i < 2; i++) {
    const listener = await listenAdmissionPolicyObserver(async (frame, signal) => {
      if (!exchanges[i]) throw new Error('Fixture observer not enrolled');
      try { return await exchanges[i]!(frame, signal); }
      catch (error) { const type = (frame as { type?: unknown }).type; retainDiagnostic(handlerFailures, { observer: i, type: typeof type === 'string' ? type.slice(0, 64) : 'head', error: String(error).slice(0, 512) }); throw error; }
    }, { port: 0 });
    listeners.push(listener); cleanup.push(listener.close);
  }
  const members = keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'),
    endpoint: i < 2 ? listeners[i].endpoint : `ws://127.0.0.1:${49990 + i}/policy-head` }));
  const witnesses = parseAdmissionWitnessSet({ version: 1, quorum: 4, members, coordinators: [authority] });
  // Each issuer key is generated exactly once, before any rotation is exercised.
  const entries: AdmissionPolicyKey[] = Array.from({ length: 66 }, (_, i) => ({
    profile: { version: 1, scope: { issuer: 'observer-65', community: 'public', epoch: `rotation-${i}` },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      relayUrls: ['ws://127.0.0.1:33000/'] },
    notBefore: initialTime + i * 1000, issueUntil: initialTime + i * 1000 + 100,
    spendUntil: initialTime + i * 1000 + 200, retryUntil: initialTime + i * 1000 + 300, witnesses,
  }));
  const fields = (i: number) => ({ revision: i + 1, issuedAt: initialTime + i * 1000, expiresAt: initialTime + 120000,
    activeKey: admissionKeyFingerprint(entries[i].profile.issuerPublicKey), keys: [entries[i]] });
  const genesis = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', ...fields(0) }, authority, authorityKey.secretKey);
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority,
    genesis: admissionPolicyHead(genesis), quorum: 4, members });
  let pageRequests = 0;
  async function enroll(index: number) {
    const signingKey = keys[index], encryptionKey = randomBytes(32);
    cleanup.push(() => { encryptionKey.fill(0); });
    const enrolled = await createPolicyObserverHistoryRoot({ context, signingKey, encryptionKey, policy: genesis, now: () => wallTime });
    const rootId = historyCheckpointEnvelopeId(enrolled.root);
    const stores = enrolled.context.members.map((replica, i) => openHistoryCheckpointStore({
      directory: join(directory, `observer-${index}-replica-${i}`), context: enrolled.context, replica, localKey: randomBytes(32),
      rootId, generation: 0, initialize: enrolled.root,
    }));
    stores.forEach(store => cleanup.push(store.close));
    const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: enrolled.context, store,
      signingKey: keys.find(key => Buffer.from(key.publicKey).toString('base64url') === enrolled.context.members[i])! }));
    roles.forEach(role => cleanup.push(role.close));
    const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
      signal.throwIfAborted(); return roles[enrolled.context.members.indexOf(member.publicKey)].exchange(frame);
    };
    const options = { directory: join(directory, `observer-${index}`), signingKey, encryptionKey, context,
      historyContext: enrolled.context, root: enrolled.root, now: () => wallTime, transport,
      members: enrolled.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${42000 + i}/history-checkpoint` })),
      remoteArchive: { exchange: async (member: typeof members[number], request: unknown, signal: AbortSignal) => {
        pageRequests++; const start = performance.now();
        try { const reply = await exchangeAdmissionPolicyObserverFrame(member, request, signal, POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES); retainDiagnostic(pageExchanges, { observer: index, peer: members.findIndex(value => value.publicKey === member.publicKey), index: (request as { index?: unknown }).index, ms: performance.now() - start, result: 'reply' }); return reply; }
        catch (error) { retainDiagnostic(pageExchanges, { observer: index, peer: members.findIndex(value => value.publicKey === member.publicKey), index: (request as { index?: unknown }).index, ms: performance.now() - start, result: String(error).slice(0, 512) }); throw error; }
      } },
    };
    let observer = await openProtectedPolicyObserver({ ...options, mode: 'create-new' });
    cleanup.push(() => observer.close()); await observer.ready();
    exchanges[index] = createAdmissionPolicyObserverExchange(observer, context, () => wallTime);
    return { get observer() { return observer; }, options, stores, enrolled, async reopen() {
      observer.close(); observer = await openProtectedPolicyObserver({ ...options, mode: 'open-existing' }); return observer;
    } };
  }
  const source = await enroll(0), target = await enroll(1);
  expect(source.enrolled.context.owner).not.toEqual(target.enrolled.context.owner);
  const advances: ArchivedAdmissionPolicyAdvance[] = [];
  let previous = genesis, head = context.genesis;
  async function propagate(advance: ArchivedAdmissionPolicyAdvance, index: number) {
    const vote = await measured(`target-remote-${index}`, () => exchangeAdmissionPolicyObservation(members[1],
      { request: createAdmissionPolicyHeadRequest(context, wallTime), advance }, new AbortController().signal)) as { head: unknown; observer: string };
    expect(vote.head).toEqual(advance.commitment.next);
    expect(vote.observer).toBe(members[1].publicKey);
    expect(source.observer.status().head).toEqual(target.observer.status().head);
    for (const role of [source, target]) expect(role.stores.filter(store => store.describe().sequence === index).length).toBeGreaterThanOrEqual(4);
  }
  for (let i = 1; i <= 64; i++) {
    wallTime = initialTime + i * 1000;
    const next = await signAdmissionPolicy({ version: 2, kind: 'admission-policy', ...fields(i), archivedKeys: entries.slice(0, i) }, authority, authorityKey.secretKey);
    const advance = await createAdmissionPolicyAdvance(previous, next, context, authorityKey, head);
    await measured(`source-local-${i}`, () => source.observer.advance(advance));
    await propagate(advance, i); advances.push(advance); previous = next; head = advance.commitment.next;
  }
  expect(pageRequests).toBe(0);
  const limits = policyObserverArchiveLimits(HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES, 3000);
  const pages = new Map<string, Uint8Array>();
  const reader = async (digest: string) => { const bytes = pages.get(digest); if (!bytes) throw new Error('Missing fixture page'); return bytes; };
  const resolved = await measured('resolve-v2-ancestry', () => resolveAdmissionPolicy({ context, genesis, advances, selectedHead: head, reader, limits }));
  const plan = await prepareAdmissionPolicyV3Successor({ previous: resolved, next: fields(65), reader, limits });
  expect(plan.pages).toHaveLength(2); expect(plan.body.archive.entryCount).toBe(65);
  for (const page of plan.pages) pages.set(page.digest, page.bytes);
  const policy = await signAdmissionPolicyV3(plan.body, authority, authorityKey.secretKey);
  const migrated = await createResolvedAdmissionPolicyAdvance({ previous: resolved, policy, key: authorityKey, reader, limits });
  wallTime = initialTime + 65000;
  await measured('source-local-65-v3', () => source.observer.advance(migrated.advance, plan.pages));
  await propagate(migrated.advance, 65); advances.push(migrated.advance);
  expect(pageRequests).toBeGreaterThanOrEqual(2);
  expect(target.observer.policy()).toEqual(policy);
  await measured('target-reopen', () => target.reopen());
  expect(target.observer.status().head).toEqual(migrated.advance.commitment.next);
  expect(target.observer.policy()).toEqual(policy);
  const payloadDirectory = join(target.options.directory, 'payloads');
  const blocks = () => readdirSync(payloadDirectory).filter(name => name.endsWith('.block'))
    .map(name => JSON.parse(readFileSync(join(payloadDirectory, name), 'utf8')) as HistoryCheckpointEnvelope).sort((a, b) => a.sequence - b.sequence);
  const persisted = () => createPolicyObserverPageReader({ source: blocks, historyContext: target.enrolled.context, key: target.options.encryptionKey,
    maxBlocks: HISTORY_RECOVERY_MAX_BLOCKS, maxBytes: HISTORY_RECOVERY_MAX_BYTES, timeoutMs: 3000 });
  const restored = await measured('resolve-persisted-original-ancestry', () => resolveAdmissionPolicy({ context, genesis, advances,
    selectedHead: target.observer.status().head, reader: persisted(), limits }));
  expect(inspectResolvedAdmissionPolicy(restored).currentKeys).toEqual([entries[65]]);
  const offsets: number[] = [];
  await visitResolvedAdmissionPolicyArchive({ policy: restored, reader: persisted(), limits, visit: (entry, offset) => { expect(entry).toEqual(entries[offset]); offsets.push(offset); } });
  expect(offsets.sort((a, b) => a - b)).toEqual(Array.from({ length: 65 }, (_, i) => i));
  for (let i = 0; i <= 65; i++) expect(await lookupResolvedAdmissionPolicyKey({ policy: restored,
    issuerKey: admissionKeyFingerprint(entries[i].profile.issuerPublicKey), reader: persisted(), limits })).toEqual({ entry: entries[i], archived: i < 65 });
  const usage = { source: source.observer.status(), target: target.observer.status() };
  target.observer.close();
  const migrationBlock = blocks().find(block => block.sequence === 65)!;
  const plaintext = openHistoryCheckpoint(migrationBlock, target.enrolled.context, target.options.encryptionKey);
  try { expect(JSON.parse(Buffer.from(plaintext).toString()).archiveAppend).toHaveLength(2); } finally { plaintext.fill(0); }
  const file = join(payloadDirectory, `${historyCheckpointEnvelopeId(migrationBlock).slice(7)}.block`), bytes = readFileSync(file);
  rmSync(file);
  await expect(target.reopen()).rejects.toThrow();
  writeFileSync(file, bytes);
  const corrupt = Buffer.from(bytes); corrupt[Math.floor(corrupt.length / 2)] ^= 1; writeFileSync(file, corrupt);
  await expect(target.reopen()).rejects.toThrow();
  console.info('observer-65-evidence', JSON.stringify({ started, ended: new Date().toISOString(), pageRequests,
    archive: policy.archive, usage, durations }));
  writeFileSync(diagnosticPath, JSON.stringify({ started, ended: new Date().toISOString(), pageRequests, archive: policy.archive, usage, durations, handlerFailures, pageExchanges }));
}, 180000);
