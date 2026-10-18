import { createAdmissionPolicyTransfer, createArchivedAdmissionPolicyTransfer, assembleAdmissionPolicyTransfer, assembleArchivedAdmissionPolicyTransfer, createAdmissionPolicyChunkRequest } from '@resonance/core/admission-policy-transfer';
import { createAdmissionPolicyTransferResponder } from '../admission-policy-transfer.js';
import { collectAdmissionPolicyObservation } from '../admission-policy-observation.js';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyKey } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance, createAdmissionPolicyAdvanceCommitment } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadRequest, createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
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
import { createPolicyObserverPageReader, policyObserverArchiveLimits } from '../policy-observer-page-reader.js';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver, exchangeAdmissionPolicyObserverFrame, exchangeAdmissionPolicyObservation } from '../admission-policy-observation-transport.js';
import { downloadPolicyObserverArchivePage, createPolicyObserverRemoteOperation, POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES } from '../policy-observer-page-transfer.js';
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
  // Pin actual observer routes before any role is enrolled or transition signed.
  f.context = parseAdmissionPolicyObservers({...f.context,members:f.context.members.map(member=>({...member,endpoint:new URL('/policy-head',member.endpoint).href}))});
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
    get time() { return time; }, setTime(value: number) { time = value; }, get observer() { return observer; }, lose(value: boolean) { lose = value; }, online(value: number) { online = value; } };
}
it('commits v3 pages and policy together with four durable copies and reopens original provenance', async () => {
  const n = await fixture(); await n.observer.advance(n.v3.advance, n.plan.pages);
  expect(n.stores.filter(s => s.describe().sequence === 2).length).toBeGreaterThanOrEqual(4);
  const reopened = await n.reopen(); expect(reopened.policy()).toEqual(n.policy);
  expect(await reopened.originalGenesis()).toEqual(n.first);
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
  await selected.restored.ready(); expect(selected.restored.policy()).toEqual(n.policy);
  expect(await selected.restored.originalGenesis()).toEqual(n.first); selected.restored.close();
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

it('captures a page during its selected-root validation without a second lookup', async () => {
  const n = await fixture({maxArchiveBlocks:4}); await n.observer.advance(n.v3.advance,n.plan.pages);
  // One validation scan reads three checkpoints and captures the proven member.
  expect(Uint8Array.from(await n.observer.archivePage(n.plan.pages[0].digest))).toEqual(n.plan.pages[0].bytes);
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

async function remotePeer(n: Awaited<ReturnType<typeof fixture>>, settings: {maxRequests?:number;maxBytes?:number} = {}) {
  const signer = n.keys[1], localKey = randomBytes(32), ownerKey = Buffer.from(signer.publicKey).toString('base64url');
  const sourceMember = n.context.members.find(m=>m.publicKey===Buffer.from(n.owner.publicKey).toString('base64url'))!;
  const targetMember = n.context.members.find(m=>m.publicKey===ownerKey)!;
  const sourceExchange = createAdmissionPolicyObserverExchange(n.observer,n.context,()=>n.now+30001);
  const sourceListener = await listenAdmissionPolicyObserver(sourceExchange,{port:Number(new URL(sourceMember.endpoint).port)}); cleanup.push(sourceListener.close);
  const enrolled = await createPolicyObserverHistoryRoot({context:n.context,signingKey:signer,encryptionKey:localKey,policy:n.first,now:()=>n.now});
  const stores = enrolled.context.members.map((replica,i)=>openHistoryCheckpointStore({directory:join(n.directory,`target-replica-${i}`),context:enrolled.context,replica,
    localKey:randomBytes(32),rootId:historyCheckpointEnvelopeId(enrolled.root),generation:0,initialize:enrolled.root})); stores.forEach(s=>cleanup.push(s.close));
  const roles = stores.map((store,i)=>createHistoryCheckpointReplica({context:enrolled.context,store,signingKey:n.keys.find(k=>Buffer.from(k.publicKey).toString('base64url')===enrolled.context.members[i])!})); roles.forEach(r=>cleanup.push(r.close));
  let mode:'real'|'wrong-head'|'corrupt'|'missing'|'gate'='real', requests=0, delay:Promise<void>|undefined;
  let appendHook: (()=>void)|undefined, pageHook: (()=>void)|undefined;
  const transport:HistoryCheckpointTransport = async(member,frame,signal)=>{
    if(frame.request.action==='append' && frame.envelope?.sequence===2) appendHook?.();
    signal.throwIfAborted(); return roles[enrolled.context.members.indexOf(member.publicKey)].exchange(frame);
  };
  const options = {directory:join(n.directory,'target-owner'),encryptionKey:localKey,signingKey:signer,context:n.context,historyContext:enrolled.context,root:enrolled.root,
    members:n.members,transport,timeoutMs:2500,now:()=>n.time,
    remoteArchive:{...settings,exchange:async(member:typeof sourceMember,request:unknown,signal:AbortSignal)=>{
      requests++; if(delay) await delay;
      signal.throwIfAborted(); if(mode==='missing') throw new Error('source unavailable');
      const reply = await exchangeAdmissionPolicyObserverFrame(member,request,signal,POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES) as Record<string,unknown>;
      pageHook?.();
      if(mode==='wrong-head') return {...reply,head:n.context.genesis};
      if(mode==='corrupt') return {...reply,data:'AA'};
      return reply;
    }}};
  let target = await openProtectedPolicyObserver({...options,mode:'create-new'}); cleanup.push(()=>target.close()); await target.ready(); await target.advance(n.advance);
  const targetListener = await listenAdmissionPolicyObserver(createAdmissionPolicyObserverExchange(target,n.context,()=>n.now+30001),{port:Number(new URL(targetMember.endpoint).port)}); cleanup.push(targetListener.close);
  return {get target(){return target;},sourceMember,targetMember,sourceListener,targetListener,stores,
    requests:()=>requests,mode(value:typeof mode){mode=value;},gate(value?:Promise<void>){delay=value;},onAppend(value?:()=>void){appendHook=value;},onPage(value?:()=>void){pageHook=value;},
    async reopen(){await targetListener.close();target.close();target=await openProtectedPolicyObserver({...options,mode:'open-existing'});return target;},
    frame:()=>({request:createAdmissionPolicyHeadRequest(n.context,n.now+30001),advance:n.v3.advance})};
}
it('propagates a signed v3 advance between two pinned loopback observers and reopens the target',async()=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n);
  const vote=await exchangeAdmissionPolicyObservation(peer.targetMember,peer.frame(),new AbortController().signal) as {head:unknown};
  expect(vote.head).toEqual(n.v3.advance.commitment.next);expect(peer.target.status().pending).toBe(false);
  const requests=peer.requests();await peer.target.advanceRemote(n.v3.advance,{deadline:performance.now()+3000});expect(peer.requests()).toBe(requests);
  expect((await peer.reopen()).policy()).toEqual(n.policy);
});
it.each(['missing','wrong-head','corrupt'] as const)('refuses remote %s pages before publishing any target intent',async mode=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n);peer.mode(mode);
  await expect(peer.target.advanceRemote(n.v3.advance,{deadline:performance.now()+3000})).rejects.toThrow();
  expect(peer.target.status()).toMatchObject({pending:false,head:n.advance.commitment.next});
});
it('rejects invalid signatures and stale predecessors before network work, and unsupported remote implementations',async()=>{
  const n=await fixture();const peer=await remotePeer(n);const bad=structuredClone(n.v3.advance);bad.policy.signature='A'.repeat(86);
  await expect(peer.target.advanceRemote(bad,{deadline:performance.now()+3000})).rejects.toThrow();expect(peer.requests()).toBe(0);
  const stale={...n.v3.advance,commitment:createAdmissionPolicyAdvanceCommitment({...n.advance.commitment.next,transition:'b'.repeat(64)},n.v3.advance.commitment.next,n.context,n.authorityKey)};
  await expect(peer.target.advanceRemote(stale,{deadline:performance.now()+3000})).rejects.toThrow('exact committed predecessor');expect(peer.requests()).toBe(0);
  await expect(n.observer.advanceRemote(n.v3.advance,{deadline:performance.now()+3000})).rejects.toThrow('does not support');
  const unsupported=createAdmissionPolicyObserverExchange({advance:async()=>{},observe:()=>{}},n.context,()=>n.now+30001);
  await expect(unsupported(peer.frame())).rejects.toThrow('refuses remote v3');
});
it('cancels remote prefetch and excludes a simultaneous advancement without durable target changes',async()=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n);let release!:()=>void;
  peer.gate(new Promise(resolve=>{release=resolve;}));const controller=new AbortController();
  const pending=peer.target.advanceRemote(n.v3.advance,{deadline:performance.now()+3000,signal:controller.signal});
  await vi.waitFor(()=>expect(peer.requests()).toBeGreaterThan(0));
  await expect(peer.target.advance(n.v3.advance,n.plan.pages)).rejects.toThrow('already in progress');controller.abort();
  await expect(pending).rejects.toThrow(/cancelled|aborted/i);release();
  expect(peer.target.status()).toMatchObject({pending:false,head:n.advance.commitment.next});
});
it.each([{maxRequests:0},{maxBytes:0}])('charges cumulative remote fallback budgets %j',async limits=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n,limits);
  await expect(peer.target.advanceRemote(n.v3.advance,{deadline:performance.now()+3000})).rejects.toThrow('budget exhausted');
  expect(peer.target.status().pending).toBe(false);
});
it('cancellation during remote replication preserves exact pending state',async()=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n),controller=new AbortController();
  peer.onAppend(()=>controller.abort());
  await expect(peer.target.advanceRemote(n.v3.advance,{deadline:performance.now()+3000,signal:controller.signal})).rejects.toThrow(/cancelled|acknowledgements/i);
  expect(peer.target.status()).toMatchObject({pending:true,head:n.v3.advance.commitment.next});
  await expect(peer.target.observe(createAdmissionPolicyHeadRequest(n.context,n.now+30001))).rejects.toThrow('pending');
  peer.onAppend();await peer.target.advance(n.v3.advance);expect(peer.target.status().pending).toBe(false);
});

