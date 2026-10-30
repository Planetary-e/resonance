/** Explicit experimental executed-state path. Membership signs business state;
 * the protected arena independently supplies four opaque durable copies. */
import { sign, verify, type SigningKeyPair } from '@resonance/core';
import { verifyAdmissionPolicy, admissionPolicyDigest, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionWitnessSetId, verifyAdmissionWitnessRequest, verifyAdmissionWitnessVote, verifyAdmissionSpendCertificate,
  type AdmissionWitnessSet, type AdmissionWitnessRequest, type AdmissionWitnessVote, type AdmissionSpendCertificate } from '@resonance/core/admission-witness';
import { parseWitnessHandoffActivation, parseWitnessHandoffProposal, witnessHandoffProposalId, createWitnessFreezeReport, createWitnessReadyReport, parseWitnessDrainCertificate, type WitnessDrainReport, type WitnessHandoffActivation } from '@resonance/core/admission-witness-handoff';
import { mergeWitnessEvidence, witnessConstraint, type WitnessInheritedEvidence } from './witness-handoff-state.js';
import { recoveryDigest, type PreparedOpaqueProof, type RecoveryProofTransferObject, type SustainableProtectedArena } from './sustainable-recovery-protected-arena.js';
import { assertValidatedRecoveryOriginalProvenance, verifyRecoveryRecipientEnrollment, type RecoveryRecipientEnrollment } from './sustainable-recovery-opaque.js';
import { prepareProtectedWitnessTransfer, type WitnessTerminalEvidence, type WitnessTerminalPins } from './protected-witness-handoff.js';
import type { WitnessHandoffProposal } from '@resonance/core/admission-witness-handoff';
import { admissionKeyFingerprint } from '@resonance/core/admission-policy';
import { compileSustainableRecoveryManifest, SUSTAINABLE_RECOVERY_LIMITS, type RecoveryAllocationManifest, type RecoveryProofKind } from './sustainable-recovery-manifest.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryBytes, sustainableRecoveryConcat, sustainableRecoveryJson, sustainableRecoveryParse, sustainableRecoveryWorkUsage, withSustainableRecoveryWork, type RecoveryWorkUsage } from './sustainable-recovery-work.js';
import { cloneRecoveryBusinessState, decodeRecoveryCertificate, decodeRecoveryCommand, decodeRecoveryJournal, encodeRecoveryBusinessState, encodeRecoveryCertificate, encodeRecoveryCommand, encodeRecoveryJournal, recoveryBusinessStateDigest } from './sustainable-recovery-codec.js';

const ZERO=`sha256:${'0'.repeat(64)}`;
const json=(v:unknown)=>sustainableRecoveryJson(v);
const pub=(k:SigningKeyPair)=>Buffer.from(k.publicKey).toString('base64url');
function canonical(value:unknown):unknown {if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>Buffer.compare(sustainableRecoveryBytes(a),sustainableRecoveryBytes(b))).map(([k,v])=>[k,canonical(v)]));return value;}
const digest=(v:unknown)=>recoveryDigest(json(canonical(v)));
export interface RecoveryBusinessState { evidence:WitnessInheritedEvidence; policy:SignedAdmissionPolicy; proofs:string[]; originalGenesis:string; context:string; voteProofs?:string[]; certificateProofs?:string[]; transition?:WitnessHandoffProposal }
export type RecoveryBusinessCommand = {kind:'cut'} | {kind:'certificate';certificate:AdmissionSpendCertificate}
  | {kind:'vote';vote:AdmissionWitnessVote} | {kind:'accept';request:AdmissionWitnessRequest;certificate:AdmissionSpendCertificate}
  | {kind:'reconfigure';proposal:WitnessHandoffProposal};
export interface RecoveryHeader { version:1; configuration:string; view:number; sequence:number; previous:string; command:string;
  state:string; proofRoot:string; policy:string; previousCut:string; terminal:string; funding:string; genesis:string; context:string }
export interface RecoverySignature { signer:string; signature:string }
export interface RecoveryCertificate { phase:'prepare'|'commit'|'cut';header:RecoveryHeader;signatures:RecoverySignature[] }
export interface RecoveryProposal { header:RecoveryHeader; leader:string; signature:string; command:RecoveryBusinessCommand }
interface Prepared { proposal:RecoveryProposal; certificate:RecoveryCertificate|null }
interface Journal { version:1;layout:string;state:RecoveryBusinessState;configuration:AdmissionWitnessSet;view:number;sequence:number;head:string;
  prepared:Prepared|null;committed:RecoveryCertificate|null;stable:RecoveryCertificate|null;suffix:number;fenced:boolean;locked?:Prepared;lastViewChange?:RecoveryViewChange;stage?:'reserved'|'ready';installPolicyShape?:string;installedNewView?:{view:number;identity:string} }
export type RecoveryJournal = Journal;
export interface RecoveryTransfer { cut:RecoveryCertificate;state:RecoveryBusinessState;proposal:string;recipientEnrollment:RecoveryRecipientEnrollment;objects:RecoveryProofTransferObject[] }
export interface RecoveryFundingReceipt {version:1;cut:string;proposal:string;layout:string;signer:string;signature:string}
export interface RecoveryViewChange { view:number;signer:string;base:RecoveryCertificate;floor:{configuration:string;sequence:number;digest:string};prepared:Prepared|null;signature:string }
export function recoveryNewViewProposal(records:RecoveryViewChange[],cut:RecoveryCertificate){return digest({kind:'new-view-recovery-v3',records:[...records].sort((a,b)=>a.signer.localeCompare(b.signer)),cut});}

