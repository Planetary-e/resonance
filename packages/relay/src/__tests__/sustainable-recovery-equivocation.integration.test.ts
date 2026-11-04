import {afterEach,expect,it} from 'vitest';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {generateSigningKeyPair,type SigningKeyPair} from '@resonance/core';
import {signAdmissionPolicy,admissionPolicyDigest,type SignedAdmissionPolicy} from '@resonance/core/admission-policy';
import {admissionPolicyHead,createAdmissionPolicyAdvance} from '@resonance/core/admission-policy-advance';
import {createAdmissionPolicyHeadRequest,parseAdmissionPolicyHeadCertificate} from '@resonance/core/admission-policy-freshness';
import {createAdmissionWitnessRequest,createAdmissionWitnessVote,admissionWitnessSetId,type AdmissionSpendClaim} from '@resonance/core/admission-witness';
import {createWitnessHandoffProposal,createWitnessHandoffActivation,witnessHandoffProposalId} from '@resonance/core/admission-witness-handoff';
import {historyCheckpointEnvelopeId} from '@resonance/core/history-checkpoint';
import {openSustainableRecoveryArena} from '../sustainable-recovery-arena.js';
import {createSustainableRecoveryReplica,generateRecoveryRecipientKey,openSustainableProtectedArena,recoveryDigest} from '../sustainable-recovery-protected-arena.js';
import {prepareSustainableRecoveryBootstrap,openSustainableRecoveryRuntime,recoveryNewViewProposal,verifyRecoveryCertificate,type SustainableRecoveryRuntime,type RecoveryBusinessCommand,type RecoveryCertificate} from '../sustainable-recovery-runtime.js';
import {preflightSustainableRecoveryManifest} from '../sustainable-recovery-manifest.js';
import {freezeProtectedWitness,prepareTerminalProtectedWitness} from '../protected-witness-handoff.js';
import {createPolicyObserverHistoryRoot,openProtectedPolicyObserver} from '../protected-policy-observer.js';
import {createHistoryCheckpointReplica} from '../history-checkpoint-exchange.js';
import {openHistoryCheckpointStore} from '../history-checkpoint-store.js';
import {sustainableLegacyFixture,declareSustainableOriginals} from './sustainable-recovery-fixture.js';
import {finiteRecoveryManifest} from './sustainable-recovery-fixture.js';
const cleanup:Array<()=>unknown|Promise<unknown>>=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const pub=(key:SigningKeyPair)=>Buffer.from(key.publicKey).toString('base64url');


