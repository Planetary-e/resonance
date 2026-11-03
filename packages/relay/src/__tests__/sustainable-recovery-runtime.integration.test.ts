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
import {prepareSustainableRecoveryBootstrap,openSustainableRecoveryRuntime,type SustainableRecoveryRuntime,type RecoveryBusinessCommand,type RecoveryCertificate} from '../sustainable-recovery-runtime.js';
import {preflightSustainableRecoveryManifest} from '../sustainable-recovery-manifest.js';
import {freezeProtectedWitness,prepareTerminalProtectedWitness} from '../protected-witness-handoff.js';
import {createPolicyObserverHistoryRoot,openProtectedPolicyObserver} from '../protected-policy-observer.js';
import {createHistoryCheckpointReplica} from '../history-checkpoint-exchange.js';
import {openHistoryCheckpointStore} from '../history-checkpoint-store.js';
import {sustainableLegacyFixture,declareSustainableOriginals} from './sustainable-recovery-fixture.js';
import {finiteRecoveryManifest} from './sustainable-recovery-fixture.js';
const cleanup:Array<()=>unknown|Promise<unknown>>=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const pub=(key:SigningKeyPair)=>Buffer.from(key.publicKey).toString('base64url');

// STOPPED: RSO3 is rejected at the unchanged physical C cap; do not rerun this vertical.
it.skip('sustainable recovery executes actual original business cut through two successors and returning owner',async()=>{
 const f=await sustainableLegacyFixture();await f.run(async()=>{
  const manifest=finiteRecoveryManifest(join(f.directory,'certified-arenas'));
  const preflight=preflightSustainableRecoveryManifest(f.funding,manifest,'new');expect(preflight.review.fits).toBe(true);
  const originals=f.actors.slice(0,4),cohort=f.actors.slice(4,8),accepted=f.row();await originals[0].history.write(accepted);
  const claim:AdmissionSpendClaim={setId:admissionWitnessSetId(f.proposal.oldSet),issuerKey:f.policy.activeKey,spend:randomBytes(32).toString('base64url'),action:'search',requestBinding:`admreq_${'p'.repeat(86)}`};
  const votes=originals.map(a=>createAdmissionWitnessVote(claim,a.key));
  const retainedVotes=votes.map((vote,i)=>i===3?createAdmissionWitnessVote({...claim,requestBinding:`admreq_${'q'.repeat(86)}`},originals[i].key):vote);
  for(let i=0;i<4;i++)await originals[i].history.writeRoleDecision({kind:'witness-vote',vote:retainedVotes[i]});
  for(const actor of originals)await freezeProtectedWitness(actor.history,f.proposal,actor.key,actor.encryptionKey);
  const pins=originals.map(a=>({context:a.context,genesisId:historyCheckpointEnvelopeId(a.root),rootId:historyCheckpointEnvelopeId(a.history.read().root),generation:0,nextGeneration:1,head:{...a.history.read().applied!}}));
  const pairs=[];for(const actor of originals)pairs.push(await prepareTerminalProtectedWitness(actor.history,f.proposal,{mode:'create-new',nextGeneration:1}));
  declareSustainableOriginals(manifest,pairs,f.policy,retainedVotes);
  const observers:Array<Awaited<ReturnType<typeof openProtectedPolicyObserver>>>=[];let currentHead=f.observerContext.genesis;
  for(let i=0;i<4;i++){
   const encryptionKey=randomBytes(32),enrolled=await createPolicyObserverHistoryRoot({context:f.observerContext,signingKey:f.observerKeys[i],encryptionKey,policy:f.policy,writerStateBytes:3*4*1024**2+65536});
   const stores=enrolled.context.members.map((replica,j)=>openHistoryCheckpointStore({directory:join(f.directory,`compact-observer-${i}-replica-${j}`),context:enrolled.context,replica,localKey:randomBytes(32),rootId:historyCheckpointEnvelopeId(enrolled.root),generation:0,initialize:enrolled.root,maxBytes:6*1024**2}));stores.forEach(s=>cleanup.push(s.close));
   const roles=stores.map((store,j)=>createHistoryCheckpointReplica({context:enrolled.context,store,signingKey:f.observerKeys.find(k=>pub(k)===enrolled.context.members[j])!}));roles.forEach(r=>cleanup.push(r.close));
   const observer=await openProtectedPolicyObserver({directory:join(f.directory,`compact-observer-${i}`),encryptionKey,context:f.observerContext,signingKey:f.observerKeys[i],historyContext:enrolled.context,root:enrolled.root,members:enrolled.context.members.map((publicKey,j)=>({publicKey,endpoint:`ws://127.0.0.1:${49000+j}/`})),transport:async(member,frame)=>roles[enrolled.context.members.indexOf(member.publicKey)].exchange(frame),mode:'create-new',maxArchiveBytes:4*1024**2});cleanup.push(observer.close);await observer.ready();observers.push(observer);
  }
  const fresh=async(policy:SignedAdmissionPolicy,deadline:number)=>{const request=createAdmissionPolicyHeadRequest(f.observerContext,Date.now(),3000);const cert=parseAdmissionPolicyHeadCertificate({version:1,kind:'admission-policy-head-certificate',votes:await Promise.all(observers.map(o=>o.observe(request)))},request,f.observerContext,currentHead,Date.now());expect(cert.votes[0].head.digest).toBe(admissionPolicyDigest(policy));if(performance.now()>deadline)throw new Error('Live policy deadline exceeded');};
  const reopeners=new Map<SustainableRecoveryRuntime,()=>Promise<SustainableRecoveryRuntime>>();
  async function node(actor:(typeof f.actors)[number],index:number){
   const arena=openSustainableRecoveryArena({authority:f.funding,manifest,owner:`witness-${index}`,copy:0,key:actor.encryptionKey,mode:'new'});
   const storageKeys=Array.from({length:5},generateSigningKeyPair),replicaArenas=storageKeys.map((_,j)=>openSustainableRecoveryArena({authority:f.funding,manifest,owner:`witness-${index}`,copy:j+1,key:randomBytes(32),mode:'new'}));replicaArenas.forEach(a=>cleanup.push(a.close));
   const scope=recoveryDigest(Buffer.from(`actual-admission-witness:${pub(actor.key)}`)),replicas=storageKeys.map((key,j)=>createSustainableRecoveryReplica({arena:replicaArenas[j],scope,owner:pub(actor.key),signingKey:key})),recipientKey=await generateRecoveryRecipientKey();
   const storage=openSustainableProtectedArena({arena,scope,signingKey:actor.key,recipientKey,replicas:replicas.map(r=>r.replica),transport:async(key,request)=>replicas.find(r=>r.replica===key)!.exchange(request)});
   const runtime=openSustainableRecoveryRuntime({storage,key:actor.key,manifest,originalGenesis:f.policy,configuration:f.proposal.oldSet,freshPolicy:fresh});cleanup.push(runtime.close);
   reopeners.set(runtime,async()=>{runtime.close();const reopenedArena=openSustainableRecoveryArena({authority:f.funding,manifest,owner:`witness-${index}`,copy:0,key:actor.encryptionKey,mode:'existing'});
     const reopenedStorage=openSustainableProtectedArena({arena:reopenedArena,scope,signingKey:actor.key,recipientKey,replicas:replicas.map(r=>r.replica),transport:async(key,request)=>replicas.find(r=>r.replica===key)!.exchange(request)});
     const reopened=openSustainableRecoveryRuntime({storage:reopenedStorage,key:actor.key,manifest,originalGenesis:f.policy,configuration:f.proposal.oldSet,freshPolicy:fresh});cleanup.push(reopened.close);await reopened.startup();return reopened;});return runtime;
  }
  const operationWorks:Array<{label:string;usage:unknown[]}>=[],record=(nodes:SustainableRecoveryRuntime[],label:string)=>operationWorks.push({label,usage:nodes.map(node=>node.workUsage())});
  const oldNodes:SustainableRecoveryRuntime[]=[],preparationWork:unknown[]=[];for(let i=0;i<4;i++){const runtime=await node(originals[i],i);const cap=await prepareSustainableRecoveryBootstrap({manifest,proposal:f.proposal,originals:pairs,pins,genesis:f.policy,onWorkComplete:usage=>preparationWork.push(usage)});try{await runtime.bootstrap(cap);}catch(error){console.info(JSON.stringify({kind:'sustainable-bootstrap-work',usage:runtime.workUsage()}));throw error;}oldNodes.push(runtime);}
  record(oldNodes,'bootstrap');console.info(JSON.stringify({kind:'sustainable-bootstrap-work-complete',candidateMaximumBytes:4718592,preparationWork,usage:oldNodes.map(node=>node.workUsage())}));
  const newNodes:SustainableRecoveryRuntime[]=[];for(let i=0;i<4;i++)newNodes.push(await node(cohort[i],i+5));
  const funded=f.funding.status();f.funding.reserve({path:join(f.directory,'all-remaining-byte-allowance'),component:'finite-test-exhaustion',scope:'file',maximumBytes:funded.availableBytes});expect(f.funding.status().availableBytes).toBe(0);
  async function execute(nodes:SustainableRecoveryRuntime[],command:RecoveryBusinessCommand){const members=nodes[0].read().configuration.members;const leader=nodes.find(n=>n.read().configuration.members[n.read().view%5].publicKey===n.read().state.evidence.sets.flatMap(s=>s.members).find(m=>m.publicKey===members[n.read().view%5].publicKey)?.publicKey&&pub((nodes===oldNodes?originals:cohort)[nodes.indexOf(n)].key)===members[n.read().view%5].publicKey);
   // The unavailable fifth member is never elected for this frozen view.
   if(!leader)throw new Error('Frozen fixture lacks deterministic leader');const proposal=leader.propose(command);record(nodes,`${command.kind}:propose`);const prepares=await Promise.all(nodes.map(n=>n.prepare(proposal)));record(nodes,`${command.kind}:prepare`);
   const prepared:RecoveryCertificate={phase:'prepare',header:proposal.header,signatures:prepares},commits=await Promise.all(nodes.map(n=>n.commit(prepared)));record(nodes,`${command.kind}:commit`);const committed:RecoveryCertificate={phase:'commit',header:proposal.header,signatures:commits};
   const done=await Promise.all(nodes.map(n=>n.execute(committed)));record(nodes,`${command.kind}:execute`);const cut=command.kind==='cut'?{phase:'cut' as const,header:proposal.header,signatures:done}:undefined;await Promise.all(nodes.map(n=>n.finish(cut)));record(nodes,`${command.kind}:finish`);return cut;
  }
  await execute(oldNodes,{kind:'cut'});for(const node of oldNodes)await node.startup();record(oldNodes,'startup');
  const request=createAdmissionWitnessRequest({...claim,spend:accepted.spend,action:'search',requestBinding:accepted.binding},f.coordinator);
  expect(await oldNodes[0].retry(request)).toMatchObject({owner:pub(originals[0].key),...accepted});record(oldNodes,'retry');
  await execute(oldNodes,{kind:'reconfigure',proposal:f.proposal});await execute(oldNodes,{kind:'cut'});
  async function transfer(from:SustainableRecoveryRuntime[],to:SustainableRecoveryRuntime[],proposal:typeof f.proposal,current:SignedAdmissionPolicy,revision:number){
   const cut=from[0].read().stable!,snapshots=await Promise.all(to.map(node=>from[0].transfer(proposal,node.recipientEnrollment(cut)))),snapshot=snapshots[0];record(from,'transfer');await expect(from[0].freeze([])).rejects.toThrow('reservations');expect(from[0].read().fenced).toBe(false);
   const reservations=await Promise.all(to.map((node,index)=>node.reserveInstall(snapshots[index],proposal)));record(to,'reserveInstall');const freezes=await Promise.all(from.map(n=>n.freeze(reservations)));record(from,'freeze');const cutId=recoveryDigest((await import('../sustainable-recovery-runtime.js')).recoveryHeaderBytes(snapshot.cut.header));
   const seal={version:1 as const,proposal,manifest:cutId,freezes,activation:null};const started=performance.now(),drained=await Promise.all(observers.map(o=>o.drainWitnessHandoff(seal)));expect(performance.now()-started).toBeGreaterThanOrEqual(3000);
   const ready=await Promise.all(to.map((node,index)=>node.prepareInstall(snapshots[index],proposal,drained)));record(to,'prepareInstall');const activation=createWitnessHandoffActivation({proposal,manifest:cutId,freezes,drained,ready},f.authorityKey);
   const {authority,signature,...body}=current;const policy=await signAdmissionPolicy({...body,revision,keys:body.keys.map(k=>({...k,witnesses:proposal.newSet,witnessHandoff:activation}))},authority,f.authorityKey.secretKey);
   const advance=await createAdmissionPolicyAdvance(current,policy,f.observerContext,f.authorityKey,proposal.previous);await Promise.all(observers.map(o=>o.advance(advance)));currentHead=advance.commitment.next;
   const terminalLeader=to.find((node,index)=>node.read().configuration.members[node.read().view%5].publicKey===pub((to===oldNodes?originals:cohort)[index].key))!;
   expect(()=>terminalLeader.propose({kind:'cut'})).toThrow('Terminal installation reservation');
   await expect(to[0].viewChange(1)).rejects.toThrow('Terminal installation reservation');
   await Promise.all(to.map((node,index)=>node.install(snapshots[index],activation,policy)));record(to,'install');for(const node of to)await node.startup();record(to,'install-startup');return {policy,advance};
  }
  const first=await transfer(oldNodes,newNodes,f.proposal,f.policy,2);
  const retryNew=createAdmissionWitnessRequest({...request,setId:admissionWitnessSetId(f.proposal.newSet)},f.coordinator);expect(await newNodes[0].retry(retryNew)).toEqual(oldNodes[0].read().state.evidence.accepted[0]);record(newNodes,'retry-successor');
  const unresolved=createAdmissionWitnessRequest({...claim,setId:admissionWitnessSetId(f.proposal.newSet)},f.coordinator);
  await expect(newNodes[0].retry(unresolved)).rejects.toThrow('uncertainty');
  await execute(newNodes,{kind:'certificate',certificate:{version:1,votes}});
  expect(await newNodes[0].retry(unresolved)).toBeUndefined();
  const returning=createWitnessHandoffProposal({...f.proposal,id:randomBytes(32).toString('base64url'),previous:first.advance.commitment.next,oldSet:f.proposal.newSet,newSet:{...f.proposal.oldSet,epoch:randomBytes(32).toString('base64url')}},f.authorityKey);
  await execute(newNodes,{kind:'reconfigure',proposal:returning});await execute(newNodes,{kind:'cut'});await transfer(newNodes,oldNodes,returning,first.policy,3);
  oldNodes[0]=await reopeners.get(oldNodes[0])!();
  const retryReturned=createAdmissionWitnessRequest({...request,setId:admissionWitnessSetId(returning.newSet)},f.coordinator);expect(await oldNodes[0].retry(retryReturned)).toMatchObject({owner:pub(originals[0].key),...accepted});record(oldNodes,'retry-returned');
  console.info(JSON.stringify({kind:'sustainable-operation-work',candidateMaximumBytes:4718592,operationWorks}));
  await expect(oldNodes[0].retry(createAdmissionWitnessRequest({...claim,setId:admissionWitnessSetId(returning.newSet),requestBinding:`admreq_${'q'.repeat(86)}`},f.coordinator))).rejects.toThrow('Retained denial');
  expect(f.funding.status().availableBytes).toBe(0);
  await expect(oldNodes[0].retry(createAdmissionWitnessRequest({...retryReturned,requestBinding:`admreq_${'z'.repeat(86)}`},f.coordinator))).rejects.toThrow('Conflicting');
 });
},120000);