/** Versioned fixed binary header. Digests are 32 bytes and integers u64. */
export function recoveryHeaderBytes(header:RecoveryHeader) {return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work,()=>{
  if(header.version!==1 || ![header.view,header.sequence].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('Invalid recovery header sequence/view');
  const names=['configuration','previous','command','state','proofRoot','policy','previousCut','terminal','funding','genesis','context'] as const;
  const bytes=Buffer.alloc(1024);chargeSustainableRecoveryWork(bytes.length,'D','allocate');bytes.write('RSCUT001');bytes.writeBigUInt64BE(BigInt(header.view),8);bytes.writeBigUInt64BE(BigInt(header.sequence),16);
  names.forEach((name,index)=>{if(!/^sha256:[a-f0-9]{64}$/.test(header[name]))throw new Error('Invalid recovery header digest');sustainableRecoveryBytes(header[name].slice(7),'hex').copy(bytes,24+index*32);});return bytes;
});}
const headerId=(header:RecoveryHeader)=>recoveryDigest(recoveryHeaderBytes(header));
const signedBytes=(phase:string,header:RecoveryHeader)=>sustainableRecoveryConcat([sustainableRecoveryBytes(`resonance:executed-recovery:${phase}:v1\n`),recoveryHeaderBytes(header)]);
function signHeader(phase:string,header:RecoveryHeader,key:SigningKeyPair):RecoverySignature {return {signer:pub(key),signature:sustainableRecoveryBytes(sign(signedBytes(phase,header),key.secretKey)).toString('base64url')};}
export function verifyRecoveryCertificate(certificate:RecoveryCertificate,set:AdmissionWitnessSet,phase=certificate?.phase) {return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work,()=>{
  if(!certificate||certificate.phase!==phase||!['prepare','commit','cut'].includes(phase)||certificate.header.configuration!==admissionWitnessSetId(set)
    || !Array.isArray(certificate.signatures)||certificate.signatures.length!==4||new Set(certificate.signatures.map(s=>s.signer)).size!==4)throw new Error('Recovery requires four identical executed-state signatures');
  for(const signature of certificate.signatures)if(!set.members.some(m=>m.publicKey===signature.signer)
    || !verify(signedBytes(phase,certificate.header),sustainableRecoveryBytes(signature.signature,'base64url'),sustainableRecoveryBytes(signature.signer,'base64url')))throw new Error('Unauthenticated executed-state certificate');
  return certificate;
});}
function installPolicyShape(policy:SignedAdmissionPolicy,proposal:WitnessHandoffProposal){
  const {revision,signature,...body}=policy;
  return digest({...body,keys:body.keys.map(k=>admissionKeyFingerprint(k.profile.issuerPublicKey)===proposal.issuerKey?{...k,witnesses:proposal.newSet,witnessHandoff:null}:k)});
}
/** All future signatures/digests are fixed-length encodings. Bound the complete
 * activation and next policy from the authenticated finite policy/proposal,
 * before the first freeze. Unknown policy changes need a new reservation. */
function installationMaximum(policy:SignedAdmissionPolicy,proposal:WitnessHandoffProposal){
  const signature='x'.repeat(86),base={version:1,proposal:ZERO};
  const activation={version:1,kind:'witness-handoff-activation',proposal,manifest:ZERO,
    freezes:proposal.oldSet.members.slice(0,4).map(m=>({...base,kind:'witness-freeze',witness:m.publicKey,evidence:ZERO,head:ZERO,signature})),
    drained:proposal.context.members.slice(0,4).map(m=>({...base,kind:'witness-drained',manifest:ZERO,observer:m.publicKey,signature})),
    ready:proposal.newSet.members.slice(0,4).map(m=>({...base,kind:'witness-ready',manifest:ZERO,drain:ZERO,witness:m.publicKey,signature})),authority:proposal.authority,signature};
  const next={...policy,revision:Number.MAX_SAFE_INTEGER,signature,keys:policy.keys.map(k=>admissionKeyFingerprint(k.profile.issuerPublicKey)===proposal.issuerKey?{...k,witnesses:proposal.newSet,witnessHandoff:activation}:k)};
  return {policy:json(next).length,activation:json(activation).length};
}
export function assertSustainableRetryKey(policy:SignedAdmissionPolicy,request:Pick<AdmissionWitnessRequest,'issuerKey'|'setId'>,now:number){
  const entry=policy.keys.find(k=>admissionKeyFingerprint(k.profile.issuerPublicKey)===request.issuerKey&&k.witnesses&&admissionWitnessSetId(k.witnesses)===request.setId);
  if(!entry||now<entry.notBefore||now>=entry.retryUntil)throw new Error('Current admission retry key is retired');return entry;
}
const bootstrapCapabilities=new WeakMap<object,RecoveryBusinessState>();
/** The original reducer, signatures, independent pins and terminal barrier are
 * fully checked here; untrusted accepted-owner strings never mint a bootstrap. */
export async function prepareSustainableRecoveryBootstrap(options:{manifest:RecoveryAllocationManifest;proposal:WitnessHandoffProposal;
  originals:WitnessTerminalEvidence[];pins:WitnessTerminalPins[];genesis:SignedAdmissionPolicy;signal?:AbortSignal;onWorkComplete?:(usage:RecoveryWorkUsage)=>void}) {
  const compiled=compileSustainableRecoveryManifest(options.manifest);
  return withSustainableRecoveryWork(compiled.maximumWork,async()=>{
    const genesis=await verifyAdmissionPolicy(options.genesis,options.proposal.authority);
    const manifest=await prepareProtectedWitnessTransfer(options.proposal,options.originals,options.signal,options.pins,{
      charge:bytes=>chargeSustainableRecoveryWork(bytes,'J','legacy'),usedBytes:()=>sustainableRecoveryWorkUsage()?.usedBytes??0,
    });
    const expected=genesis.keys.find(k=>k.witnesses&&admissionWitnessSetId(k.witnesses)===admissionWitnessSetId(options.proposal.oldSet));
    if(!expected)throw new Error('Bootstrap original genesis/configuration differs');
    const objects=new Map<string,Buffer>();
    // Store exact legacy object bytes once; the archive does not store another
    // recursive transfer bundle or replace the original signature domain.
    for(const pair of options.originals)for(const object of pair.evidence.blocks){const bytes=sustainableRecoveryJson(object,'J');objects.set(recoveryDigest(bytes),bytes);}
    const policyBytes=sustainableRecoveryJson(genesis,'J');objects.set(recoveryDigest(policyBytes),policyBytes);
    const state:RecoveryBusinessState={evidence:manifest.inherited,policy:genesis,proofs:[...objects.keys()].sort(),
      originalGenesis:`sha256:${admissionPolicyDigest(genesis)}`,context:digest(options.pins.map(pin=>({context:pin.context,genesisId:pin.genesisId})))};
    const capability={objects:[...objects].map(([id,bytes])=>{const text=bytes.toString('base64url');chargeSustainableRecoveryWork(Buffer.byteLength(text),'J','base64');return {id,bytes:text};})};bootstrapCapabilities.set(capability,cloneRecoveryBusinessState(state));return capability;
  },options.onWorkComplete);
}

