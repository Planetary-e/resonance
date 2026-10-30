import { createHistoryGenerationReplica } from '../../../relay/src/history-generation-provisioner.js';
import { listenHistoryAgreementReplica } from '../../../relay/src/history-agreement-exchange.js';
import { captureHistoryAncestrySource } from '../../../relay/src/history-ancestry-source.js';
import type { WitnessTerminalPins, WitnessTerminalEvidence } from '../../../relay/src/protected-witness-handoff.js';
import { openProtectedAdmissionIssuerLedger } from '../protected-admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { createAdmissionPolicyQueryResponder } from '../../../relay/src/admission-policy-query.js';
import { parseProtectedWitnessHandoffState } from '../../../relay/src/witness-handoff-state.js';
import { prepareAdmissionPolicyV3Successor, signAdmissionPolicyV3, createResolvedAdmissionPolicyAdvance, type ArchivedAdmissionPolicy, type ArchivedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
import { runAdmissionHistoryCommand } from '../../../relay/src/admission-history-command.js';
import { writeOperatorJsonNew, writeOperatorTextAtomic } from '../../../relay/src/admission-operator-files.js';
import { runWitnessHandoffCommand } from '../../../relay/src/witness-handoff-command.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { afterEach, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, verifyBlindAdmissionTokenV2, createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, type SigningKeyPair } from '@resonance/core';
import { signAdmissionPolicy, admissionPolicyDigest, openAdmissionPolicyStore, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionWitnessSetId, createAdmissionWitnessVote, createAdmissionWitnessRequest, type AdmissionSpendClaim, type AdmissionWitnessSet } from '@resonance/core/admission-witness';
import { witnessHandoffObserverPins, witnessHandoffDigest, createWitnessFreezeReport, createWitnessHandoffActivation, createWitnessHandoffProposal } from '@resonance/core/admission-witness-handoff';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { openHistoryCheckpointStore } from '../../../relay/src/history-checkpoint-store.js';
import { exchangeHistoryCheckpoint, createHistoryCheckpointReplica, listenHistoryCheckpointReplica } from '../../../relay/src/history-checkpoint-exchange.js';
import { openProtectedAdmissionSpendHistory } from '../../../relay/src/protected-admission-history.js';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../../../relay/src/protected-policy-observer.js';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver } from '../../../relay/src/admission-policy-observation-transport.js';
import { createConfiguredAdmissionVerifier } from '../../../relay/src/configured-admission-verifier.js';
import { createRelayServer } from '../../../relay/src/server.js';
import { witnessFixture } from '../../../relay/src/__tests__/fixtures/admission-witness-fixture.js';
import { enrollProtectedWitnessEpoch, proposeProtectedWitnessHandoff, freezeProtectedWitness, prepareProtectedWitnessTransfer, installProtectedWitnessTransfer,
  activateProtectedWitnessTransfer, installProtectedCoordinatorTransfer, retainOriginalWitnessCertificate } from '../../../relay/src/protected-witness-handoff.js';

const qualification100=process.env.RESONANCE_HANDOFF_QUALIFY_100==='1';
const campaignLog='/tmp/resonance-shared-decode-2026-10-22/qualification100/campaign.jsonl';
const campaignRecord=(value:unknown)=>appendFileSync(campaignLog,JSON.stringify(value)+'\n',{mode:0o600});
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixtureJson=(path:string,value:unknown)=>{writeOperatorJsonNew(path,value,Buffer.byteLength(JSON.stringify(value)+'\n'));return path;};
const pub = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
async function fixture(funding:ReturnType<typeof openStorageReservationAuthority>, fundingDirectory?:string) {
  const base = await witnessFixture(), directory = mkdtempSync(join(tmpdir(), 'same-rsa-handoff-'));
  if(qualification100)campaignRecord({kind:'retained-owner-directory',directory});
  cleanup.push(() => {if(!qualification100)rmSync(directory, { recursive: true, force: true });});
  // Five physical volunteers host all role histories; independent old/new witness signing keys.
  const volunteers = Array.from({ length: 5 }, generateSigningKeyPair), old = base.witnesses, next = Array.from({ length: 5 }, generateSigningKeyPair);
  let now = base.time;
  const observers: Awaited<ReturnType<typeof openProtectedPolicyObserver>>[] = [];
  const reopenObservers: Array<() => Promise<void>> = [];
  const exchanges: ReturnType<typeof createAdmissionPolicyObserverExchange>[] = [];
  const observationListeners: Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>[] = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenAdmissionPolicyObserver((frame, signal) => exchanges[i](frame, signal), { port: 0 });
    cleanup.push(listener.close); observationListeners.push(listener);
  }
  const actors: Awaited<ReturnType<typeof actor>>[] = [];
  const witnessServers: ReturnType<typeof createRelayServer>[] = [];
  for (let i = 0; i < 10; i++) {
    const server = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, `server-${i}`), maxJournalStorageBytes: 0, admissionWitness: {
      vote(value, accept) { const verifier = actors[i]?.verifier; if (!verifier?.witness) throw new Error('Witness not ready'); return verifier.witness.vote(value, accept); }, close() {},
    } });
    await server.start(); cleanup.push(() => server.stop()); witnessServers.push(server);
  }
  const observerMembers = volunteers.map((k,i) => ({ publicKey: pub(k), endpoint: observationListeners[i].endpoint }));
  const placeholder = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: base.authority,
    genesis: { revision: 1, digest: '0'.repeat(64), transition: '0'.repeat(64) }, quorum: 4, members: observerMembers });
  const makeSet = (keys: SigningKeyPair[], offset: number): AdmissionWitnessSet => ({ version: 2, epoch: randomBytes(32).toString('base64url'),
    observerContext: witnessHandoffObserverPins(placeholder), quorum: 4, members: keys.map((k,i) => ({ publicKey: pub(k), endpoint: `ws://127.0.0.1:${witnessServers[i+offset].getListeningPort()}/` })),
    coordinators: base.coordinators.map(pub) });
  const oldSet = makeSet(old,0), newSet = makeSet(next,5);
  const policy = await signAdmissionPolicy({ ...base.body, version: 2, archivedKeys: [], keys: [{ ...base.body.keys[0], witnesses: oldSet }] }, base.authority, base.authorityKey.secretKey);
  const context = parseAdmissionPolicyObservers({ ...placeholder, genesis: admissionPolicyHead(policy) });
  async function replicas(historyContext: HistoryCheckpointContext, root: Parameters<typeof openHistoryCheckpointStore>[0]['initialize'], name: string) {
    mkdirSync(join(directory,name), { recursive: true });
    const stores = historyContext.members.map((replica,i) => openHistoryCheckpointStore({ directory: join(directory,name,`r${i}`), context: historyContext,
      replica, localKey: randomBytes(32), rootId: historyCheckpointEnvelopeId(root!), generation: 0, initialize: root, maxBytes: 6*1024*1024 }));
    stores.forEach(store => cleanup.push(store.close));
    const endpoints = [];
    for (let i = 0; i < 5; i++) {
      const key = volunteers.find(k => pub(k) === historyContext.members[i])!;
      if (!qualification100 && name.startsWith('witness-')) {
        const role = createHistoryGenerationReplica({ directory:join(directory,name,`successor-${i}`),context:historyContext,
          parent:stores[i],signingKey:key,localKey:randomBytes(32),initialize:true,maxBytes:6*1024*1024 }); cleanup.push(role.close);
        const listener = await listenHistoryAgreementReplica({...role,provision(raw){try{return role.provision(raw);}catch(error){console.info(JSON.stringify({kind:'funded-lifecycle-provision-refusal',owner:name,replica:i,error:error instanceof Error?error.message:String(error),storage:funding.status()}));throw error;}}},{port:0});cleanup.push(listener.close);
        endpoints.push({publicKey:historyContext.members[i],endpoint:listener.checkpointEndpoint});
      } else {
        const role = createHistoryCheckpointReplica({ context: historyContext, store: stores[i], signingKey: key }); cleanup.push(role.close);
        const listener = await listenHistoryCheckpointReplica(role, { port: 0 }); cleanup.push(listener.close);
        endpoints.push({ publicKey: historyContext.members[i], endpoint: listener.endpoint });
      }
    }
    return { stores, members: endpoints };
  }
  for (let i = 0; i < 5; i++) {
    const encryptionKey = randomBytes(32), enrollment = await createPolicyObserverHistoryRoot({ context, signingKey: volunteers[i], encryptionKey, policy, writerStateBytes:3*4*1024*1024+65536, now: () => now });
    const copies = await replicas(enrollment.context, enrollment.root, `observer-${i}`);
    const options = { directory: join(directory,`observer-${i}`,'owner'), encryptionKey, context, signingKey: volunteers[i], historyContext: enrollment.context, root: enrollment.root,
      members: copies.members, maxArchiveBytes: 4*1024*1024, now: () => now };
    let observer = await openProtectedPolicyObserver({ ...options, mode: 'create-new' }); cleanup.push(() => observer.close());
    await observer.ready(); observers.push(observer); exchanges.push(createAdmissionPolicyObserverExchange(observer, context, () => now));
    if(qualification100)fixtureJson(join(directory,`qualification-observer-${i}.json`),{directory:options.directory,encryptionKey:encryptionKey.toString('hex'),signingKey:{publicKey:pub(volunteers[i]),secretKey:Buffer.from(volunteers[i].secretKey).toString('base64url')},context,historyContext:enrollment.context,root:enrollment.root,members:copies.members,writerStateBytes:3*4*1024*1024+65536});
    reopenObservers.push(async()=>{observer.close(); observer=await openProtectedPolicyObserver({...options,mode:'open-existing'}); observers[i]=observer; exchanges[i]=createAdmissionPolicyObserverExchange(observer,context,()=>now);});
  }
  const limits = { maxPages: 128, maxEntries: 10000, maxArchiveBytes: 256*1024*1024, maxHistoryBytes: 256*1024*1024, maxTransitions: 128, maxPageReads: 1000, timeoutMs: 3000 };
  async function actor(key: SigningKeyPair, index: number, currentPolicy = policy) {
    const encryptionKey = randomBytes(32); let ownerDirectory = join(directory,`witness-${index}`,'owner');
    const historyContext: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends', historyId: randomBytes(32).toString('base64url'), owner: pub(key),
      authority: base.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}`, members: volunteers.map(pub).sort(), quorum: 4 };
    let lost = false, gate: Promise<void> | undefined, release: (()=>void) | undefined;
    let entered!:()=>void; const gateEntered = new Promise<void>(resolve=>{entered=resolve;});
    let protection = { transport: async(member: {publicKey:string;endpoint:string}, frame: Parameters<typeof exchangeHistoryCheckpoint>[1], signal: AbortSignal) => {
      if (gate && frame.request.action === 'append') { entered(); await gate; }
      const result = await exchangeHistoryCheckpoint(member,frame,signal); if (lost && frame.request.action === 'append') throw new Error('durable handoff reply lost'); return result;
    }, timeoutMs:1000, maxArchiveBytes: 4*1024*1024, context: historyContext, signingKey: key, members: historyContext.members.map((publicKey,i) => ({ publicKey, endpoint: `ws://127.0.0.1:${35000+i}/` })) };
    let selected:ArchivedAdmissionPolicy = currentPolicy, advance: ArchivedAdmissionPolicyAdvance | undefined;
    const options = () => ({ directory: ownerDirectory, encryptionKey, authority: base.authority, policy: selected, policyAdvance: advance, now: () => now, protection });
    let history = await openProtectedAdmissionSpendHistory({ ...options(), initialize: true, protection: { ...protection, initializeWriter: true } });
    const originalEnrollment = {version:1,kind:'admission-history-enrollment',...history.enrollment()};
    const copies = await replicas(historyContext, history.enrollment().root, `witness-${index}`); history.close(); protection = { ...protection, members: copies.members };
    history = await openProtectedAdmissionSpendHistory(options()); await history.ready();
    await history.backfillPolicyProof({ version: 1, kind: 'genesis', policy }, { context, installed: context.genesis, observed: context.genesis }, limits);
    const store = await openAdmissionPolicyStore({ path: join(ownerDirectory,'admission-community-policy.json'), encryptionKey, mode: 'create-new', now: () => now });
    await store.install(policy, base.authority, { observers: context }); store.bindProtectedHistory(historyCheckpointContextId(historyContext)); store.close();
    // The configured path binds the actual history context itself below.
    const policyStore = await openAdmissionPolicyStore({ path: join(ownerDirectory,'admission-community-policy.json'), encryptionKey, mode: 'open-existing', now: () => now }); policyStore.close();
    let verifier: Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>> | undefined;
    let operatorCounter=0;
    const value = { key, encryptionKey, stores: copies.stores,
      async operator(command:string,tail:string[]){
        await value.close();const prefix=join(directory,`operator-owner-${index}-${operatorCounter++}`),ownerKeyFile=fixtureJson(prefix+'-key.json',{publicKey:pub(key),secretKey:Buffer.from(key.secretKey).toString('base64url')});
        const config=fixtureJson(prefix+'-config.json',{version:1,...((protection as any).fundedGrowth?{fundedGrowth:'monotone-v1'}:{}),context:historyContext,members:copies.members,ownerKeyFile,limits:{archiveBytes:protection.maxArchiveBytes,archiveBlocks:10001}}),policyFile=fixtureJson(prefix+'-policy.json',selected),storageFile=prefix+'-storage.hex';
        writeOperatorTextAtomic(storageFile,encryptionKey.toString('hex'),64);
        const result=await runAdmissionHistoryCommand(command,[config,policyFile,storageFile,ownerDirectory,...tail.map(path=>path==='@role'?ownerKeyFile:path)]);
        if(command!=='witness-terminal-prepare')await value.openHistory();return result;
      },
      async continueOwner() {
        // Explicit operator recovery, preserving the old frozen directory and its marker.
        await value.close();
        const retained = await openProtectedAdmissionSpendHistory(options());
        const recoveryOriginals = [...retained.originalBlocks()]; retained.close();
        const prefix=join(directory,`continuation-${index}`),ownerKeyFile=fixtureJson(prefix+'-key.json',{publicKey:pub(key),secretKey:Buffer.from(key.secretKey).toString('base64url')}),
          originalsFile=fixtureJson(prefix+'-originals.json',recoveryOriginals),
          configFile=fixtureJson(prefix+'-config.json',{version:1,fundedGrowth:'monotone-v1',recoveryOriginalsFile:originalsFile,context:historyContext,members:copies.members,ownerKeyFile,limits:{archiveBytes:protection.maxArchiveBytes,archiveBlocks:10001}}),
          enrollmentFile=fixtureJson(prefix+'-enrollment.json',originalEnrollment),storageFile=prefix+'-storage.hex',workspace=prefix+'-recovery',destination=prefix+'-owner',policyFile=fixtureJson(prefix+'-policy.json',selected);
        writeOperatorTextAtomic(storageFile,encryptionKey.toString('hex'),64);
        const common=[configFile,enrollmentFile,storageFile,workspace];
        const review=(await runAdmissionHistoryCommand('owner-recovery-plan',[...common,'1'])).result as {approvalDigest:string};
        await runAdmissionHistoryCommand('owner-recovery-start',['--approve',review.approvalDigest,...common,'1']);
        let status:any;
        for(let step=0;step<10;step++){try{status=(await runAdmissionHistoryCommand('owner-recovery-step',common)).result;}catch(error){console.info(JSON.stringify({kind:'funded-lifecycle-recovery-refusal',owner:index,step,error:error instanceof Error?error.message:String(error),storage:funding.status()}));throw error;}if(status.complete)break;}
        expect(status.complete).toBe(true);
        const continuationFile=fixtureJson(prefix+'-continuation.json',status.continuation),restoreArgs=[...common,policyFile,destination],restoreReview=(await runAdmissionHistoryCommand('owner-recovery-review',restoreArgs)).result as {approvalDigest:string};
        await runAdmissionHistoryCommand('owner-recovery-restore',['--approve',restoreReview.approvalDigest,...restoreArgs]);
        const ancestry={version:1 as const,kind:'recovery-download' as const,directory:join(workspace,'download'),enrollmentFile,continuationFile,
          funding:{authorityDirectory:fundingDirectory!,authorityId:funding.status().authorityId}};
        const selection=captureHistoryAncestrySource(ancestry,configFile,historyContext);
        protection={...protection,fundedGrowth:'monotone-v1',ancestrySelection:selection} as typeof protection;
        ownerDirectory=destination;await value.openHistory();
      },
      get history() { return history; }, get verifier() { return verifier; },
      async openHistory() { verifier?.close(); await verifier?.drainPolicyObservations(); verifier = undefined; history.close(); history = await openProtectedAdmissionSpendHistory(options()); await history.ready(); return history; },
      crashInput(handoff: unknown) { return { options:{directory:ownerDirectory,authority:base.authority,policy:selected,policyAdvance:advance},protection:{context:historyContext,members:protection.members,maxArchiveBytes:protection.maxArchiveBytes,timeoutMs:1000},owner:{publicKey:Buffer.from(key.publicKey).toString('hex'),secretKey:Buffer.from(key.secretKey).toString('hex')},encryptionKey:encryptionKey.toString('hex'),time:now,handoff }; },
      loseReplies(value: boolean) { lost=value; },
      holdWrites() { gate=new Promise<void>(resolve=>{release=resolve;}); return gateEntered; },
      releaseWrites() { release?.(); gate=undefined; },
      async serve(coordinating = index === 0 || index === 5) { history.close(); verifier = await createConfiguredAdmissionVerifier({ ...options(), historyProtection: protection, witnessKey: key,
        ...(coordinating ? { coordinatorKey: base.coordinators[0] } : {}) }); },
      async install(nextPolicy: ArchivedAdmissionPolicy, nextAdvance: NonNullable<typeof advance>) { selected = nextPolicy; advance = nextAdvance; await value.openHistory(); const store=await openAdmissionPolicyStore({path:join(ownerDirectory,'admission-community-policy.json'),encryptionKey,mode:'open-existing',now:()=>now}); try {const resolved=await history.resolvedPolicy();store.mirrorResolved(resolved.capability,resolved.reference,resolved.freshness,historyCheckpointContextId(historyContext));} finally {store.close();} return history; },
      async close() { release?.(); verifier?.close(); await verifier?.drainPolicyObservations(); history.close(); },
    };
    if(qualification100)fixtureJson(join(directory,`qualification-owner-${index}.json`),value.crashInput(null));
    cleanup.push(value.close); return value;
  }
  for (let i = 0; i < 10; i++) actors.push(await actor(i < 5 ? old[i] : next[i-5],i));
  for (let i = 0; i < 5; i++) {
    const roles = { witness: { version: 2 as const, witness: pub(old[i]), votes: [], retiredIssuerKeys: [] }, coordinator: i === 0 ? { version: 2 as const, coordinator: pub(base.coordinators[0]), certificates: [], retiredIssuerKeys: [] } : null };
    const review = await actors[i].history.planRoleCapture(roles); await actors[i].history.captureRoles(roles,review.approvalDigest);
    await enrollProtectedWitnessEpoch(actors[i].history,policy); await actors[i].serve();
  }
  const issuerOwner=generateSigningKeyPair(), issuerContext:HistoryCheckpointContext={version:1,role:'admission-issuer',historyId:randomBytes(32).toString('base64url'),owner:pub(issuerOwner),authority:base.authority,policyDigest:`sha256:${admissionPolicyDigest(policy)}`,members:volunteers.map(pub).sort(),quorum:4};
  const allocation=await signAdmissionIssuanceAllocation({version:2,kind:'admission-issuance-allocation',claimPolicy:'authority-assigned-v1',community:'public',epoch:base.scope.epoch,notBefore:base.time-1000,issueUntil:base.time+3600000,totalTokenBudget:8,allocations:[{profile:policy.keys[0].profile,batchSize:1,maxPermits:8}]},base.authority,base.authorityKey.secretKey);
  let issuerOptions={path:join(directory,'issuer','ledger.json'),expectedProfile:policy.keys[0].profile,privateKey:base.keys.privateKey,expectedAllocationAuthority:base.authority,now:()=>now,
    protection:{context:issuerContext,signingKey:issuerOwner,members:issuerContext.members.map((publicKey,i)=>({publicKey,endpoint:`ws://127.0.0.1:${39000+i}/`})),writerDirectory:join(directory,'issuer','writer'),maxArchiveBytes:4*1024*1024}};
  let issuer=await openProtectedAdmissionIssuerLedger({...issuerOptions,initialize:{allocation,communityPolicy:policy,observers:context},protection:{...issuerOptions.protection,initializeWriter:true,initializeArchive:true}});
  const issuerCopies=await replicas(issuerContext,issuer.enrollment().root,'issuer');issuer.close();issuerOptions={...issuerOptions,protection:{...issuerOptions.protection,members:issuerCopies.members}};
  issuer=await openProtectedAdmissionIssuerLedger(issuerOptions);cleanup.push(()=>issuer.close());await issuer.ready();await issuer.backfillPolicyProof({version:1,kind:'genesis',policy},limits);
  const queryResponder=createAdmissionPolicyQueryResponder({context,policy:()=>undefined,maximumOperations:2,now:()=>now});cleanup.push(()=>queryResponder.close());
  const issuerProof=()=>queryResponder.exchange(issuer.preparePolicyObservation().query);
  const grant=async()=>{const assignment=await signAdmissionClaimAssignment({version:1,kind:'admission-claim-assignment',authority:base.authority,allocationDigest:admissionIssuanceAllocationDigest(allocation),community:'public',epoch:base.scope.epoch,claimHandle:randomBytes(32).toString('base64url'),issuerKeyFingerprint:policy.activeKey},allocation,base.authority,base.authorityKey.secretKey);return issuer.grantForAssignment(assignment,await issuerProof());};
  const wallet=await openManagedAdmissionWallet({directory:join(directory,'wallet'),encryptionKey:randomBytes(32),now:()=>now,proofStorage:{authority:funding,authorityId:funding.status().authorityId,directory:join(directory,'wallet-proof'),maxCiphertextBytes:4*1024*1024,maxRecords:128,limits}});cleanup.push(wallet.close);await wallet.installPolicy(policy,base.authority,context);
  async function token(){const permit=await grant(),batch=await createAdmissionIssuanceBatch(policy.keys[0].profile,1),response=await issuer.approve(permit,batch.request,await issuerProof());return(await batch.finalize(response))[0];}
  async function reserveWallet(binding:string){const query=wallet.preparePolicyObservation()!;const reply=await queryResponder.exchange(query);return wallet.capabilityFor({relayUrl:policy.keys[0].profile.relayUrls[0],action:'search',requestBinding:binding,policyObservation:{query,reply}})!;}
  return { ...base, token, issuer, issuerProof, grant, wallet, reserveWallet, queryResponder, policy, context, oldSet: policy.keys[0].witnesses!, newSet, actors, observers, reopenObservers, directory, now: (value: number) => { now=value; },
    claim(spend = randomBytes(32).toString('base64url'), letter = 'a'): AdmissionSpendClaim { return { setId: admissionWitnessSetId(policy.keys[0].witnesses!), issuerKey: policy.activeKey, spend, action: 'search', requestBinding: `admreq_${letter.repeat(86)}` }; } };
}