it('shares the absolute remote deadline with replication after page prefetch',async()=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n);
  const started=performance.now();let clock=started;
  const spy=vi.spyOn(performance,'now').mockImplementation(()=>clock);
  let fetched=false;peer.onPage(()=>{fetched=true;});peer.onAppend(()=>{clock=started+1001;});
  const expected=createPublicKey(n.entries[0].profile.issuerPublicKey).export({type:'spki',format:'der'}),original=crypto.subtle.importKey.bind(crypto.subtle);
  const keySpy=vi.spyOn(crypto.subtle,'importKey').mockImplementation(async(...args)=>{
    // Consume the remaining budget after page decoding, inside the second policy verification.
    if(fetched&&args[0]==='spki'&&Buffer.from(args[1] as ArrayBuffer).equals(expected))clock=started+995;
    return Reflect.apply(original,crypto.subtle,args);
  });
  try {
    await expect(peer.target.advanceRemote(n.v3.advance,{deadline:started+1000})).rejects.toThrow();
    expect(peer.target.status()).toMatchObject({pending:true,head:n.v3.advance.commitment.next});
  } finally {keySpy.mockRestore();spy.mockRestore();}
});
it('does not reset the request budget when falling back between pinned peers',async()=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n,{maxRequests:1});peer.mode('missing');
  await expect(peer.target.advanceRemote(n.v3.advance,{deadline:performance.now()+3000})).rejects.toThrow('budget exhausted');
  expect(peer.requests()).toBe(1);expect(peer.target.status().pending).toBe(false);
});