export function openSustainableRecoveryRuntime(options:{storage:SustainableProtectedArena;key:SigningKeyPair;manifest:RecoveryAllocationManifest;
  originalGenesis:SignedAdmissionPolicy;configuration:AdmissionWitnessSet;
  /** This is the existing authenticated fresh-policy service, bound to the exact
   * selected installed policy. It cannot establish a latest spend endpoint. */
  freshPolicy:(policy:SignedAdmissionPolicy,deadline:number)=>Promise<void>;now?:()=>number}) {
  const compiled=compileSustainableRecoveryManifest(options.manifest),now=options.now??Date.now,signer=pub(options.key);
  let lastWork:RecoveryWorkUsage|undefined;
  const meter=<T>(work:()=>T)=>withSustainableRecoveryWork(compiled.maximumWork,work,usage=>{lastWork=usage;});
  if(options.storage.owner!==signer || options.storage.arena.layout!==compiled.digest)throw new Error('Recovery owner/funding/layout differs');
  let closed=false,serving=false,busy=false;
  function live(){if(closed)throw new Error('Executed recovery closed');}
  function read():Journal {live();const bytes=options.storage.read();if(!bytes)throw new Error('Executed recovery requires authenticated bootstrap/install');
    const journal=decodeRecoveryJournal(bytes,id=>options.storage.arena.get(id));
    if(journal.version!==1||journal.layout!==compiled.digest||journal.state.originalGenesis!==`sha256:${admissionPolicyDigest(options.originalGenesis)}`
      ||!Number.isSafeInteger(journal.sequence)||journal.sequence<0||journal.suffix>32)throw new Error('Wrong recovery original trust/funding/floor');
    options.storage.configureOriginal({genesis:journal.state.originalGenesis,configuration:admissionWitnessSetId(journal.configuration),context:journal.state.context});return journal;}
  const knownSet=(state:RecoveryBusinessState,id:string)=>state.evidence.sets.find(set=>admissionWitnessSetId(set)===id);
  async function validateTransferObjects(transfer:RecoveryTransfer,proposal:string,oldSet:AdmissionWitnessSet,newSet:AdmissionWitnessSet) {
    if(transfer.proposal!==proposal||!newSet.members.some(member=>member.publicKey===signer))throw new Error('Unauthorized transfer exporter/recipient');
    const enrollment=verifyRecoveryRecipientEnrollment(transfer.recipientEnrollment,{owner:signer,role:'witness',genesis:transfer.cut.header.genesis,context:transfer.cut.header.context});
    if(transfer.objects.length!==transfer.state.proofs.length||new Set(transfer.objects.map(object=>object.id)).size!==transfer.objects.length
      ||transfer.objects.some(object=>!transfer.state.proofs.includes(object.id)))throw new Error('Transfer proof coverage differs');
    const items:Array<{bytes:Buffer;kind:RecoveryProofKind;pair:RecoveryProofTransferObject['pair'];prepared:PreparedOpaqueProof}>=[];let currentExporter:string|undefined;
    try {
      for(const object of transfer.objects){
        const {bytes,prepared}=await options.storage.prepareTransfer(object,proposal,object.pair.capsule.exporter);
        try {
          const validation=prepared.validation!,frame=validation.view.frameMetadata,capsule=validation.view.capsule;
          if(capsule.recipient!==signer||capsule.wrappingKeyId!==enrollment.keyId||!oldSet.members.some(member=>member.publicKey===capsule.exporter)||currentExporter&&currentExporter!==capsule.exporter)throw new Error('Unauthorized or mixed current exporter');
          currentExporter=capsule.exporter;
          const originalSet=knownSet(transfer.state,frame.originalConfiguration);if(!originalSet)throw new Error('Wrong original signer/scope/configuration');
          assertValidatedRecoveryOriginalProvenance(validation.view,validation.operation,{genesis:transfer.cut.header.genesis,configuration:frame.originalConfiguration,context:transfer.cut.header.context,
            proofId:object.id,kind:object.kind,signers:originalSet.members.map(member=>member.publicKey)});
          if(object.bytes!==bytes.toString('base64url'))throw new Error('Noncanonical transferred plaintext encoding');
          items.push({bytes,kind:object.kind,pair:object.pair,prepared});
        } catch(error){options.storage.discardPrepared(prepared);throw error;}
      }
      return items;
    } catch(error){for(const item of items)options.storage.discardPrepared(item.prepared);throw error;}
  }
  async function write(journal:Journal){await options.storage.write(encodeRecoveryJournal(journal));}
  async function proof(bytes:Buffer,kind:RecoveryProofKind='original',prepared?:PreparedOpaqueProof){return options.storage.put(bytes,kind,prepared);}
  function materializedEvidence(state:RecoveryBusinessState):WitnessInheritedEvidence {
    const command=(id:string):RecoveryBusinessCommand=>{const bytes=options.storage.arena.get(id),magic=bytes.toString('ascii',4,8);if(magic==='RCM1')return decodeRecoveryCommand(bytes);if(magic==='RCC1')throw new Error('Protocol frame is not an original business command');return sustainableRecoveryParse(bytes) as RecoveryBusinessCommand;};
    const votes=(state.voteProofs??[]).map(id=>{const value=command(id);if(value.kind!=='vote')throw new Error('Recovery vote proof kind differs');return value.vote;});
    const certificates=(state.certificateProofs??[]).map(id=>{const value=command(id);if(value.kind!=='certificate'&&value.kind!=='accept')throw new Error('Recovery certificate proof kind differs');return value.certificate;});
    return mergeWitnessEvidence([state.evidence,{sets:[],activations:[],votes,certificates,accepted:[],denials:[]}]);
  }
  function nextState(journal:Journal,command:RecoveryBusinessCommand):RecoveryBusinessState {
    const state=cloneRecoveryBusinessState(journal.state),evidence=materializedEvidence(state);
    if(command.kind==='cut')return state;
    if(state.transition)throw new Error('Ordered reconfiguration admits only its terminal cut');
    if(command.kind==='reconfigure') {
      const proposal=parseWitnessHandoffProposal(command.proposal);
      if(admissionWitnessSetId(proposal.oldSet)!==admissionWitnessSetId(journal.configuration)||proposal.authority!==options.originalGenesis.authority)throw new Error('Ordered reconfiguration changed original authority/configuration');
      state.transition=proposal;state.proofs=[...new Set([...state.proofs,recoveryDigest(encodeRecoveryCommand(command))])].sort();return state;
    }
    if(command.kind==='vote'){
      const set=knownSet(state,command.vote?.setId);if(!set||!verifyAdmissionWitnessVote(command.vote,command.vote,set))throw new Error('Invalid original admission vote');
      state.evidence=mergeWitnessEvidence([evidence,{...evidence,sets:[],activations:[],votes:[command.vote],certificates:[],accepted:[],denials:[]}]);
    }else if(command.kind==='certificate'||command.kind==='accept') {
      const claim=command.certificate?.votes?.[0],set=knownSet(state,claim?.setId);
      if(!set||!verifyAdmissionSpendCertificate(command.certificate,claim,set))throw new Error('Invalid original admission certificate');
      if(command.kind==='accept') {
        const request=command.request,current=journal.configuration;
        if(!verifyAdmissionWitnessRequest(request,current)||request.issuerKey!==claim.issuerKey||request.spend!==claim.spend||request.action!==claim.action||request.requestBinding!==claim.requestBinding)throw new Error('Unauthenticated original business acceptance');
        const constraint=witnessConstraint(evidence,request,command.certificate);
        if(constraint==='conflict'||constraint==='denied'||constraint==='split')throw new Error('Retained admission conflict/denial/uncertainty');
        const prior=evidence.accepted.filter(row=>row.issuerKey===request.issuerKey&&row.spend===request.spend);
        if(prior.some(row=>row.action!==request.action||row.binding!==request.requestBinding))throw new Error('Conflicting original acceptance');
        if(!prior.length)evidence.accepted.push({owner:request.coordinator,issuerKey:request.issuerKey,spend:request.spend,action:request.action,binding:request.requestBinding});
      }
      state.evidence=mergeWitnessEvidence([evidence,{...evidence,sets:[],activations:[],votes:[],certificates:[command.certificate],accepted:[],denials:[]}]);
      if(witnessConstraint(state.evidence,claim)==='conflict')throw new Error('Incompatible certified admission outcomes');
    }else throw new Error('Unknown executed business command');
    const id=recoveryDigest(encodeRecoveryCommand(command));state.proofs=[...new Set([...state.proofs,id])].sort();
    if(command.kind==='vote')state.voteProofs=[...new Set([...(state.voteProofs??[]),id])].sort();
    if(command.kind==='certificate'||command.kind==='accept')state.certificateProofs=[...new Set([...(state.certificateProofs??[]),id])].sort();
    // Complete original bundles live only in charged C objects. The persisted
    // live table holds bounded direct references, never a full certificate row.
    state.evidence={...state.evidence,votes:[],certificates:[]};
    for(const row of [...state.evidence.accepted,...(state.voteProofs??[]).map(ref=>({kind:'original-vote-bundle',ref})),...(state.certificateProofs??[]).map(ref=>({kind:'original-certificate-bundle',ref}))])if(json(row).length>2048)throw new Error('SemanticRow header maximum exceeded; complete proof bundle required');
    return state;
  }
  function expected(journal:Journal,command:RecoveryBusinessCommand):RecoveryHeader {
    if(journal.stage)throw new Error('Terminal installation reservation forbids new commands');
    if(journal.suffix>=32)throw new Error('32-slot funded suffix exhausted');
    if(journal.suffix>=24&&command.kind!=='cut')throw new Error('Executed recovery checkpoint required at 24 slots');
    if(journal.fenced)throw new Error('Terminal executed recovery is fenced');
    const state=nextState(journal,command);
    return {version:1,configuration:admissionWitnessSetId(journal.configuration),view:journal.view,sequence:journal.sequence+1,previous:journal.head,
      command:recoveryDigest(encodeRecoveryCommand(command)),state:recoveryBusinessStateDigest(state),proofRoot:digest(state.proofs),policy:`sha256:${admissionPolicyDigest(state.policy)}`,
      previousCut:journal.stable?headerId(journal.stable.header):ZERO,terminal:state.transition?witnessHandoffProposalId(state.transition):journal.head,funding:compiled.digest,genesis:state.originalGenesis,context:state.context};
  }
  function validateProposal(journal:Journal,proposal:RecoveryProposal) {
    if(journal.view>0&&journal.installedNewView?.view!==journal.view)throw new Error('New view must be durably installed before PREPARE');
    const header=expected(journal,proposal.command),leader=journal.configuration.members[journal.view%5].publicKey;
    if(proposal.leader!==leader||headerId(proposal.header)!==headerId(header)
      ||!verify(signedBytes('proposal',proposal.header),sustainableRecoveryBytes(proposal.signature,'base64url'),sustainableRecoveryBytes(leader,'base64url')))throw new Error('Invalid executed recovery leader/proposal/endpoint');
    const protectedValue=journal.prepared??(journal.locked&&journal.locked.proposal.header.sequence>journal.sequence?journal.locked:undefined);
    if(protectedValue&&(protectedValue.proposal.header.command!==header.command||protectedValue.proposal.header.previous!==header.previous||protectedValue.proposal.header.state!==header.state))throw new Error('Durable prepared lock forbids equivocation');return header;
  }
  async function exclusive<T>(operation:()=>Promise<T>):Promise<T>{live();if(busy)throw new Error('Executed recovery operation in progress');busy=true;try{return await meter(operation);}finally{busy=false;}}
  return {
    read(){return meter(()=>read());},
    workUsage(){return lastWork;},
    async bootstrap(capability:ReturnType<typeof prepareSustainableRecoveryBootstrap> extends Promise<infer T>?T:never) {return exclusive(async()=>{
      const state=bootstrapCapabilities.get(capability);if(!state)throw new Error('Bootstrap requires complete original verification capability');
      if(options.storage.read())throw new Error('Executed bootstrap cannot reset existing state');
      if(!options.configuration.members.some(m=>m.publicKey===signer)||!knownSet(state,admissionWitnessSetId(options.configuration)))throw new Error('Wrong original role scope');
      options.storage.configureOriginal({genesis:state.originalGenesis,configuration:admissionWitnessSetId(options.configuration),context:state.context});
      const bootstrapObjects=[...capability.objects.map(o=>({bytes:sustainableRecoveryBytes(o.bytes,'base64url'),kind:'original' as const})),
        ...state.evidence.votes.map(vote=>({bytes:json({kind:'vote',vote}),kind:'original' as const})),...state.evidence.certificates.map(certificate=>({bytes:json({kind:'certificate',certificate}),kind:'original' as const}))];
      for(const object of bootstrapObjects)if(!options.storage.arena.originalDeclarations.some(d=>d.id===recoveryDigest(object.bytes)&&d.bytes===object.bytes.length))throw new Error(`UNKNOWN undeclared complete bootstrap original obligation: id=${recoveryDigest(object.bytes)} bytes=${object.bytes.length} available=${JSON.stringify([...new Set(options.storage.arena.originalDeclarations.map(d=>d.bytes))])}`);
      const prepared=await options.storage.preflight(bootstrapObjects,encodeRecoveryBusinessState(state).length+4096);
      const committed=(bytes:Buffer,kind:RecoveryProofKind)=>{const id=recoveryDigest(bytes),current=prepared.find(item=>item.commitment.proofId===id&&item.commitment.proofKind===kind);if(!current)throw new Error('Missing preflighted original commitment');return proof(bytes,kind,current);};
      for(const object of capability.objects)if(await committed(sustainableRecoveryBytes(object.bytes,'base64url'),'original')!==object.id)throw new Error('Changed original bootstrap bytes');
      const compact=cloneRecoveryBusinessState(state);compact.voteProofs=[];compact.certificateProofs=[];
      for(const vote of compact.evidence.votes)compact.voteProofs.push(await committed(json({kind:'vote',vote}),'original'));
      for(const certificate of compact.evidence.certificates)compact.certificateProofs.push(await committed(json({kind:'certificate',certificate}),'original'));
      compact.proofs=[...new Set([...compact.proofs,...compact.voteProofs,...compact.certificateProofs])].sort();compact.evidence={...compact.evidence,votes:[],certificates:[]};
      await write({version:1,layout:compiled.digest,state:compact,configuration:options.configuration,view:0,sequence:0,head:ZERO,prepared:null,committed:null,stable:null,suffix:0,fenced:false});
    });},
    propose(command:RecoveryBusinessCommand):RecoveryProposal {return meter(()=>{const journal=read();if(journal.configuration.members[journal.view%5].publicKey!==signer)throw new Error('Only deterministic view leader proposes');
      const header=expected(journal,command);return {header,leader:signer,signature:signHeader('proposal',header,options.key).signature,command};});},
    async prepare(proposal:RecoveryProposal){return exclusive(async()=>{const journal=read();validateProposal(journal,proposal);
      if(journal.prepared&&headerId(journal.prepared.proposal.header)===headerId(proposal.header))return signHeader('prepare',proposal.header,options.key);
      const phases=proposal.command.kind==='cut'?['prepare','commit','cut']:['prepare','commit'];
      const completion:Array<{bytes:Buffer;kind:RecoveryProofKind}>=phases.map(phase=>({bytes:encodeRecoveryCertificate({phase:phase as RecoveryCertificate['phase'],header:proposal.header,signatures:journal.configuration.members.slice(0,4).map(m=>({signer:m.publicKey,signature:'x'.repeat(86)}))}),kind:'frame' as const}));
      const commandKind=proposal.command.kind==='cut'||proposal.command.kind==='reconfigure'?'frame' as const:'original' as const;
      completion.push({bytes:encodeRecoveryCommand(proposal.command),kind:commandKind});
      const certified={proposal,certificate:decodeRecoveryCertificate(completion[0].bytes)};
      const committed=decodeRecoveryCertificate(completion[1].bytes);
      const preparedJournal={...journal,prepared:{proposal,certificate:null},locked:journal.prepared?.certificate?journal.prepared:journal.locked?.certificate?journal.locked:{proposal,certificate:null}};
      const commitJournal={...journal,prepared:certified,locked:certified};
      const executedJournal={...commitJournal,state:nextState(journal,proposal.command),sequence:proposal.header.sequence,head:headerId(proposal.header),committed,suffix:journal.suffix+1};
      const finishedJournal={...executedJournal,prepared:null,committed:null,...(proposal.command.kind==='cut'?{stable:decodeRecoveryCertificate(completion[2].bytes),suffix:0}:{})};
      const completionPrepared=await options.storage.preflight(completion,Math.max(...[preparedJournal,commitJournal,executedJournal,finishedJournal].map(j=>encodeRecoveryJournal(j).length)));
      for(const item of completionPrepared.slice(0,-1))item.dek?.fill(0);
      if(proposal.command.kind==='accept')await options.freshPolicy(journal.state.policy,performance.now()+3000);
      const prepared={proposal,certificate:null};await proof(encodeRecoveryCommand(proposal.command),commandKind,completionPrepared[completionPrepared.length-1]);await write({...journal,prepared,locked:journal.prepared?.certificate?journal.prepared:journal.locked?.certificate?journal.locked:prepared});
      return signHeader('prepare',proposal.header,options.key);});},
    async commit(certificate:RecoveryCertificate){return exclusive(async()=>{const journal=read();verifyRecoveryCertificate(certificate,journal.configuration,'prepare');
      if(!journal.prepared||headerId(journal.prepared.proposal.header)!==headerId(certificate.header))throw new Error('Commit lost durable prepared value');
      const prepared={...journal.prepared,certificate};await proof(encodeRecoveryCertificate(certificate),'frame');await write({...journal,prepared,locked:prepared});
      return signHeader('commit',certificate.header,options.key);});},
    async execute(certificate:RecoveryCertificate){return exclusive(async()=>{const journal=read();verifyRecoveryCertificate(certificate,journal.configuration,'commit');
      if(journal.sequence===certificate.header.sequence&&journal.head===headerId(certificate.header))return signHeader(journal.prepared?.proposal.command.kind==='cut'?'cut':'executed',certificate.header,options.key);
      const prepared=journal.prepared;if(!prepared?.certificate||headerId(prepared.proposal.header)!==headerId(certificate.header))throw new Error('Execution lost prepared proof');
      validateProposal(journal,prepared.proposal);const state=nextState(journal,prepared.proposal.command);await proof(encodeRecoveryCertificate(certificate),'frame');
      const next={...journal,state,sequence:certificate.header.sequence,head:headerId(certificate.header),committed:certificate,suffix:journal.suffix+1};
      await write(next);return signHeader(prepared.proposal.command.kind==='cut'?'cut':'executed',certificate.header,options.key);});},
    async finish(certificate?:RecoveryCertificate){return exclusive(async()=>{const journal=read();if(!journal.committed)throw new Error('No durable executed completion');
      if(certificate){verifyRecoveryCertificate(certificate,journal.configuration,'cut');if(journal.head!==headerId(certificate.header)||journal.prepared?.proposal.command.kind!=='cut')throw new Error('Cut differs from durable executed endpoint');await proof(encodeRecoveryCertificate(certificate),'frame');}
      await write({...journal,prepared:null,committed:null,...(certificate?{stable:certificate,suffix:0}:{})});
    });},
    async freeze(receipts:RecoveryFundingReceipt[]){return exclusive(async()=>{const journal=read();if(!journal.stable||journal.head!==headerId(journal.stable.header)||journal.prepared||!journal.state.transition)throw new Error('Freeze requires committed ordered successor and terminal cut');
      if(!Array.isArray(receipts)||receipts.length!==4||new Set(receipts.map(r=>r.signer)).size!==4)throw new Error('Freeze requires four durable prospective completion reservations');
      for(const receipt of receipts){const {signature,...body}=receipt;if(receipt.version!==1||receipt.cut!==journal.head||receipt.proposal!==witnessHandoffProposalId(journal.state.transition)||receipt.layout!==compiled.digest
        ||!journal.state.transition.newSet.members.some(m=>m.publicKey===receipt.signer)||!verify(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:recovery-funding:v1\n'),json(canonical(body))]),sustainableRecoveryBytes(signature,'base64url'),sustainableRecoveryBytes(receipt.signer,'base64url')))throw new Error('Unauthenticated successor completion reservation');}
      await write({...journal,fenced:true});options.storage.assertReady();
      return createWitnessFreezeReport(journal.state.transition,journal.stable.header.proofRoot,journal.head,options.key);
    });},
    recipientEnrollment(cut:RecoveryCertificate){return options.storage.recipientEnrollment(cut.header.genesis,cut.header.context);},
    async transfer(proposalValue:WitnessHandoffProposal|string,recipientEnrollment:RecoveryRecipientEnrollment):Promise<RecoveryTransfer>{return exclusive(async()=>{
      const journal=read();if(!journal.stable||journal.head!==headerId(journal.stable.header)||journal.prepared)throw new Error('Transfer requires stable executed terminal cut');
      const handoff=typeof proposalValue==='string'?undefined:parseWitnessHandoffProposal(proposalValue),oldSet=handoff?.oldSet??journal.configuration,newSet=handoff?.newSet??journal.configuration;
      const proposal=handoff?witnessHandoffProposalId(handoff):proposalValue as string;
      if(!/^sha256:[a-f0-9]{64}$/.test(proposal)||admissionWitnessSetId(oldSet)!==admissionWitnessSetId(journal.configuration)
        ||!oldSet.members.some(member=>member.publicKey===signer))throw new Error('Unauthorized current transfer exporter');
      const enrollment=verifyRecoveryRecipientEnrollment(recipientEnrollment,{genesis:journal.stable.header.genesis,context:journal.stable.header.context});
      if(!newSet.members.some(member=>member.publicKey===enrollment.owner))throw new Error('Unauthorized transfer recipient');
      const objects=await options.storage.exportProofs(journal.state.proofs,proposal,enrollment);
      return {cut:journal.stable,state:cloneRecoveryBusinessState(journal.state),proposal,recipientEnrollment:enrollment,objects};
    });},
    async reserveInstall(transfer:RecoveryTransfer,proposalValue:WitnessHandoffProposal){return exclusive(async()=>{
      const proposal=parseWitnessHandoffProposal(proposalValue),cutId=headerId(transfer.cut.header);
      if(transfer.state.evidence.activations.length>=compiled.manifest.transitions)throw new Error('Finite future installation allowance exhausted');
      verifyRecoveryCertificate(transfer.cut,proposal.oldSet,'cut');
      if(!proposal.newSet.members.some(m=>m.publicKey===signer)||!transfer.state.transition||witnessHandoffProposalId(transfer.state.transition)!==witnessHandoffProposalId(proposal)
        ||transfer.cut.header.terminal!==witnessHandoffProposalId(proposal)||recoveryBusinessStateDigest(transfer.state)!==transfer.cut.header.state||digest(transfer.state.proofs)!==transfer.cut.header.proofRoot
        ||transfer.state.originalGenesis!==`sha256:${admissionPolicyDigest(options.originalGenesis)}`||transfer.cut.header.funding!==compiled.digest)throw new Error('Unverified successor readiness state/authority/layout');
      await options.storage.startup();
      const old=options.storage.read()?read():undefined;
      if(old&&(old.sequence>transfer.cut.header.sequence||old.sequence===transfer.cut.header.sequence&&old.head!==cutId
        ||old.prepared&&old.prepared.proposal.header.sequence>transfer.cut.header.sequence
        ||old.locked&&old.locked.proposal.header.sequence>transfer.cut.header.sequence
        ||old.state.proofs.some(id=>!transfer.state.proofs.includes(id))))throw new Error('Successor readiness lost original/pending floor');
      const items=await validateTransferObjects(transfer,witnessHandoffProposalId(proposal),proposal.oldSet,proposal.newSet);
      options.storage.configureOriginal({genesis:transfer.cut.header.genesis,configuration:admissionWitnessSetId(proposal.newSet),context:transfer.cut.header.context});
      const draft:Journal={version:1,layout:compiled.digest,state:cloneRecoveryBusinessState(transfer.state),configuration:proposal.newSet,view:0,sequence:transfer.cut.header.sequence,head:cutId,prepared:null,committed:null,stable:transfer.cut,suffix:0,fenced:false,stage:'reserved'};
      const closure=options.storage.arena.proofClosure,maxima=installationMaximum(transfer.state.policy,proposal);
      if(maxima.policy>closure.policy.maximumBytes||maxima.activation>closure.activation.maximumBytes)throw new Error('Complete prospective policy/activation encoding exceeds reserved maxima');
      draft.installPolicyShape=installPolicyShape(transfer.state.policy,proposal);
      const futureState=cloneRecoveryBusinessState(transfer.state);delete futureState.transition;
      futureState.policy={reserved:'x'.repeat(closure.policy.maximumBytes)} as unknown as SignedAdmissionPolicy;
      futureState.evidence.sets=[...futureState.evidence.sets,proposal.newSet];
      futureState.evidence.activations=[...futureState.evidence.activations,{reserved:'x'.repeat(closure.activation.maximumBytes)} as unknown as WitnessHandoffActivation];
      futureState.proofs=[...futureState.proofs,`sha256:${'1'.repeat(64)}`,`sha256:${'2'.repeat(64)}`];
      const futureBytes=encodeRecoveryJournal({...draft,state:futureState,stage:undefined,installPolicyShape:undefined}).length;
      const prepared=await options.storage.preflight([...items,{bytes:Buffer.alloc(closure.policy.maximumBytes,1),kind:'policy'},{bytes:Buffer.alloc(closure.activation.maximumBytes,2),kind:'activation'}],Math.max(encodeRecoveryJournal(draft).length,futureBytes));
      for(const item of prepared.slice(items.length))item.dek?.fill(0);
      options.storage.arena.assertImageSize('suffix',closure.policy.maximumBytes+128);
      options.storage.arena.assertImageSize('pending',512);
      for(let index=0;index<items.length;index++)await proof(items[index].bytes,items[index].kind,prepared[index]);
      options.storage.arena.write('pending',json({cut:cutId,proposal:witnessHandoffProposalId(proposal)}));
      options.storage.arena.write('suffix',json({policy:transfer.state.policy,cut:cutId}));
      await write(draft);
      const mirror=sustainableRecoveryParse(options.storage.arena.read('suffix')!.bytes) as {policy:SignedAdmissionPolicy;cut:string};
      if(admissionPolicyDigest(mirror.policy)!==admissionPolicyDigest(read().state.policy))throw new Error('Readiness policy mirror/owner mismatch');
      serving=false;const body={version:1 as const,cut:cutId,proposal:witnessHandoffProposalId(proposal),layout:compiled.digest,signer};
      return {...body,signature:sustainableRecoveryBytes(sign(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:recovery-funding:v1\n'),json(canonical(body))]),options.key.secretKey)).toString('base64url')};
    });},
    async prepareInstall(transfer:RecoveryTransfer,proposalValue:WitnessHandoffProposal,drainedValue:WitnessDrainReport[]){return exclusive(async()=>{
      await options.storage.startup();const proposal=parseWitnessHandoffProposal(proposalValue),cutId=headerId(transfer.cut.header),drained=parseWitnessDrainCertificate(drainedValue,proposal,cutId),journal=read();
      if(journal.stage!=='reserved'&&journal.stage!=='ready'||journal.head!==cutId||!journal.state.transition||witnessHandoffProposalId(journal.state.transition)!==witnessHandoffProposalId(proposal))throw new Error('Readiness requires previously durable complete funding reservation');
      await write({...journal,stage:'ready'});serving=false;return createWitnessReadyReport(proposal,cutId,drained,options.key);
    });},
    async install(transfer:RecoveryTransfer,activation:WitnessHandoffActivation,currentPolicy:SignedAdmissionPolicy){return exclusive(async()=>{
      const installed=options.storage.read()?read():undefined;
      if(!installed||installed.stage!=='ready')throw new Error('Activation requires previously durable successor readiness');
      if(transfer.state.evidence.activations.length>=compiled.manifest.transitions)throw new Error('Finite declared configuration events exhausted');
      const parsed=parseWitnessHandoffActivation(activation),old=parsed.proposal.oldSet,next=parsed.proposal.newSet;
      verifyRecoveryCertificate(transfer.cut,old,'cut');const cutId=headerId(transfer.cut.header);
      const policy=await verifyAdmissionPolicy(currentPolicy,options.originalGenesis.authority);
      if(installed.installPolicyShape!==installPolicyShape(policy,parsed.proposal))throw new Error('Policy differs from the prospectively funded installation plan');
      if(parsed.manifest!==cutId||!policy.keys.some(k=>k.witnessHandoff&&digest(k.witnessHandoff)===digest(parsed))
        ||!next.members.some(m=>m.publicKey===signer)||transfer.state.originalGenesis!==`sha256:${admissionPolicyDigest(options.originalGenesis)}`
        ||recoveryBusinessStateDigest(transfer.state)!==transfer.cut.header.state||digest(transfer.state.proofs)!==transfer.cut.header.proofRoot
        ||transfer.cut.header.funding!==compiled.digest||!transfer.state.transition||witnessHandoffProposalId(transfer.state.transition)!==witnessHandoffProposalId(parsed.proposal)||transfer.cut.header.terminal!==witnessHandoffProposalId(parsed.proposal))throw new Error('Wrong authenticated activation/state/proof/funding');
      if(installed&&(transfer.cut.header.sequence<installed.sequence||transfer.cut.header.sequence===installed.sequence&&cutId!==installed.head
        ||installed.prepared&&installed.prepared.proposal.header.sequence>transfer.cut.header.sequence
        ||installed.locked&&installed.locked.proposal.header.sequence>transfer.cut.header.sequence
        ||installed.state.proofs.some(id=>!transfer.state.proofs.includes(id))))throw new Error('Install violates durable/pending evidence floor');
      const items=await validateTransferObjects(transfer,witnessHandoffProposalId(parsed.proposal),old,next);
      const state=cloneRecoveryBusinessState(transfer.state);delete state.transition;state.policy=policy;state.evidence=mergeWitnessEvidence([state.evidence,{sets:[next],activations:[parsed],votes:[],certificates:[],accepted:[],denials:[]}]);
      const policyBytes=json(policy),activationBytes=json(parsed),prospective={...installed,state:{...state,proofs:[...state.proofs,ZERO,`sha256:${'1'.repeat(64)}`].sort()},stage:undefined,installPolicyShape:undefined};
      const prepared=await options.storage.preflight([...items,{bytes:policyBytes,kind:'policy'},{bytes:activationBytes,kind:'activation'}],encodeRecoveryJournal(prospective).length);
      for(let index=0;index<items.length;index++)await proof(items[index].bytes,items[index].kind,prepared[index]);
      state.proofs=[...new Set([...state.proofs,await proof(policyBytes,'policy',prepared[items.length]),await proof(activationBytes,'activation',prepared[items.length+1])])].sort();
      // One funded recoverable installation intent, then independently encoded
      // mirror and owner state. Reopen both before readiness/service.
      const intent=json({cut:cutId,policy:admissionPolicyDigest(policy),state:recoveryBusinessStateDigest(state)});options.storage.arena.write('pending',intent);
      options.storage.arena.write('suffix',json({policy,cut:cutId}));
      await write({version:1,layout:compiled.digest,state,configuration:next,view:0,sequence:transfer.cut.header.sequence,head:cutId,prepared:null,committed:null,stable:transfer.cut,suffix:0,fenced:false});
      const mirror=sustainableRecoveryParse(options.storage.arena.read('suffix')!.bytes) as {policy:SignedAdmissionPolicy;cut:string};
      if(admissionPolicyDigest(mirror.policy)!==admissionPolicyDigest(read().state.policy)||mirror.cut!==cutId)throw new Error('Incomplete policy/owner installation');
      serving=false;
    });},
    async startup(){return exclusive(async()=>{serving=false;await options.storage.startup();const journal=read(),available=new Set(options.storage.arena.ids());
      for(const id of journal.state.proofs)if(!available.has(id))throw new Error('Recovery missing required original proof');
      if(journal.prepared||journal.committed||journal.fenced||journal.stage)throw new Error('Recovery must complete durable pending/prepared floor before service');
      await options.freshPolicy(journal.state.policy,performance.now()+3000);serving=true;return {sequence:journal.sequence,digest:journal.head};
    });},
    /** Real accepted-spend lookup: original attribution survives imports. */
    async retry(request:AdmissionWitnessRequest){return meter(async()=>{live();if(!serving)throw new Error('Executed recovery service not ready');options.storage.assertReady();const journal=read();
      await options.freshPolicy(journal.state.policy,performance.now()+3000);options.storage.assertReady();if(read().head!==journal.head)throw new Error('Business endpoint changed during fresh authorization');
      assertSustainableRetryKey(journal.state.policy,request,now());
      if(!verifyAdmissionWitnessRequest(request,journal.configuration))throw new Error('Unauthenticated current admission request');
      const rows=journal.state.evidence.accepted.filter(r=>r.issuerKey===request.issuerKey&&r.spend===request.spend);
      if(rows.some(r=>r.action!==request.action||r.binding!==request.requestBinding))throw new Error('Conflicting original retry');
      const constraint=witnessConstraint(materializedEvidence(journal.state),request);if(['denied','conflict','split'].includes(constraint))throw new Error('Retained denial/conflict/uncertainty');
      return rows.length?{...rows[0]}:undefined;
    });},
    async viewChange(view:number):Promise<RecoveryViewChange>{return exclusive(async()=>{const journal=read();if(journal.stage)throw new Error('Terminal installation reservation forbids view changes');if(journal.lastViewChange?.view===view)return journal.lastViewChange;if(!journal.stable||!Number.isSafeInteger(view)||view<=journal.view)throw new Error('View change requires authenticated stable cut and increasing view');
      const body={view,signer,base:journal.stable,floor:{configuration:admissionWitnessSetId(journal.configuration),sequence:journal.sequence,digest:journal.head},prepared:journal.prepared?.certificate?journal.prepared:journal.locked?.certificate?journal.locked:null};
      const record={...body,signature:sustainableRecoveryBytes(sign(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:executed-recovery:view-change:v1\n'),json(canonical(body))]),options.key.secretKey)).toString('base64url')};await write({...journal,view,lastViewChange:record});return record;});},
    async newView(records:RecoveryViewChange[],transfer:RecoveryTransfer){return exclusive(async()=>{
      const journal=read();if(journal.stage)throw new Error('Terminal installation reservation forbids view changes');if(records.length!==4||new Set(records.map(r=>r.signer)).size!==4)throw new Error('New view requires four distinct authenticated records');
      const view=records[0].view;if(!Number.isSafeInteger(view)||view<=0||view<journal.view)throw new Error('Stale new view');
      const identity=digest({records:[...records].sort((a,b)=>a.signer.localeCompare(b.signer)),cut:transfer.cut});
      if(journal.installedNewView?.view===view){if(journal.installedNewView.identity!==identity)throw new Error('Different same-view NEW_VIEW identity');return;}
      for(const record of records){const {signature,...body}=record;
        if(record.view!==view||!journal.configuration.members.some(m=>m.publicKey===record.signer)
          ||!verify(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:executed-recovery:view-change:v1\n'),json(canonical(body))]),sustainableRecoveryBytes(signature,'base64url'),sustainableRecoveryBytes(record.signer,'base64url')))throw new Error('Unauthenticated new-view record');
        const baseSet=knownSet(journal.state,record.base.header.configuration);if(!baseSet)throw new Error('Unauthenticated stable cut base');verifyRecoveryCertificate(record.base,baseSet,'cut');
        if(record.base.header.view>=view||record.floor.configuration!==admissionWitnessSetId(journal.configuration))throw new Error('Ineligible new-view base/floor');
        if(record.prepared&&!record.prepared.certificate)throw new Error('New view prepared value lacks certificate');
        if(record.prepared?.certificate){if(record.prepared.proposal.header.view>=view||record.prepared.proposal.header.configuration!==admissionWitnessSetId(journal.configuration))throw new Error('Ineligible prepared-certificate view/configuration');const set=knownSet(journal.state,record.prepared.certificate.header.configuration);if(!set)throw new Error('Prepared certificate scope differs');verifyRecoveryCertificate(record.prepared.certificate,set,'prepare');
          if(headerId(record.prepared.proposal.header)!==headerId(record.prepared.certificate.header)||recoveryDigest(encodeRecoveryCommand(record.prepared.proposal.command))!==record.prepared.proposal.header.command)throw new Error('Prepared value differs from certificate');}
      }
      const bases=records.map(r=>r.base).sort((a,b)=>b.header.sequence-a.header.sequence),base=bases[0];
      if(bases.some(b=>b.header.sequence===base.header.sequence&&headerId(b.header)!==headerId(base.header)))throw new Error('Incompatible certified stable bases');
      if(headerId(transfer.cut.header)!==headerId(base.header)||recoveryBusinessStateDigest(transfer.state)!==base.header.state||digest(transfer.state.proofs)!==base.header.proofRoot)throw new Error('New view lacks matching authenticated state/proof transfer');
      if(base.header.sequence<journal.sequence||base.header.sequence===journal.sequence&&headerId(base.header)!==journal.head)throw new Error('New-view base below local durable committed floor; catch up required');
      if(records.some(r=>r.floor.sequence>base.header.sequence))throw new Error('New view must catch up committed floors before readiness');
      const transferProposal=recoveryNewViewProposal(records,base);
      const items=await validateTransferObjects(transfer,transferProposal,journal.configuration,journal.configuration);
      const prepared=records.flatMap(r=>r.prepared?.certificate&&r.prepared.proposal.header.sequence>base.header.sequence?[r.prepared]:[])
        .sort((a,b)=>b.proposal.header.view-a.proposal.header.view);
      if(prepared.some(p=>p.proposal.header.sequence!==base.header.sequence+1))throw new Error('New view cannot skip committed predecessor');
      if(prepared.length&&prepared.some(p=>p.proposal.header.view===prepared[0].proposal.header.view&&p.proposal.header.command!==prepared[0].proposal.header.command))throw new Error('Conflicting highest-view prepared certificates');
      const lock=journal.prepared?.certificate?journal.prepared:journal.locked?.certificate?journal.locked:undefined;
      if(lock&&lock.proposal.header.sequence>base.header.sequence){const selected=prepared[0];if(!selected||selected.proposal.header.view<lock.proposal.header.view
        ||selected.proposal.header.view===lock.proposal.header.view&&(selected.proposal.header.command!==lock.proposal.header.command||selected.proposal.header.state!==lock.proposal.header.state||selected.proposal.header.previous!==lock.proposal.header.previous))throw new Error('New view omitted/conflicted protected prepared lock');}
      const nextJournal={...journal,state:cloneRecoveryBusinessState(transfer.state),sequence:base.header.sequence,head:headerId(base.header),stable:base,view,installedNewView:{view,identity},prepared:null,locked:prepared[0],committed:null,suffix:0};
      const pairs=await options.storage.preflight(items,encodeRecoveryJournal(nextJournal).length);
      for(let index=0;index<items.length;index++)await proof(items[index].bytes,items[index].kind,pairs[index]);
      await write(nextJournal);
      serving=false;
    });},
    close(){closed=true;serving=false;options.storage.close();},
  };
}
export type SustainableRecoveryRuntime = ReturnType<typeof openSustainableRecoveryRuntime>;