it('hands already-issued tokens to a disjoint protected witness cohort under the same RSA key, with a real drain and inherited partial constraints', async () => {
  const fundingDir = mkdtempSync(join(tmpdir(),'handoff-funding-')), funding = openStorageReservationAuthority({ directory: join(fundingDir,'authority'), mode: 'create-new', limitBytes: 2*1024*1024*1024 });
  cleanup.push(() => { funding.close(); rmSync(fundingDir,{recursive:true,force:true}); });
  await withStorageReservationAuthority(funding, async () => {
  const f = await fixture(funding,join(fundingDir,'authority')), token = await f.token(), tokenAfter = await f.token(), hiddenToken = await f.token(), abaToken = await f.token(), inflightToken = await f.token();
  const walletRequest=await f.wallet.requestTokens(1),walletPermit=await f.grant();await f.wallet.completeIssuance(await f.issuer.approve(walletPermit,walletRequest,await f.issuerProof()));
  const walletBinding=createAdmissionRequestBindingV2('search',{query:'retained wallet reservation'}),walletCapability=await f.reserveWallet(walletBinding),allowanceBefore=f.issuer.status();
  expect(f.wallet.status()).toMatchObject({reserved:1,available:0,total:1});
  const binding = createAdmissionRequestBindingV2('search',{ query: 'before handoff' });
  const accepted = await f.actors[0].verifier!.verifyAndSpend(presentBlindAdmissionTokenV2(token,f.scope,'search',binding), { action: 'search', requestBinding: binding, now: f.time });
  expect(accepted.status).toBe('accepted');
  expect((await f.actors[0].verifier!.verifyAndSpend(walletCapability,{action:'search',requestBinding:walletBinding,now:f.time})).status).toBe('accepted');
  const partial = f.claim(), split = f.claim();
  await f.actors[1].verifier!.witness!.vote(createAdmissionWitnessRequest(partial,f.coordinators[0]));
  await f.actors[2].verifier!.witness!.vote(createAdmissionWitnessRequest(split,f.coordinators[0]));
  await f.actors[3].verifier!.witness!.vote(createAdmissionWitnessRequest({ ...split, requestBinding: `admreq_${'b'.repeat(86)}` },f.coordinators[0]));
  const hiddenBinding = createAdmissionRequestBindingV2('search',{ query: 'hidden original certificate' });
  const hiddenCapability = presentBlindAdmissionTokenV2(hiddenToken,f.scope,'search',hiddenBinding);
  const hiddenSpend = await verifyBlindAdmissionTokenV2(hiddenCapability,f.scope,'search',hiddenBinding,f.keys.publicKey);
  if (!hiddenSpend) throw new Error('Issued hidden token failed verification');
  const hidden = { ...f.claim(hiddenSpend), requestBinding: hiddenBinding };
  const hiddenVotes = []; for (let i=0;i<4;i++) hiddenVotes.push(await f.actors[i].verifier!.witness!.vote(createAdmissionWitnessRequest(hidden,f.coordinators[0])));
  await f.actors[4].verifier!.witness!.vote(createAdmissionWitnessRequest({ ...hidden, requestBinding: `admreq_${'z'.repeat(86)}` },f.coordinators[0]));
  const hiddenCertificate = { version: 1 as const, votes: hiddenVotes };
  const inflightBinding = createAdmissionRequestBindingV2('search',{query:'crossing the durable seal'}), gateEntered = f.actors[0].holdWrites();
  const inflight = Promise.resolve(f.actors[0].verifier!.verifyAndSpend(presentBlindAdmissionTokenV2(inflightToken,f.scope,'search',inflightBinding),{action:'search',requestBinding:inflightBinding,now:f.time})).then(value=>({value}),error=>({error}));
  await gateEntered;
  for (let i=1;i<5;i++) await f.actors[i].openHistory();
  const proposal = proposeProtectedWitnessHandoff(f.actors[1].history,f.policy.activeKey,f.newSet,f.authorityKey);
  f.actors[1].loseReplies(true);
  await expect(freezeProtectedWitness(f.actors[1].history,proposal,f.actors[1].key,f.actors[1].encryptionKey)).rejects.toThrow();
  const uncertain = f.actors[1].history.read().pending; expect(uncertain).not.toBeNull();
  f.actors[1].loseReplies(false); await f.actors[1].openHistory(); expect(f.actors[1].history.read().applied!.id).toBe(historyCheckpointEnvelopeId(uncertain!));
  const preparing={...f.actors[2].history.handoffState()!,phase:'PREPARING',proposal,manifest:null,drained:[],activation:null};
  const crashInput=f.actors[2].crashInput(preparing); await f.actors[2].close();
  const child=fork(fileURLToPath(new URL('../../../relay/src/__tests__/fixtures/protected-witness-handoff-crash.ts',import.meta.url)),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});
  cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}});
  const [readyMessage]=await once(child,'message'); expect(readyMessage).toBe('ready');
  const exited=once(child,'exit'); child.send(crashInput); const [exitCode,signal]=await exited; expect(exitCode).toBeNull(); expect(signal).toBe('SIGKILL');
  await f.actors[2].openHistory(); expect(f.actors[2].history.handoffState()!.phase).toBe('PREPARING');
  const frozen = [];
  for (let i=1;i<5;i++) {if(i===4){const path=fixtureJson(join(f.directory,'cli-freeze-proposal.json'),proposal),output=join(f.directory,'cli-frozen.json');expect((await f.actors[i].operator('witness-prepare',[path,'@role',output])).result.result).toBe('witness-old-fenced');frozen.push(JSON.parse(readFileSync(output,'utf8')));}else frozen.push(await freezeProtectedWitness(f.actors[i].history,proposal,f.actors[i].key,f.actors[i].encryptionKey));}
  expect(await freezeProtectedWitness(f.actors[1].history,proposal,f.actors[1].key,f.actors[1].encryptionKey)).toEqual(frozen[0]);
  const pins:WitnessTerminalPins[]=[],terminalPairs:WitnessTerminalEvidence[]=[];
  for(let i=1;i<5;i++){
    const pairFile=join(f.directory,`terminal-pair-${i}.json`),pinsFile=join(f.directory,`terminal-pins-${i}.json`),proposalPath=fixtureJson(join(f.directory,`terminal-proposal-${i}.json`),proposal);
    console.info(JSON.stringify({kind:'terminal-operator-capacity-checkpoint',owner:i,storage:funding.status(),recoveryStateMaximumBytes:96*1024*1024,recoveryReservationBytes:2*96*1024*1024+8192}));
    expect((await f.actors[i].operator('witness-terminal-prepare',[proposalPath,'create-new','1',pairFile,pinsFile])).result.result).toBe('witness-terminal-prepared');
    terminalPairs.push(JSON.parse(readFileSync(pairFile,'utf8')));pins.push(JSON.parse(readFileSync(pinsFile,'utf8')));
  }
  const pinsFile=fixtureJson(join(f.directory,'retained-terminal-pins.json'),pins);
  const proposalFile=join(f.directory,'operator-proposal.json'), frozenFiles=terminalPairs.map((value,i)=>{const path=join(f.directory,`operator-frozen-${i}.json`);fixtureJson(path,value);return path;});
  fixtureJson(proposalFile,proposal);
  const manifestFile=join(f.directory,'operator-manifest.json'),sealFile=join(f.directory,'operator-seal.json');
  await runWitnessHandoffCommand('witness-transfer-prepare',[proposalFile,pinsFile,...frozenFiles,manifestFile,sealFile]);
  const manifest = await prepareProtectedWitnessTransfer(proposal,terminalPairs,undefined,pins);
  // Authenticated progress from the successful replay cannot hide a changed
  // source in a later operation, even when its owner signs the changed descriptor.
  for (const omit of ['tail', 'middle'] as const) {
    const changed = structuredClone(terminalPairs), first = changed[0].evidence;
    if (omit === 'tail') first.blocks.pop(); else first.blocks.splice(1, 1);
    const descriptor = { version: first.version, context: first.context, genesisId: first.genesisId,
      encryptionKey: first.encryptionKey, blocks: first.blocks.map(historyCheckpointEnvelopeId) };
    first.report = createWitnessFreezeReport(proposal, witnessHandoffDigest(descriptor), terminalPairs[0].evidence.report.head, f.actors[1].key);
    await expect(prepareProtectedWitnessTransfer(proposal,changed,undefined,pins)).rejects.toThrow();
  }
  expect(await prepareProtectedWitnessTransfer(proposal,terminalPairs,undefined,pins)).toEqual(manifest);
  expect(JSON.parse(readFileSync(manifestFile,'utf8'))).toEqual(manifest);
  const retryManifest=join(f.directory,'operator-manifest-retry.json'),retrySeal=join(f.directory,'operator-seal-retry.json');
  await runWitnessHandoffCommand('witness-transfer-prepare',[proposalFile,pinsFile,...frozenFiles,retryManifest,retrySeal]);
  expect(readFileSync(retryManifest,'utf8')).toBe(readFileSync(manifestFile,'utf8'));
  const seal = { version: 1 as const, proposal, manifest: witnessHandoffDigest(manifest), freezes: manifest.freezes, activation: null };
  await f.observers[0].sealWitnessHandoff(seal); await f.reopenObservers[0]();
  const started = performance.now(), drained = await Promise.all(f.observers.slice(0,4).map(o => o.drainWitnessHandoff(seal)));
  expect(performance.now()-started).toBeGreaterThanOrEqual(3000);
  f.actors[0].releaseWrites(); expect(await inflight).not.toHaveProperty('value.status','accepted');
  const ready = [];
  for (let i=5;i<9;i++) {
    ready.push(await installProtectedWitnessTransfer(f.actors[i].history,terminalPairs,manifest,drained,f.actors[i].key,undefined,pins));
    if (i===5) { const roles = f.actors[i].history.roleState(), capture = { ...roles, coordinator: { version: 2 as const, coordinator: pub(f.coordinators[0]), certificates: [], retiredIssuerKeys: [] } }; const review = await f.actors[i].history.planRoleCapture(capture); await f.actors[i].history.captureRoles(capture,review.approvalDigest); }
  }
  await f.actors[6].openHistory(); expect(await installProtectedWitnessTransfer(f.actors[6].history,terminalPairs,manifest,drained,f.actors[6].key,undefined,pins)).toEqual(ready[1]);
  const activation = createWitnessHandoffActivation({ proposal, manifest: witnessHandoffDigest(manifest), freezes: manifest.freezes, drained, ready },f.authorityKey);
  const previousFile=fixtureJson(join(f.directory,'cli-prior.json'),f.policy),drainFile=fixtureJson(join(f.directory,'cli-drain.json'),drained),readyFiles=ready.map((value,i)=>fixtureJson(join(f.directory,`cli-ready-${i}.json`),value)),authorityFile=fixtureJson(join(f.directory,'cli-authority.json'),{publicKey:pub(f.authorityKey),secretKey:Buffer.from(f.authorityKey.secretKey).toString('base64url')}),nextFile=join(f.directory,'cli-next.json'),advanceFile=join(f.directory,'cli-advance.json');
  await runAdmissionHistoryCommand('witness-activation-prepare',[previousFile,manifestFile,drainFile,...readyFiles,authorityFile,nextFile,advanceFile]);
  const nextPolicy = await signAdmissionPolicy({ ...f.body, version: 2, archivedKeys: [], revision: 2,
    keys: [{ ...f.policy.keys[0], witnesses: proposal.newSet, witnessHandoff: activation }] },f.authority,f.authorityKey.secretKey);
  const advance = await createAdmissionPolicyAdvance(f.policy,nextPolicy,f.context,f.authorityKey);
  expect(JSON.parse(readFileSync(nextFile,'utf8'))).toEqual(nextPolicy);expect(JSON.parse(readFileSync(advanceFile,'utf8'))).toEqual(advance);
  for (const observer of f.observers.slice(0,4)) await observer.advance(advance);
  expect(await f.observers[0].successor(f.context.genesis)).toEqual(advance);
  await f.reopenObservers[0]();
  const staleCatchup=await f.observers[0].successor(f.context.genesis);
  expect(staleCatchup).toEqual(advance);
  await f.issuer.installPolicy(nextPolicy,f.authority,{advance});await f.wallet.installPolicy(advance,f.authority);
  expect(f.issuer.status()).toMatchObject({allocatedPermits:allowanceBefore.allocatedPermits,boundPermits:allowanceBefore.boundPermits,completedPermits:allowanceBefore.completedPermits,remainingPermits:allowanceBefore.remainingPermits});
  expect(await f.reserveWallet(walletBinding)).toEqual(walletCapability);
  for (let i=5;i<9;i++) {
    await f.actors[i].install(nextPolicy,advance); if(i===5){expect((await f.actors[i].operator('witness-activate',[nextFile,advanceFile])).result.result).toBe('witness-active-new');}else await activateProtectedWitnessTransfer(f.actors[i].history,activation); await activateProtectedWitnessTransfer(f.actors[i].history,activation); await f.actors[i].serve();
  }
  expect(nextPolicy.activeKey).toBe(f.policy.activeKey); expect(nextPolicy.keys[0].profile).toEqual(f.policy.keys[0].profile);
  await expect(f.actors[5].verifier!.witness!.vote(createAdmissionWitnessRequest({ ...partial, setId: admissionWitnessSetId(proposal.newSet) },f.coordinators[0]))).resolves.toMatchObject({ requestBinding: partial.requestBinding });
  await expect(f.actors[6].verifier!.witness!.vote(createAdmissionWitnessRequest({ ...split, setId: admissionWitnessSetId(proposal.newSet) },f.coordinators[0]))).rejects.toThrow(/split/);
  await expect(f.actors[5].verifier!.witness!.vote(createAdmissionWitnessRequest({ ...hidden, setId: admissionWitnessSetId(proposal.newSet) },f.coordinators[0]))).rejects.toThrow(/split/);
  for (let i=5;i<9;i++) { await f.actors[i].openHistory(); expect(await retainOriginalWitnessCertificate(f.actors[i].history,hiddenCertificate)).toBe('bound'); await f.actors[i].serve(); }
  expect((await f.actors[5].verifier!.verifyAndSpend(hiddenCapability,{ action:'search',requestBinding:hiddenBinding,now:f.time })).status).toBe('accepted');
  const afterBinding = createAdmissionRequestBindingV2('search',{ query: 'after handoff' });
  expect((await f.actors[5].verifier!.verifyAndSpend(presentBlindAdmissionTokenV2(tokenAfter,f.scope,'search',afterBinding),{ action:'search',requestBinding:afterBinding,now:f.time })).status).toBe('accepted');
  // Return to the original identities with a new signed epoch, preserving both
  // resolved and unresolved original state across the second actual handoff.
  for (let i=5;i<9;i++) await f.actors[i].openHistory();
  const returnedSet = { ...f.oldSet, epoch:randomBytes(32).toString('base64url') };
  await expect(Promise.resolve().then(()=>proposeProtectedWitnessHandoff(f.actors[5].history,f.policy.activeKey,f.oldSet,f.authorityKey))).rejects.toThrow(/Historical witness epoch/);
  const originalReuse=createWitnessHandoffProposal({...proposal,id:randomBytes(32).toString('base64url'),previous:advance.commitment.next,oldSet:f.newSet,newSet:f.oldSet},f.authorityKey);
  await expect(freezeProtectedWitness(f.actors[5].history,originalReuse,f.actors[5].key,f.actors[5].encryptionKey)).rejects.toThrow(/Historical witness epoch/);
  await expect(parseProtectedWitnessHandoffState({...f.actors[5].history.handoffState()!,phase:'PREPARING',proposal:originalReuse,manifest:null,drained:[],activation:null},nextPolicy)).rejects.toThrow(/Historical witness epoch/);
  const returning = proposeProtectedWitnessHandoff(f.actors[5].history,f.policy.activeKey,returnedSet,f.authorityKey), returnedEvidence = [];
  for (let i=5;i<9;i++) await freezeProtectedWitness(f.actors[i].history,returning,f.actors[i].key,f.actors[i].encryptionKey);
  const returnedPins:WitnessTerminalPins[]=f.actors.slice(5,9).map(actor=>{const saved=actor.history.read(),first=actor.history.originalBlocks()[Symbol.iterator]().next().value!;return {context:saved.context,genesisId:historyCheckpointEnvelopeId(first),rootId:historyCheckpointEnvelopeId(saved.root),generation:saved.root.generation,nextGeneration:1,head:{...saved.applied!}};});
  for (let i=5;i<9;i++) returnedEvidence.push(await f.actors[i].history.prepareTerminalWitness(returning,{mode:'create-new',nextGeneration:1}));
  const returnedManifest = await prepareProtectedWitnessTransfer(returning,returnedEvidence,undefined,returnedPins), returnedSeal = {version:1 as const,proposal:returning,manifest:witnessHandoffDigest(returnedManifest),freezes:returnedManifest.freezes,activation:null};
  const returnedDrain = await Promise.all(f.observers.slice(0,4).map(o=>o.drainWitnessHandoff(returnedSeal))), returnedReady = [];
  for (let i=1;i<5;i++) {await f.actors[i].continueOwner();returnedReady.push(await installProtectedWitnessTransfer(f.actors[i].history,returnedEvidence,returnedManifest,returnedDrain,f.actors[i].key,undefined,returnedPins));}
  const returnedActivation = createWitnessHandoffActivation({proposal:returning,manifest:witnessHandoffDigest(returnedManifest),freezes:returnedManifest.freezes,drained:returnedDrain,ready:returnedReady},f.authorityKey);
  await f.actors[5].continueOwner();
  const priorResolved=(await f.actors[5].history.resolvedPolicy()).capability,reader=async()=>{throw new Error('No archive pages in this same-key fixture');},archiveLimits={maxPages:128,maxEntries:10000,maxArchiveBytes:256*1024*1024,maxHistoryBytes:256*1024*1024,maxTransitions:128,maxPageReads:1000,timeoutMs:3000};
  const staged=await prepareAdmissionPolicyV3Successor({previous:priorResolved,next:{revision:3,issuedAt:f.body.issuedAt,expiresAt:f.body.expiresAt,activeKey:f.policy.activeKey,keys:[{...f.policy.keys[0],witnesses:returning.newSet,witnessHandoff:returnedActivation}]},reader,limits:archiveLimits});
  const returnedPolicy=await signAdmissionPolicyV3(staged.body,f.authority,f.authorityKey.secretKey),returnedAdvance=(await createResolvedAdmissionPolicyAdvance({previous:priorResolved,policy:returnedPolicy,key:f.authorityKey,reader,limits:archiveLimits})).advance;
  const returnedManifestFile=fixtureJson(join(f.directory,'cli-returned-manifest.json'),returnedManifest),returnedDrainFile=fixtureJson(join(f.directory,'cli-returned-drain.json'),returnedDrain),returnedReadyFiles=returnedReady.map((value,i)=>fixtureJson(join(f.directory,`cli-returned-ready-${i}.json`),value)),returnedPolicyFile=join(f.directory,'cli-returned-policy.json'),returnedAdvanceFile=join(f.directory,'cli-returned-advance.json');
  expect((await f.actors[5].operator('witness-activation-prepare-v3',[returnedManifestFile,returnedDrainFile,...returnedReadyFiles,authorityFile,returnedPolicyFile,returnedAdvanceFile])).result.result).toBe('witness-v3-activation-prepared');
  expect(JSON.parse(readFileSync(returnedPolicyFile,'utf8'))).toEqual(returnedPolicy);expect(JSON.parse(readFileSync(returnedAdvanceFile,'utf8'))).toEqual(returnedAdvance);
  for (const observer of f.observers.slice(0,4)) await observer.advance(returnedAdvance);
  await f.reopenObservers[0]();
  expect(await f.observers[0].successor(f.context.genesis)).toEqual(advance);
  expect(await f.observers[0].successor(advance.commitment.next)).toEqual(returnedAdvance);
  await f.issuer.installPolicy(returnedPolicy,f.authority,{advance:returnedAdvance});await f.wallet.installPolicy(returnedAdvance,f.authority);
  expect(f.issuer.status()).toMatchObject({allocatedPermits:allowanceBefore.allocatedPermits,remainingPermits:allowanceBefore.remainingPermits});
  expect(await f.reserveWallet(walletBinding)).toEqual(walletCapability);expect(f.wallet.status()).toMatchObject({reserved:1,available:0,total:1});
  for (let i=1;i<5;i++) {
    await f.actors[i].install(nextPolicy,advance); await f.actors[i].install(returnedPolicy,returnedAdvance); await activateProtectedWitnessTransfer(f.actors[i].history,returnedActivation);
    if (i===1) { const roles=f.actors[i].history.roleState(), capture={...roles,coordinator:{version:2 as const,coordinator:pub(f.coordinators[0]),certificates:[],retiredIssuerKeys:[]}}; const review=await f.actors[i].history.planRoleCapture(capture); await f.actors[i].history.captureRoles(capture,review.approvalDigest); }
    await f.actors[i].serve(i===1);
  }
  await f.actors[0].openHistory(); await installProtectedCoordinatorTransfer(f.actors[0].history,returnedEvidence,returnedManifest,returnedDrain,f.coordinators[0],undefined,returnedPins);
  await f.actors[0].install(nextPolicy,advance); await f.actors[0].install(returnedPolicy,returnedAdvance); await activateProtectedWitnessTransfer(f.actors[0].history,returnedActivation); await f.actors[0].serve();
  expect(admissionWitnessSetId(returning.newSet)).not.toBe(admissionWitnessSetId(f.oldSet));
  await expect(f.actors[1].verifier!.witness!.vote(createAdmissionWitnessRequest(partial,f.coordinators[0]))).rejects.toThrow(/Unauthenticated/);
  await expect(f.actors[1].verifier!.witness!.vote(createAdmissionWitnessRequest({...split,setId:admissionWitnessSetId(returning.newSet)},f.coordinators[0]))).rejects.toThrow(/split/);
  const abaBinding=createAdmissionRequestBindingV2('search',{query:'same identities, distinct active epoch'}), abaCapability=presentBlindAdmissionTokenV2(abaToken,f.scope,'search',abaBinding);
  expect((await f.actors[1].verifier!.verifyAndSpend(abaCapability,{action:'search',requestBinding:abaBinding,now:f.time})).status).toBe('accepted');
  f.now(f.policy.keys[0].spendUntil);
  expect((await f.actors[1].verifier!.verifyAndSpend(hiddenCapability,{action:'search',requestBinding:hiddenBinding,now:f.policy.keys[0].spendUntil})).status).toBe('rejected');
  expect((await f.actors[1].verifier!.verifyAndSpend(abaCapability,{action:'search',requestBinding:abaBinding,now:f.policy.keys[0].spendUntil})).status).toBe('replay');
  await expect(f.actors[0].verifier!.witness!.vote(createAdmissionWitnessRequest(f.claim(),f.coordinators[0]))).rejects.toThrow();
  expect((await f.actors[0].verifier!.verifyAndSpend(presentBlindAdmissionTokenV2(token,f.scope,'search',binding),{action:'search',requestBinding:binding,now:f.policy.keys[0].spendUntil})).status).toBe('replay');
  await f.actors[1].openHistory();
  const conflictingOld={...hidden,requestBinding:`admreq_${'y'.repeat(86)}`},conflictingCertificate={version:1 as const,votes:f.witnesses.slice(0,4).map(key=>createAdmissionWitnessVote(conflictingOld,key))};
  expect(await retainOriginalWitnessCertificate(f.actors[1].history,conflictingCertificate)).toBe('conflict');await f.actors[1].serve(true);
  await expect(f.actors[1].verifier!.witness!.vote(createAdmissionWitnessRequest({...hidden,setId:admissionWitnessSetId(returning.newSet)},f.coordinators[0]))).rejects.toThrow(/conflict/);
  await f.actors[1].openHistory();await f.actors[1].serve(true);
  await expect(f.actors[1].verifier!.witness!.vote(createAdmissionWitnessRequest({...hidden,setId:admissionWitnessSetId(returning.newSet)},f.coordinators[0]))).rejects.toThrow(/conflict/);
  console.info(JSON.stringify({kind:'protected-witness-handoff-receipt',transitions:2,replicaStores:80,realDrainMs:3000,storage:funding.status(),originalRetryLocalOnly:true}));
  expect(funding.status().reservedBytes).toBeLessThanOrEqual(2*1024*1024*1024);
  });
}, 120000);