it('requires an already committed pinned source before remote ingestion can publish',async()=>{
  const n=await fixture(),peer=await remotePeer(n);
  await expect(peer.target.advanceRemote(n.v3.advance,{deadline:performance.now()+3000})).rejects.toThrow('No committed pinned observer');
  expect(peer.target.status()).toMatchObject({pending:false,head:n.advance.commitment.next});
});

it('times out a silent first pinned source fairly and obtains the page from a healthy second source',async()=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n);
  const ownKey=peer.targetMember.publicKey,silent=n.context.members.find(m=>m.publicKey!==ownKey&&m.publicKey!==peer.sourceMember.publicKey)!;
  const listener=await listenAdmissionPolicyObserver(async(_request,signal)=>new Promise((_,reject)=>{signal?.addEventListener('abort',()=>reject(new Error('silent source cancelled')),{once:true});}),
    {port:Number(new URL(silent.endpoint).port)});cleanup.push(listener.close);
  // Scheduling order changes; normalized independent pins/context ID remain identical.
  const context={...n.context,members:[silent,peer.sourceMember,...n.context.members.filter(m=>m.publicKey!==silent.publicKey&&m.publicKey!==peer.sourceMember.publicKey)]};
  const calls:string[]=[];const deadline=performance.now()+1200;
  const operation=createPolicyObserverRemoteOperation({deadline,archive:{exchange:(member,request,signal)=>{calls.push(member.publicKey);return exchangeAdmissionPolicyObserverFrame(member,request,signal,POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES);}}});
  try {
    expect(Uint8Array.from(await operation.page(context,n.v3.advance.commitment.next,n.plan.pages[0].digest,ownKey))).toEqual(n.plan.pages[0].bytes);
    expect(calls).toEqual([silent.publicKey,peer.sourceMember.publicKey]);expect(operation.deadline).toBe(deadline);
  } finally {operation.close();}
});
it('retains the full reply-capacity charge when a dispatched transport rejects',async()=>{
  const n=await fixture();let calls=0;
  const operation=createPolicyObserverRemoteOperation({deadline:performance.now()+1000,archive:{maxBytes:POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES,
    exchange:async()=>{calls++;throw new Error('reply lost after receiving bytes');}}});
  try {
    await expect(operation.page(n.context,n.v3.advance.commitment.next,n.plan.pages[0].digest,Buffer.from(n.owner.publicKey).toString('base64url'))).rejects.toThrow('budget exhausted');
    expect(calls).toBe(1);
  } finally {operation.close();}
});
it('cancels post-prefetch policy verification promptly and releases exclusivity without an intent',async()=>{
  const n=await fixture();await n.observer.advance(n.v3.advance,n.plan.pages);const peer=await remotePeer(n),controller=new AbortController();
  let fetched=false,entered!:()=>void,release!:()=>void;peer.onPage(()=>{fetched=true;});
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const expected=createPublicKey(n.entries[0].profile.issuerPublicKey).export({type:'spki',format:'der'}),original=crypto.subtle.importKey.bind(crypto.subtle);
  const spy=vi.spyOn(crypto.subtle,'importKey').mockImplementation(async(...args)=>{
    if(fetched&&args[0]==='spki'&&Buffer.from(args[1] as ArrayBuffer).equals(expected)){entered();await gate;}
    return Reflect.apply(original,crypto.subtle,args);
  });
  const pending=peer.target.advanceRemote(n.v3.advance,{deadline:performance.now()+3000,signal:controller.signal});
  try {
    await started;controller.abort();
    await expect(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('post-prefetch verification ignored cancellation')),150))])).rejects.toThrow(/cancelled|aborted/i);
    expect(peer.target.status()).toMatchObject({pending:false,head:n.advance.commitment.next});
    await peer.target.ready(); // Must finish while the cancelled read-only verifier remains gated.
  } finally {release();await pending.catch(()=>{});spy.mockRestore();}
});

