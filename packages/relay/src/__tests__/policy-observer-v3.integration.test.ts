import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadRequest } from '@resonance/core/admission-policy-freshness';
import { parseAdmissionWitnessSet } from '@resonance/core/admission-witness';
import { createResolvedAdmissionPolicyAdvance, prepareAdmissionPolicyV3Successor, resolveAdmissionPolicy, signAdmissionPolicyV3 } from '@resonance/core/admission-policy-archive';
import { historyCheckpointEnvelopeId, historyCheckpointEnvelopeByteLength, historyCheckpointReserveBucket, openHistoryCheckpoint, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointRecovery } from '../history-checkpoint-recovery.js';
import { createHistoryAgreementReplica } from '../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { preparePolicyObserverRestore } from '../policy-observer-history-restore.js';
import { replayPolicyObserverHistory } from '../policy-observer-history-replay.js';
import { parsePolicyObserverSnapshot, parseAdmissionPolicyObserverState } from '../admission-policy-observer-state.js';
import { policyObserverArchiveLimits } from '../policy-observer-page-reader.js';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver, exchangeAdmissionPolicyObserverFrame } from '../admission-policy-observation-transport.js';
import { downloadPolicyObserverArchivePage, POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES } from '../policy-observer-page-transfer.js';
import { createHistoryAncestryDownload } from '../history-ancestry-download.js';
import { openRetainedPolicyObserverArchive } from '../policy-observer-archive.js';
import { openConfiguredPolicyObserver, parsePolicyObserverConfiguration } from '../policy-observer-config.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let rsa: string[];
beforeAll(() => { rsa = Array.from({ length: 2 }, () => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()); });
async function fixture(bounds: { maxArchiveBlocks?: number; maxArchiveBytes?: number } = {}) {
  const f = await policyObserverFixture(); cleanup.push(f.close);
  const owner = f.keys[0], key = f.options.encryptionKey;
  const enrolled = await createPolicyObserverHistoryRoot({ context: f.context, signingKey: owner, encryptionKey: key, policy: f.first, now: () => f.now });
  const rootId = historyCheckpointEnvelopeId(enrolled.root), signingKeys = enrolled.context.members.map(p => f.keys.find(k => Buffer.from(k.publicKey).toString('base64url') === p)!);
  const localKeys = signingKeys.map(() => randomBytes(32));
  const stores = enrolled.context.members.map((replica, i) => openHistoryCheckpointStore({ directory: join(f.directory, `replica-${i}`), context: enrolled.context,
    replica, localKey: localKeys[i], rootId, generation: 0, initialize: enrolled.root })); stores.forEach(s => cleanup.push(s.close));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: enrolled.context, store, signingKey: signingKeys[i] })); roles.forEach(r => cleanup.push(r.close));
  let lose = false, online = 5, time = f.now;
  const members = enrolled.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${42000+i}/history-checkpoint` }));
  const transport: HistoryCheckpointTransport = async (member, frame) => {
    const i = enrolled.context.members.indexOf(member.publicKey); if (i >= online) throw new Error('offline');
    const reply = roles[i].exchange(frame); if (lose && frame.request.action === 'append') throw new Error('reply lost'); return reply;
  };
  const options = { directory: join(f.directory, 'owner'), encryptionKey: key, signingKey: owner, context: f.context, historyContext: enrolled.context,
    root: enrolled.root, members, transport, timeoutMs: 2500, now: () => time, ...bounds };
  let observer = await openProtectedPolicyObserver({ ...options, mode: 'create-new' }); cleanup.push(() => observer.close()); await observer.ready();
  const { authority: _, signature: __, ...body } = f.first;
  const v2 = await signAdmissionPolicy({ ...body, version: 2, archivedKeys: [], revision: 2 }, f.authority, f.key.secretKey);
  const advance = await createAdmissionPolicyAdvance(f.first, v2, f.context, f.key); await observer.advance(advance);
  const limits = policyObserverArchiveLimits(10001, 256*1024*1024, 30000);
  const emptyReader = async () => { throw new Error('missing'); };
  const previous = await resolveAdmissionPolicy({ context: f.context, genesis: f.first, advances: [advance], selectedHead: advance.commitment.next, reader: emptyReader, limits });
  const witnesses = parseAdmissionWitnessSet({ version: 1, quorum: 4, members: f.context.members, coordinators: [f.authority] });
  const entries: AdmissionPolicyKey[] = rsa.map((issuerPublicKey, i) => ({ profile: { version: 1, scope: { issuer: 'observer-fixture', community: 'public', epoch: `new-${i}` }, issuerPublicKey,
    relayUrls: ['ws://127.0.0.1:33000/'] }, notBefore: f.now + 30000 + i*1000, issueUntil: f.now+30300+i*1000, spendUntil: f.now+30600+i*1000, retryUntil: f.now+31000+i*1000, witnesses }));
  const plan = await prepareAdmissionPolicyV3Successor({ previous, next: { revision: 3, issuedAt: f.now+30001, expiresAt: f.now+60000,
    activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), keys: [entries[0]] }, reader: emptyReader, limits });
  const pageMap = new Map(plan.pages.map(p => [p.digest, p.bytes]));
  const reader = async (digest: string) => { const bytes = pageMap.get(digest); if (!bytes) throw new Error('missing'); return bytes; };
  const policy = await signAdmissionPolicyV3(plan.body, f.authority, f.key.secretKey);
  const v3 = await createResolvedAdmissionPolicyAdvance({ previous, policy, key: f.key, reader, limits });
  time = f.now+30001;
  async function reopen(overrides: Partial<typeof options> = {}) { observer.close(); observer = await openProtectedPolicyObserver({ ...options, ...overrides, mode: 'open-existing' }); return observer; }
  async function recover() {
    observer.close();
    const recovery = createHistoryCheckpointRecovery({ directory: join(f.directory, 'freeze'), context: enrolled.context, localKey: key, signingKey: owner,
      rootId, generation: 0, nextGeneration: 1, members, transport, initialize: true, timeoutMs: 2500 }); cleanup.push(recovery.close);
    const preparation = await recovery.prepare(), proposal = createHistorySuccessorProposal(preparation, enrolled.context, owner);
    const archiveDirectory = join(f.directory, 'download');
    const download = createHistoryAncestryDownload({ directory: archiveDirectory, localKey:key, context:enrolled.context, signingKey:owner, proposal, members, transport, initialize:true });
    try { while (!download.read().complete) await download.run(); } finally { download.close(); }
    const agreements = stores.map((store,i) => createHistoryAgreementReplica({ context: enrolled.context, store, signingKey: signingKeys[i] })); agreements.forEach(r => cleanup.push(r.close));
    const coordinator = createHistoryAgreementCoordinator({ directory: join(f.directory, 'agreement'), context: enrolled.context, localKey: key, signingKey: owner,
      rootId, generation: 0, nextGeneration: 1, members, initialize: { proposal }, timeoutMs: 2500, historyTransfer: { retained: () => preparation.envelopes, transport: async (member, frame) => agreements[enrolled.context.members.indexOf(member.publicKey)].transfer(frame) },
      transport: async (member, frame) => agreements[enrolled.context.members.indexOf(member.publicKey)].exchange(frame) }); cleanup.push(coordinator.close);
    const certificate = await coordinator.run(), continuation = createHistoryContinuationRoot(coordinator.read().selected!, certificate, enrolled.context);
    const childStores = stores.map((parent,i) => {
      parent.activateContinuation(continuation);
      const store = openHistoryCheckpointStore({ directory: join(f.directory, `child-${i}`), context: enrolled.context, replica: enrolled.context.members[i], localKey: localKeys[i],
        rootId: historyCheckpointEnvelopeId(continuation), generation: 1, initialize: continuation, parent }); cleanup.push(store.close); return store;
    });
    const children = childStores.map((store,i) => createHistoryCheckpointReplica({ context: enrolled.context, store, signingKey: signingKeys[i] })); children.forEach(r => cleanup.push(r.close));
    const childTransport: HistoryCheckpointTransport = async (member, frame) => children[enrolled.context.members.indexOf(member.publicKey)].exchange(frame);
    const blocks = preparation.envelopes;
    const storageKeyFile = join(f.directory,'storage.key'), signingKeyFile = join(f.directory,'owner.key');
    writeFileSync(storageKeyFile,key.toString('hex'),{mode:0o600});
    writeFileSync(signingKeyFile,JSON.stringify({publicKey:Buffer.from(owner.publicKey).toString('base64url'),secretKey:Buffer.from(owner.secretKey).toString('base64url')}),{mode:0o600});
    const config = parsePolicyObserverConfiguration({version:1,kind:'policy-observer-configuration',context:f.context,historyContext:enrolled.context,genesis:enrolled.root,root:continuation,members,
      directory:join(f.directory,'restored'),signingKeyFile,storageKeyFile,limits:{archiveBlocks:10001,archiveBytes:64*1024*1024},listen:{port:0,maxConnections:8,connectionTimeoutMs:10000},archiveDirectory},'/');
    const archive = openRetainedPolicyObserverArchive(config); cleanup.push(archive.close);
    const replay = { context: f.context, historyContext: enrolled.context, genesisId: rootId, proposal: continuation.proposal, encryptionKey: key, blocks:archive.blocks(), blockSource:archive.blocks };
    const destination = join(f.directory, 'restored'), reviewed = await preparePolicyObserverRestore({ ...replay, directory: destination, continuation });
    const restoredOptions = { ...options, directory: destination, root: continuation, genesis: enrolled.root, transport: childTransport, ancestrySource: archive.blocks };
    const restored = await openProtectedPolicyObserver({ ...restoredOptions, mode: 'create-new', restore: { preparation: reviewed, approvedDigest: reviewed.review.approvalDigest } }); cleanup.push(restored.close);
    return { restored, restoredOptions, replay, blocks,config,archive,childTransport };
  }
  return { ...f, authorityKey: f.key, options, enrolled, key, owner, stores, roles, members, v2, advance, plan, v3, policy, limits, entries, reader, recover, reopen,
    get observer() { return observer; }, lose(value: boolean) { lose = value; }, online(value: number) { online = value; } };
}
it('commits v3 pages and policy together with four durable copies and reopens original provenance', async () => {
  const n = await fixture(); await n.observer.advance(n.v3.advance, n.plan.pages);
  expect(n.stores.filter(s => s.describe().sequence === 2).length).toBeGreaterThanOrEqual(4);
  const reopened = await n.reopen(); expect(reopened.policy()).toEqual(n.policy);
  const request = createAdmissionPolicyHeadRequest(n.context, n.now+30001);
  expect((await reopened.observe(request)).head).toEqual(n.v3.advance.commitment.next);
  expect(Uint8Array.from(await reopened.archivePage(n.plan.pages[0].digest))).toEqual(n.plan.pages[0].bytes);
  await expect(parseAdmissionPolicyObserverState(reopened.recoveryState(), n.context)).rejects.toThrow('resolved original ancestry');
});
it('refuses missing/corrupt append payloads before any pending acceptance and serializes competing advances', async () => {
  const n = await fixture();
  await expect(n.observer.advance(n.v3.advance)).rejects.toThrow('omitted');
  await expect(n.observer.advance(n.v3.advance, [{ ...n.plan.pages[0], bytes: new Uint8Array([1]) }])).rejects.toThrow();
  expect(n.observer.status().pending).toBe(false); expect(n.observer.status().head).toEqual(n.advance.commitment.next);
  const first = n.observer.advance(n.v3.advance, n.plan.pages);
  await expect(n.observer.advance(n.v3.advance, n.plan.pages)).rejects.toThrow('already in progress'); await first;
});
it('retains exact pending pages through replication interruption and refuses observations until four acknowledgements', async () => {
  const n = await fixture(); n.lose(true);
  await expect(n.observer.advance(n.v3.advance, n.plan.pages)).rejects.toThrow('Four');
  expect(n.observer.status().pending).toBe(true);
  const reopened = await n.reopen();
  await expect(reopened.observe(createAdmissionPolicyHeadRequest(n.context,n.now+30001))).rejects.toThrow('pending');
  n.lose(false); await reopened.advance(n.v3.advance);
  expect(reopened.status().pending).toBe(false); expect(Uint8Array.from(await reopened.archivePage(n.plan.pages[0].digest))).toEqual(n.plan.pages[0].bytes);
});
it('reconstructs v3 from original ancestry after owner loss and requires retained pages on every restored reopening', async () => {
  const n = await fixture(); await n.observer.advance(n.v3.advance,n.plan.pages); const selected = await n.recover();
  await selected.restored.ready(); expect(selected.restored.policy()).toEqual(n.policy); selected.restored.close();
  selected.archive.close(); rmSync(n.options.directory,{recursive:true});
  const reopened = await openConfiguredPolicyObserver(selected.config,{transport:selected.childTransport,now:()=>n.now+30001}); cleanup.push(reopened.close);
  expect((await reopened.observe(createAdmissionPolicyHeadRequest(n.context,n.now+30001))).head).toEqual(n.v3.advance.commitment.next); reopened.close();
  await expect(openProtectedPolicyObserver({ ...selected.restoredOptions, ancestrySource: undefined, mode: 'open-existing' })).rejects.toThrow('original ancestry');
  const file = join(selected.config.archiveDirectory!,readdirSync(selected.config.archiveDirectory!).find(name=>name.endsWith('.block'))!);
  const bytes = readFileSync(file); rmSync(file);
  await expect(openConfiguredPolicyObserver(selected.config,{transport:selected.childTransport,now:()=>n.now+30001})).rejects.toThrow(); writeFileSync(file,bytes);
  const damaged = structuredClone(selected.blocks); damaged.splice(1,1);
  await expect(replayPolicyObserverHistory({ ...selected.replay, blocks: damaged, blockSource: () => damaged })).rejects.toThrow();
},30000);
it('keeps v3 conflict evidence at the reserved final record and refuses one-record exhaustion before migration', async () => {
  const n = await fixture({ maxArchiveBlocks: 4 }); await n.observer.advance(n.v3.advance,n.plan.pages);
  const body = structuredClone(n.plan.body); body.expiresAt--;
  const fork = await signAdmissionPolicyV3(body,n.authority,n.authorityKey.secretKey);
  const other = await createResolvedAdmissionPolicyAdvance({ previous: await resolveAdmissionPolicy({ context:n.context,genesis:n.first,advances:[n.advance],selectedHead:n.advance.commitment.next,reader:n.reader,limits:n.limits }),
    policy:fork,key:n.authorityKey,reader:n.reader,limits:n.limits });
  await expect(n.observer.advance(other.advance,n.plan.pages)).rejects.toThrow('equivocated');
  expect(n.observer.status()).toMatchObject({ blocked:true,pending:false,retainedBlocks:4 });
  const reopened = await n.reopen(); expect(reopened.status().evidence).toHaveLength(2);
});
it('transfers canonical pages in bounded chunks through the existing observer channel and rejects changed heads/data/deadlines', async () => {
  const n = await fixture(); await n.observer.advance(n.v3.advance,n.plan.pages);
  const exchange = createAdmissionPolicyObserverExchange(n.observer,n.context,()=>n.now+30001);
  const listener = await listenAdmissionPolicyObserver(exchange,{port:0}); cleanup.push(listener.close);
  const member = { ...n.context.members[0], endpoint:listener.endpoint };
  const download = { context:n.context,head:n.v3.advance.commitment.next,digest:n.plan.pages[0].digest,timeoutMs:2500,
    exchange:(request:unknown,signal:AbortSignal)=>exchangeAdmissionPolicyObserverFrame(member,request,signal,POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES) };
  expect(Uint8Array.from(await downloadPolicyObserverArchivePage(download))).toEqual(n.plan.pages[0].bytes);
  await expect(downloadPolicyObserverArchivePage({ ...download,head:n.context.genesis })).rejects.toThrow();
  await expect(downloadPolicyObserverArchivePage({ ...download,exchange:async request=>({ ...(await exchange(request) as object),data:'AA' }) })).rejects.toThrow();
  await expect(downloadPolicyObserverArchivePage({ ...download,timeoutMs:10,exchange:async()=>new Promise(()=>{}) })).rejects.toThrow('timed out');
});

it('refuses one byte/one record below migration plus conflict headroom and accepts the exact byte reservation', async () => {
  const n = await fixture();
  const state = { version:2, contextId:n.plan.body.archive.contextId, policy:n.policy, previous:n.v2, advance:n.v3.advance.commitment, conflict:null,
    archiveAppend:n.plan.pages.map(p=>({digest:p.digest,data:Buffer.from(p.bytes).toString('base64url')})) };
  const plaintextBytes = Buffer.byteLength(JSON.stringify(state));
  const header = { kind:'checkpoint' as const,generation:0,sequence:2,previous:n.stores[0].describe().envelopeId };
  const conflict = historyCheckpointEnvelopeByteLength({context:n.enrolled.context,header:{...header,sequence:3},plaintextBytes:plaintextBytes+4096});
  const normal = historyCheckpointEnvelopeByteLength({context:n.enrolled.context,header:{...header,checkpointReserveBytes:historyCheckpointReserveBucket(conflict)},plaintextBytes});
  const required = n.observer.status().retainedCiphertextBytes + normal + conflict;
  const oneByteShort = await n.reopen({maxArchiveBytes:required-1});
  await expect(oneByteShort.advance(n.v3.advance,n.plan.pages)).rejects.toThrow('conflict headroom'); expect(oneByteShort.status().pending).toBe(false);
  const oneRecordShort = await n.reopen({maxArchiveBytes:required,maxArchiveBlocks:3});
  await expect(oneRecordShort.advance(n.v3.advance,n.plan.pages)).rejects.toThrow('conflict headroom'); expect(oneRecordShort.status().pending).toBe(false);
  const exact = await n.reopen({maxArchiveBytes:required,maxArchiveBlocks:4});
  await exact.advance(n.v3.advance,n.plan.pages); expect(exact.status()).toMatchObject({pending:false,retainedBlocks:3});
});

it('shares validation and retrieval scan budgets for one archive-page operation', async () => {
  const n = await fixture({maxArchiveBlocks:4}); await n.observer.advance(n.v3.advance,n.plan.pages);
  // One page lives in the third checkpoint: two scans need six reads, beyond four.
  await expect(n.observer.archivePage(n.plan.pages[0].digest)).rejects.toThrow('cumulative history budget');
  expect(n.observer.status()).toMatchObject({pending:false,retainedBlocks:3});
});
it('cancels archive-page retrieval during its initial validation without waiting for crypto', async () => {
  const n = await fixture(); await n.observer.advance(n.v3.advance,n.plan.pages);
  const controller = new AbortController(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => {entered=resolve;}), gate = new Promise<void>(resolve => {release=resolve;});
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle,'importKey').mockImplementationOnce(async (...args) => {entered(); await gate; return Reflect.apply(importKey,crypto.subtle,args);});
  const pending = n.observer.archivePage(n.plan.pages[0].digest,controller.signal);
  try {
    await started; controller.abort();
    await expect(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('validation ignored cancellation')),100))])).rejects.toThrow(/cancelled|aborted/i);
  } finally {release(); await pending.catch(()=>{}); spy.mockRestore();}
});
it.each(['cancellation','deadline'] as const)('refuses %s during the final asynchronous page decode', async mode => {
  const n = await fixture(), page = n.plan.pages[0], controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve=>{entered=resolve;}), gate = new Promise<void>(resolve=>{release=resolve;});
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle,'importKey').mockImplementationOnce(async (...args)=>{entered(); await gate; return Reflect.apply(importKey,crypto.subtle,args);});
  const pending = downloadPolicyObserverArchivePage({context:n.context,head:n.v3.advance.commitment.next,digest:page.digest,timeoutMs:mode==='deadline'?20:2500,signal:controller.signal,
    exchange:async request=>({...request as object,type:'admission_policy_archive_page_reply',bytes:page.bytes.length,count:1,data:Buffer.from(page.bytes).toString('base64url')})});
  try {
    await started; if(mode==='cancellation') controller.abort();
    await expect(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('decode ignored cancellation')),150))])).rejects.toThrow(/cancelled|timed out/i);
  } finally {release(); await pending.catch(()=>{}); spy.mockRestore();}
});