it.skipIf(!qualification100)('frozen100 actual protected same-RSA witness handoffs with complete retained original evidence',async()=>{
  const seed='v04-same-key-handoff-100-2026-10-20',hash=(label:string)=>createHash('sha256').update(seed+'\n'+label).digest('base64url');
  const fundingDir=mkdtempSync(join(tmpdir(),'handoff-100-funding-')),funding=openStorageReservationAuthority({directory:join(fundingDir,'authority'),mode:'create-new',limitBytes:2*1024*1024*1024});
  cleanup.push(()=>funding.close());let completed=0,originalEvidenceChecks=0,certifiedBindingChecks=0,issuerCounterChecks=0;
  campaignRecord({kind:'campaign-start',seed,target:100,fundingDir,limitBytes:2*1024*1024*1024});
  try{await withStorageReservationAuthority(funding,async()=>{
    const f=await fixture(funding),main=await f.token(),fresh=[await f.token(),await f.token(),await f.token()],hiddenToken=await f.token(),inflightToken=await f.token();
    const walletRequest=await f.wallet.requestTokens(1),permit=await f.grant();await f.wallet.completeIssuance(await f.issuer.approve(permit,walletRequest,await f.issuerProof()));
    const mainBinding=createAdmissionRequestBindingV2('search',{query:seed}),mainCapability=presentBlindAdmissionTokenV2(main,f.scope,'search',mainBinding),walletBinding=createAdmissionRequestBindingV2('search',{query:seed+' wallet'}),walletCapability=await f.reserveWallet(walletBinding),allowance=f.issuer.status();
    expect((await f.actors[0].verifier!.verifyAndSpend(mainCapability,{action:'search',requestBinding:mainBinding,now:f.time})).status).toBe('accepted');
    expect((await f.actors[0].verifier!.verifyAndSpend(walletCapability,{action:'search',requestBinding:walletBinding,now:f.time})).status).toBe('accepted');
    const partial=f.claim(hash('partial')),split=f.claim(hash('split'));
    await f.actors[1].verifier!.witness!.vote(createAdmissionWitnessRequest(partial,f.coordinators[0]));
    await f.actors[2].verifier!.witness!.vote(createAdmissionWitnessRequest(split,f.coordinators[0]));
    await f.actors[3].verifier!.witness!.vote(createAdmissionWitnessRequest({...split,requestBinding:`admreq_${'b'.repeat(86)}`},f.coordinators[0]));
    const hiddenBinding=createAdmissionRequestBindingV2('search',{query:seed+' hidden'}),hiddenCapability=presentBlindAdmissionTokenV2(hiddenToken,f.scope,'search',hiddenBinding),hiddenSpend=await verifyBlindAdmissionTokenV2(hiddenCapability,f.scope,'search',hiddenBinding,f.keys.publicKey);
    if(!hiddenSpend)throw new Error('Original hidden token invalid');
    const hidden={...f.claim(hiddenSpend),requestBinding:hiddenBinding},votes=[];
    for(let i=0;i<4;i++)votes.push(await f.actors[i].verifier!.witness!.vote(createAdmissionWitnessRequest(hidden,f.coordinators[0])));
    await f.actors[4].verifier!.witness!.vote(createAdmissionWitnessRequest({...hidden,requestBinding:`admreq_${'z'.repeat(86)}`},f.coordinators[0]));
    const hiddenCertificate={version:1 as const,votes},advances:ArchivedAdmissionPolicyAdvance[]=[];
    const originalEvidence={set:structuredClone(f.oldSet),certificate:structuredClone(hiddenCertificate),votes:[] as typeof votes};
    const issuerExpected={allocatedPermits:allowance.allocatedPermits,boundPermits:allowance.boundPermits,completedPermits:allowance.completedPermits,preparedPermits:allowance.preparedPermits,remainingPermits:allowance.remainingPermits};
    fixtureJson(join(f.directory,'qualification-original-cases.json'),{mainCapability,walletCapability,hiddenCapability,hiddenCertificate,partial,split,initialPolicy:f.policy});
    let current:ArchivedAdmissionPolicy=f.policy,currentSet=f.oldSet;
    const archiveLimits={maxPages:128,maxEntries:10000,maxArchiveBytes:256*1024*1024,maxHistoryBytes:256*1024*1024,maxTransitions:128,maxPageReads:1000,timeoutMs:3000},reader=async()=>{throw new Error('Same-key campaign has no RSA-key archive additions');};
    const inflightBinding=createAdmissionRequestBindingV2('search',{query:seed+' in-flight'}),entered=f.actors[0].holdWrites(),inflight=Promise.resolve(f.actors[0].verifier!.verifyAndSpend(presentBlindAdmissionTokenV2(inflightToken,f.scope,'search',inflightBinding),{action:'search',requestBinding:inflightBinding,now:f.time})).then(value=>({value}),error=>({error}));await entered;
    campaignRecord({kind:'original-state',issuerKey:f.policy.activeKey,initialEpoch:currentSet.epoch,allowance,wallet:f.wallet.status(),funding:funding.status()});
    for(let trial=1;trial<=100;trial++){
      const old=trial%2===1?[1,2,3,4]:[5,6,7,8],next=trial%2===1?[5,6,7,8]:[1,2,3,4],newSet={...(trial%2===1?f.newSet:f.oldSet),epoch:hash(`epoch-${trial}`)};
      for(const i of old)await f.actors[i].openHistory();
      if(trial===1){originalEvidence.votes=old.flatMap(i=>f.actors[i].history.roleState().witness!.votes.map(v=>structuredClone(v)));fixtureJson(join(f.directory,'qualification-precaptured-expectations.json'),{originalEvidence,issuerExpected});campaignRecord({kind:'precaptured-expectations',originalVotes:originalEvidence.votes.length,issuerExpected});}
      const proposal=proposeProtectedWitnessHandoff(f.actors[old[0]].history,f.policy.activeKey,newSet,f.authorityKey);
      campaignRecord({kind:'trial-start',trial,previousRevision:current.revision,oldEpoch:currentSet.epoch,newEpoch:newSet.epoch});
      if(trial%10===0){
        const owner=f.actors[old[0]];owner.loseReplies(true);await expect(freezeProtectedWitness(owner.history,proposal,owner.key,owner.encryptionKey)).rejects.toThrow();expect(owner.history.read().pending).not.toBeNull();owner.loseReplies(false);await owner.openHistory();
      }
      if(trial===25||trial===75){
        const owner=f.actors[old[1]],state={...owner.history.handoffState()!,phase:'PREPARING',proposal,manifest:null,drained:[],activation:null},input=owner.crashInput(state);await owner.close();
        const child=fork(fileURLToPath(new URL('../../../relay/src/__tests__/fixtures/protected-witness-handoff-crash.ts',import.meta.url)),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});
        const [ready]=await once(child,'message');expect(ready).toBe('ready');const exited=once(child,'exit');child.send(input);const [code,signal]=await exited;expect(code).toBeNull();expect(signal).toBe('SIGKILL');await owner.openHistory();expect(owner.history.handoffState()!.phase).toBe('PREPARING');
      }
      const frozen=[];for(const i of old)frozen.push(await freezeProtectedWitness(f.actors[i].history,proposal,f.actors[i].key,f.actors[i].encryptionKey));
      const manifest=await prepareProtectedWitnessTransfer(proposal,frozen),seal={version:1 as const,proposal,manifest:witnessHandoffDigest(manifest),freezes:manifest.freezes,activation:null};
      if(trial%10===0){await f.observers[0].sealWitnessHandoff(seal);await f.reopenObservers[0]();}
      const drainStarted=performance.now(),drained=await Promise.all(f.observers.slice(0,4).map(o=>o.drainWitnessHandoff(seal)));expect(performance.now()-drainStarted).toBeGreaterThanOrEqual(3000);campaignRecord({kind:'trial-drained',trial,drainMs:performance.now()-drainStarted});
      if(trial===1){f.actors[0].releaseWrites();expect(await inflight).not.toHaveProperty('value.status','accepted');}
      const ready=[];for(const i of next)ready.push(await installProtectedWitnessTransfer(f.actors[i].history,frozen,manifest,drained,f.actors[i].key));
      const destination=f.actors[next[0]],roles=destination.history.roleState();if(!roles.coordinator){const capture={...roles,coordinator:{version:2 as const,coordinator:pub(f.coordinators[0]),certificates:[],retiredIssuerKeys:[]}},review=await destination.history.planRoleCapture(capture);await destination.history.captureRoles(capture,review.approvalDigest);}
      const activation=createWitnessHandoffActivation({proposal,manifest:witnessHandoffDigest(manifest),freezes:manifest.freezes,drained,ready},f.authorityKey),previous=(await f.actors[old[0]].history.resolvedPolicy()).capability;
      const prepared=await prepareAdmissionPolicyV3Successor({previous,next:{revision:current.revision+1,issuedAt:current.issuedAt,expiresAt:current.expiresAt,activeKey:current.activeKey,keys:[{...current.keys[0],witnesses:newSet,witnessHandoff:activation}]},reader,limits:archiveLimits}),policy=await signAdmissionPolicyV3(prepared.body,f.authority,f.authorityKey.secretKey),advance=(await createResolvedAdmissionPolicyAdvance({previous,policy,key:f.authorityKey,reader,limits:archiveLimits})).advance;
      for(const o of f.observers.slice(0,4))await o.advance(advance);advances.push(advance);
      await f.issuer.installPolicy(policy,f.authority,{advance});await f.wallet.installPolicy(advance,f.authority);
      for(const i of next){
        for(const a of advances.filter(a=>a.policy.revision>f.actors[i].history.policy().revision))await f.actors[i].install(a.policy,a);
        await activateProtectedWitnessTransfer(f.actors[i].history,activation);
        if(trial>=51){
          const saved=f.actors[i].history.handoffState()!;
          for(const evidence of [saved.inherited,saved.manifest!.inherited]){
            expect(evidence.sets).toContainEqual(originalEvidence.set);
            for(const vote of originalEvidence.votes)expect(evidence.votes).toContainEqual(vote);
            const recovered=evidence.certificates.find(c=>c.votes[0].spend===hiddenSpend&&c.votes[0].requestBinding===hiddenBinding);
            expect(recovered?.votes).toHaveLength(4);
            for(const vote of originalEvidence.certificate.votes)expect(recovered!.votes).toContainEqual(vote);
          }
          originalEvidenceChecks++;
        }
        await f.actors[i].serve(i===next[0]);
      }
      expect(policy.activeKey).toBe(f.policy.activeKey);expect(policy.keys[0].profile).toEqual(f.policy.keys[0].profile);expect(policy.keys[0].retryUntil).toBe(f.policy.keys[0].retryUntil);
      const result=await destination.verifier!.verifyAndSpend(mainCapability,{action:'search',requestBinding:mainBinding,now:f.time});expect(['accepted','replay']).toContain(result.status);
      expect(await f.reserveWallet(walletBinding)).toEqual(walletCapability);expect(f.wallet.status()).toMatchObject({reserved:1,available:0,total:1});expect(f.issuer.status()).toMatchObject(issuerExpected);issuerCounterChecks++;
      if(trial>=51){
        expect(['accepted','replay']).toContain((await destination.verifier!.verifyAndSpend(hiddenCapability,{action:'search',requestBinding:hiddenBinding,now:f.time})).status);
        const wrongBinding=createAdmissionRequestBindingV2('search',{query:seed+' conflicting certified binding'});
        expect((await destination.verifier!.verifyAndSpend(presentBlindAdmissionTokenV2(hiddenToken,f.scope,'search',wrongBinding),{action:'search',requestBinding:wrongBinding,now:f.time})).status).toBe('rejected');certifiedBindingChecks++;
      }
      await expect(destination.verifier!.witness!.vote(createAdmissionWitnessRequest({...partial,setId:admissionWitnessSetId(proposal.newSet)},f.coordinators[0]))).resolves.toMatchObject({requestBinding:partial.requestBinding});
      await expect(destination.verifier!.witness!.vote(createAdmissionWitnessRequest({...split,setId:admissionWitnessSetId(proposal.newSet)},f.coordinators[0]))).rejects.toThrow(/split/);
      if(trial<50)await expect(destination.verifier!.witness!.vote(createAdmissionWitnessRequest({...hidden,setId:admissionWitnessSetId(proposal.newSet)},f.coordinators[0]))).rejects.toThrow(/split/);
      if(trial===50){for(const i of next){await f.actors[i].openHistory();expect(await retainOriginalWitnessCertificate(f.actors[i].history,hiddenCertificate)).toBe('bound');await f.actors[i].serve(i===next[0]);}expect((await destination.verifier!.verifyAndSpend(hiddenCapability,{action:'search',requestBinding:hiddenBinding,now:f.time})).status).toBe('accepted');}
      if([1,64,100].includes(trial)){const binding=createAdmissionRequestBindingV2('search',{query:`${seed} fresh ${trial}`});expect((await destination.verifier!.verifyAndSpend(presentBlindAdmissionTokenV2(fresh[[1,64,100].indexOf(trial)],f.scope,'search',binding),{action:'search',requestBinding:binding,now:f.time})).status).toBe('accepted');}
      if(trial%10===0){await f.reopenObservers[0]();expect(await f.observers[0].successor(f.context.genesis)).toEqual(advances[0]);await expect(f.actors[0].verifier!.witness!.vote(createAdmissionWitnessRequest(partial,f.coordinators[0]))).rejects.toThrow();}
      current=policy;currentSet=newSet;completed++;campaignRecord({kind:'trial-complete',trial,revision:policy.revision,cycleAfterSealMs:performance.now()-drainStarted,history:destination.verifier!.historyHealth?.()??null,originalEvidenceChecks,certifiedBindingChecks,issuerCounterChecks,funding:funding.status()});
    }
    f.now(f.policy.keys[0].spendUntil);const final=f.actors[1];expect((await final.verifier!.verifyAndSpend(mainCapability,{action:'search',requestBinding:mainBinding,now:f.policy.keys[0].spendUntil})).status).toBe('replay');expect((await final.verifier!.verifyAndSpend(presentBlindAdmissionTokenV2(inflightToken,f.scope,'search',inflightBinding),{action:'search',requestBinding:inflightBinding,now:f.policy.keys[0].spendUntil})).status).toBe('rejected');expect(completed).toBe(100);expect(originalEvidenceChecks).toBe(200);expect(certifiedBindingChecks).toBe(50);expect(issuerCounterChecks).toBe(100);campaignRecord({kind:'campaign-complete',completed,target:100,originalEvidenceChecks,certifiedBindingChecks,issuerCounterChecks,funding:funding.status()});
  });}catch(error){campaignRecord({kind:'campaign-failed',completed,target:100,originalEvidenceChecks,certifiedBindingChecks,issuerCounterChecks,error:error instanceof Error?error.message:String(error),funding:funding.status()});throw error;}
},28800000);