it('serves an exact historical v3 root after a later v3 rotation and catches up a lagging observer', async () => {
  const n = await fixture(); await n.observer.advance(n.v3.advance, n.plan.pages);
  const plan = await prepareAdmissionPolicyV3Successor({ previous: n.v3.resolved, next: { revision: 4, issuedAt: n.now+31001, expiresAt: n.now+60000,
    activeKey: admissionKeyFingerprint(n.entries[1].profile.issuerPublicKey), keys: [n.entries[1]] }, reader: n.reader, limits: n.limits });
  const policy = await signAdmissionPolicyV3(plan.body, n.authority, n.authorityKey.secretKey);
  const reader = async (digest: string) => plan.pages.find(p => p.digest === digest)?.bytes ?? n.reader(digest);
  const next = await createResolvedAdmissionPolicyAdvance({ previous: n.v3.resolved, policy, key: n.authorityKey, reader, limits: n.limits });
  n.setTime(n.now+31001); await n.observer.advance(next.advance, plan.pages);
  const peer = await remotePeer(n);
  await peer.target.advanceRemote(n.v3.advance, { deadline: performance.now()+3000 });
  expect(peer.target.status().head).toEqual(n.v3.advance.commitment.next);
  await peer.target.advanceRemote(next.advance, { deadline: performance.now()+3000 });
  expect(peer.target.status().head).toEqual(next.advance.commitment.next);
  const selected = n.v3.advance.commitment.next, digest = n.plan.pages[0].digest;
  await expect(n.observer.archivePageAtHead({...selected, transition:'a'.repeat(64)}, digest)).rejects.toThrow('absent');
  await expect(n.observer.archivePageAtHead({...selected, digest:'b'.repeat(64)}, digest)).rejects.toThrow('absent');
  await expect(n.observer.archivePageAtHead(selected, plan.pages[0].digest)).rejects.toThrow('not reachable');
  const cancelled = new AbortController(); cancelled.abort();
  await expect(n.observer.archivePageAtHead(selected, digest, cancelled.signal)).rejects.toThrow();
  const restored = await n.recover(); await restored.restored.ready();
  const mutableHead = structuredClone(selected);
  const replaying = replayPolicyObserverHistory({...restored.replay,blocks:restored.archive.blocks(),selectedPolicyHead:mutableHead});
  mutableHead.digest='b'.repeat(64);
  expect((await replaying).selectedResolved).toBeDefined();
  expect(Uint8Array.from(await restored.restored.archivePageAtHead(selected,digest))).toEqual(n.plan.pages[0].bytes);
  const file = join(restored.config.archiveDirectory!,readdirSync(restored.config.archiveDirectory!).find(name=>name.endsWith('.block'))!);
  const original = readFileSync(file); rmSync(file);
  try { await expect(restored.restored.archivePageAtHead(selected,digest)).rejects.toThrow(); }
  finally { writeFileSync(file,original); }
},30000);