// STOPPED: this historical RSO3 vertical is suspended with the rejected recovery design.
it.skip('same-view replay must not let honest protected members sign two values at one sequence',async()=>{
 const f=await sustainableLegacyFixture(4);await f.run(async()=>{
  const manifest=finiteRecoveryManifest(join(f.directory,'certified-arenas'));
  const preflight=preflightSustainableRecoveryManifest(f.funding,manifest,'new');expect(preflight.review.fits).toBe(true);
  const originals=f.actors.slice(0,4),cohort=f.actors.slice(4,8),accepted=f.row();await originals[0].history.write(accepted);
  const claim:AdmissionSpendClaim={setId:admissionWitnessSetId(f.proposal.oldSet),issuerKey:f.policy.activeKey,spend:randomBytes(32).toString('base64url'),action:'search',requestBinding:`admreq_${'p'.repeat(86)}`};
  const votes=originals.map(a=>createAdmissionWitnessVote(claim,a.key));
  for(let i=0;i<4;i++)await originals[i].history.writeRoleDecision({kind:'witness-vote',vote:votes[i]});
  for(const actor of originals)await freezeProtectedWitness(actor.history,f.proposal,actor.key,actor.encryptionKey);
  const pins=originals.map(a=>({context:a.context,genesisId:historyCheckpointEnvelopeId(a.root),rootId:historyCheckpointEnvelopeId(a.history.read().root),generation:0,nextGeneration:1,head:{...a.history.read().applied!}}));
  const pairs=[];for(const actor of originals)pairs.push(await prepareTerminalProtectedWitness(actor.history,f.proposal,{mode:'create-new',nextGeneration:1}));

  declareSustainableOriginals(manifest,pairs,f.policy,votes);
  const fresh=async()=>{throw new Error('This agreement-only regression must not call a policy authorization oracle');};
  const reopeners=new Map<SustainableRecoveryRuntime,()=>Promise<SustainableRecoveryRuntime>>();
  async function node(actor:(typeof f.actors)[number],index:number){
   const arena=openSustainableRecoveryArena({authority:f.funding,manifest,owner:`witness-${index}`,copy:0,key:actor.encryptionKey,mode:'new'});
   const storageKeys=Array.from({length:5},generateSigningKeyPair),replicaArenas=storageKeys.map((_,j)=>openSustainableRecoveryArena({authority:f.funding,manifest,owner:`witness-${index}`,copy:j+1,key:randomBytes(32),mode:'new'}));replicaArenas.forEach(a=>cleanup.push(a.close));
   const scope=recoveryDigest(Buffer.from(`actual-admission-witness:${pub(actor.key)}`)),replicas=storageKeys.map((key,j)=>createSustainableRecoveryReplica({arena:replicaArenas[j],scope,owner:pub(actor.key),signingKey:key})),recipientKey=await generateRecoveryRecipientKey();
   const storage=openSustainableProtectedArena({arena,scope,signingKey:actor.key,recipientKey,replicas:replicas.map(r=>r.replica),transport:async(key,request)=>replicas.find(r=>r.replica===key)!.exchange(request)});
   const runtime=openSustainableRecoveryRuntime({storage,key:actor.key,manifest,originalGenesis:f.policy,configuration:f.proposal.oldSet,freshPolicy:fresh});cleanup.push(runtime.close);
   reopeners.set(runtime,async()=>{runtime.close();const reopenedArena=openSustainableRecoveryArena({authority:f.funding,manifest,owner:`witness-${index}`,copy:0,key:actor.encryptionKey,mode:'existing'});
     const reopenedStorage=openSustainableProtectedArena({arena:reopenedArena,scope,signingKey:actor.key,recipientKey,replicas:replicas.map(r=>r.replica),transport:async(key,request)=>replicas.find(r=>r.replica===key)!.exchange(request)});
     const nextRuntime=openSustainableRecoveryRuntime({storage:reopenedStorage,key:actor.key,manifest,originalGenesis:f.policy,configuration:f.proposal.oldSet,freshPolicy:fresh});cleanup.push(nextRuntime.close);
     await expect(nextRuntime.startup()).rejects.toThrow('pending/prepared');return nextRuntime;});return runtime;
  }
  const oldNodes:SustainableRecoveryRuntime[]=[];for(let i=0;i<4;i++){const runtime=await node(originals[i],i);const cap=await prepareSustainableRecoveryBootstrap({manifest,proposal:f.proposal,originals:pairs,pins,genesis:f.policy});await runtime.bootstrap(cap);oldNodes.push(runtime);}

  // Bootstrap an actual executed stable cut using the production runtime phases.
  const initial=oldNodes[0].propose({kind:'cut'});
  const initialPrepared:RecoveryCertificate={phase:'prepare',header:initial.header,signatures:await Promise.all(oldNodes.map(n=>n.prepare(initial)))};
  const initialCommitted:RecoveryCertificate={phase:'commit',header:initial.header,signatures:await Promise.all(oldNodes.map(n=>n.commit(initialPrepared)))};
  const initialCut:RecoveryCertificate={phase:'cut',header:initial.header,signatures:await Promise.all(oldNodes.map(n=>n.execute(initialCommitted)))};
  await Promise.all(oldNodes.map(n=>n.finish(initialCut)));
  const cut=oldNodes[0].read().stable!,records=await Promise.all(oldNodes.map(n=>n.viewChange(1))),proposalId=recoveryNewViewProposal(records,cut);
  const transfers=await Promise.all(oldNodes.map(node=>oldNodes[0].transfer(proposalId,node.recipientEnrollment(cut))));
  expect(records.every(r=>!r.prepared||r.prepared.proposal.header.sequence<=cut.header.sequence)).toBe(true);
  try{await Promise.all(oldNodes.map((node,index)=>node.newView(records,transfers[index])));}catch(error){console.info(JSON.stringify({kind:'sustainable-newview-work',usage:oldNodes.map(node=>node.workUsage())}));throw error;}
  // Member 1 is the sole Byzantine leader for view 1. It creates two authentic
  // proposals before collecting prepares. Members 0,2,3 remain honest runtime
  // instances, with real encrypted/fsynced state and five opaque replicas each.
  const leader=oldNodes[1];
  const commandA:RecoveryBusinessCommand={kind:'vote',vote:createAdmissionWitnessVote({...claim,spend:randomBytes(32).toString('base64url')},originals[0].key)};
  const commandB:RecoveryBusinessCommand={kind:'vote',vote:createAdmissionWitnessVote({...claim,spend:randomBytes(32).toString('base64url')},originals[0].key)};
  const proposalA=leader.propose(commandA),proposalB=leader.propose(commandB);
  const preparedA:RecoveryCertificate={phase:'prepare',header:proposalA.header,signatures:await Promise.all(oldNodes.map(n=>n.prepare(proposalA)))};
  verifyRecoveryCertificate(preparedA,f.proposal.oldSet,'prepare');
  // The attacker replays the identical already accepted authenticated new-view
  // quorum. No invented signature, journal write, authority reset or new key.
  await Promise.all(oldNodes.map((node,index)=>node.newView(records,transfers[index])));
  const preparedB:RecoveryCertificate={phase:'prepare',header:proposalB.header,signatures:(await Promise.allSettled(oldNodes.map(n=>n.prepare(proposalB)))).flatMap(r=>r.status==='fulfilled'?[r.value]:[])};
  expect(()=>verifyRecoveryCertificate(preparedB,f.proposal.oldSet,'prepare')).toThrow('four');
  expect(oldNodes.map(n=>n.read().prepared?.proposal.header.command)).toEqual(oldNodes.map(()=>proposalA.header.command));
  expect(preparedA.header.view).toBe(preparedB.header.view);
  expect(preparedA.header.sequence).toBe(preparedB.header.sequence);
  expect(preparedA.header.command).not.toBe(preparedB.header.command);
  const byzantine=pub(originals[1].key),honestDoubleSigners=preparedA.signatures.map(s=>s.signer).filter(key=>key!==byzantine&&preparedB.signatures.some(s=>s.signer===key));
  console.info(JSON.stringify({kind:'same-view-runtime-equivocation',view:preparedA.header.view,sequence:preparedA.header.sequence,commandA:preparedA.header.command,commandB:preparedB.header.command,prepareQuorumA:preparedA.signatures.length,prepareQuorumB:preparedB.signatures.length,honestDoubleSigners:honestDoubleSigners.length}));
  expect(honestDoubleSigners,'An honest member must never sign PREPARE for different values at the same view/sequence').toEqual([]);
  await Promise.all(oldNodes.map(n=>n.commit(preparedA)));
  // A same-value retransmission cannot erase the certified prepared lock.
  await Promise.all(oldNodes.map(n=>n.prepare(proposalA)));
  expect(oldNodes.every(n=>n.read().prepared?.certificate?.phase==='prepare')).toBe(true);
  oldNodes[0]=await reopeners.get(oldNodes[0])!();
  await expect(oldNodes[0].prepare(proposalB)).rejects.toThrow('lock');
  const records2=await Promise.all(oldNodes.map(n=>n.viewChange(2))),proposalId2=recoveryNewViewProposal(records2,cut);
  const transfers2=await Promise.all(oldNodes.map(node=>oldNodes[0].transfer(proposalId2,node.recipientEnrollment(cut))));
  try{await Promise.all(oldNodes.map((node,index)=>node.newView(records2,transfers2[index])));}catch(error){console.info(JSON.stringify({kind:'sustainable-newview2-work',usage:oldNodes.map(node=>node.workUsage())}));throw error;}
  const carried=oldNodes[2].propose(commandA);
  const carriedCertificate:RecoveryCertificate={phase:'prepare',header:carried.header,signatures:await Promise.all(oldNodes.map(n=>n.prepare(carried)))};
  verifyRecoveryCertificate(carriedCertificate,f.proposal.oldSet,'prepare');
  expect(oldNodes.every(n=>n.read().locked?.certificate?.header.view===1)).toBe(true);
  const records3=await Promise.all(oldNodes.map(n=>n.viewChange(3))),proposalId3=recoveryNewViewProposal(records3,cut);
  const transfers3=await Promise.all(oldNodes.map(node=>oldNodes[0].transfer(proposalId3,node.recipientEnrollment(cut))));
  expect(records3.every(r=>r.prepared?.certificate?.header.view===1)).toBe(true);
  await Promise.all(oldNodes.map((node,index)=>node.newView(records3,transfers3[index])));
  const blocked=oldNodes[3].propose(commandB);
  await expect(oldNodes[0].prepare(blocked)).rejects.toThrow('lock');
  const carriedAgain=oldNodes[3].propose(commandA);
  const carriedAgainCertificate:RecoveryCertificate={phase:'prepare',header:carriedAgain.header,signatures:await Promise.all(oldNodes.map(n=>n.prepare(carriedAgain)))};
  verifyRecoveryCertificate(carriedAgainCertificate,f.proposal.oldSet,'prepare');
  await expect(oldNodes[0].newView(records,transfers[0])).rejects.toThrow('Stale');
 });
},60000);