it('authenticates v3 signed artifacts and collects v3 heads while legacy assembly refuses v3', async () => {
  const n = await fixture(); await n.observer.advance(n.v3.advance, n.plan.pages);
  const responder = createAdmissionPolicyTransferResponder({context:n.context, successor:(previous,signal)=>n.observer.successor(previous,signal)}); cleanup.push(responder.close);
  const request = createAdmissionPolicyChunkRequest(n.context,n.advance.commitment.next);
  const first = await responder.exchange(request), chunks = [first];
  for (let index=1; index<first.count; index++) chunks.push(await responder.exchange({...request,artifact:first.artifact,index}));
  expect(await assembleArchivedAdmissionPolicyTransfer(chunks,n.context,request.previous)).toEqual(n.v3.advance);
  await expect(createAdmissionPolicyTransfer(n.v3.advance,n.context)).rejects.toThrow();
  await expect(assembleAdmissionPolicyTransfer(chunks,n.context,request.previous)).rejects.toThrow();
  const forged = structuredClone(n.v3.advance); forged.policy.signature='A'.repeat(86);
  await expect(createArchivedAdmissionPolicyTransfer(forged,n.context)).rejects.toThrow();
  const certificate = await collectAdmissionPolicyObservation({context:n.context,policy:n.policy,advance:n.v3.advance,now:()=>n.time,
    transport:async(member,frame)=>{
      expect(frame.advance).toEqual(n.v3.advance);
      return createAdmissionPolicyHeadVote(frame.request,n.v3.advance.commitment.next,n.context,n.keys.find(k=>Buffer.from(k.publicKey).toString('base64url')===member.publicKey)!,n.time);
    }});
  expect(certificate.votes).toHaveLength(4);
});

it.each(['cancel','close'] as const)('releases historical read occupancy promptly on %s during validation', async mode => {
  const n = await fixture(); await n.observer.advance(n.v3.advance,n.plan.pages);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const original=crypto.subtle.importKey.bind(crypto.subtle),controller=new AbortController();
  const spy=vi.spyOn(crypto.subtle,'importKey').mockImplementationOnce(async(...args)=>{entered();await gate;return Reflect.apply(original,crypto.subtle,args);});
  const pending=n.observer.archivePageAtHead(n.v3.advance.commitment.next,n.plan.pages[0].digest,controller.signal);
  try {
    await started; if(mode==='cancel') controller.abort(); else n.observer.close();
    await expect(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('archive read ignored cancellation')),150))])).rejects.toThrow(/cancelled|aborted|closed/i);
    if(mode==='cancel') await n.observer.ready();
  } finally {release();await pending.catch(()=>{});spy.mockRestore();}
});

it.each([{stage:'policy',gateAt:1,mode:'cancel'},{stage:'policy',gateAt:1,mode:'deadline'},
  {stage:'advance',gateAt:2,mode:'cancel'},{stage:'advance',gateAt:2,mode:'deadline'}])('bounds collector $stage verification on $mode before observer fan-out', async ({gateAt,mode}) => {
  const n=await fixture(); let entered!:()=>void,release!:()=>void,imports=0,fanout=0;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),controller=new AbortController();
  const original=crypto.subtle.importKey.bind(crypto.subtle);
  const spy=vi.spyOn(crypto.subtle,'importKey').mockImplementation(async(...args)=>{if(++imports===gateAt){entered();await gate;}return Reflect.apply(original,crypto.subtle,args);});
  const pending=collectAdmissionPolicyObservation({context:n.context,policy:n.policy,advance:n.v3.advance,now:()=>n.time,signal:controller.signal,timeoutMs:mode==='deadline'?100:3000,
    transport:async()=>{fanout++;throw new Error('must not fan out');}});
  try {
    await started; if(mode==='cancel') controller.abort();
    await expect(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('collector ignored verification cancellation/deadline')),250))])).rejects.toThrow(/cancelled|aborted|timed out/i);
    expect(fanout).toBe(0);
  } finally {release();await pending.catch(()=>{});spy.mockRestore();}
});
it('delivers cancellation during retained page rescans before exhausting the funded scan', async () => {
  const n=await fixture(),controller=new AbortController(); let scanned=0;
  const reader=createPolicyObserverPageReader({source:function*(){for(let i=0;i<64;i++)yield n.enrolled.root;},historyContext:n.enrolled.context,key:n.key,
    maxBlocks:64,maxBytes:256*1024*1024,timeoutMs:3000,signal:controller.signal,account:()=>{scanned++;}});
  queueMicrotask(()=>controller.abort());
  await expect(reader(n.plan.pages[0].digest,controller.signal)).rejects.toThrow('cancelled');
  expect(scanned).toBe(16);
});
