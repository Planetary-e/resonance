/** Explicit local operator workflow. The selected admission-history command owns
 * aggregate funding; artifacts contain confidential original evidence. */
import { prepareAdmissionPolicyV3Successor, signAdmissionPolicyV3, createResolvedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
import { createAdmissionPolicyHistoryProof } from './admission-policy-history-proof.js';
import { statSync } from 'node:fs';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { MAX_ADMISSION_POLICY_BYTES, signAdmissionPolicy, admissionKeyFingerprint } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createWitnessHandoffActivation, parseWitnessDrainCertificate, parseWitnessHandoffActivation, witnessHandoffDigest, type WitnessDrainReport, type WitnessReadyReport } from '@resonance/core/admission-witness-handoff';
import { loadAdmissionHistoryProtectionFile } from './admission-history-config.js';
import { createHistoryOperatorTransport } from './history-operator-transport.js';
import { readOperatorJson, readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';
import { openProtectedAdmissionSpendHistory } from './protected-admission-history.js';
import { enrollProtectedWitnessEpoch, proposeProtectedWitnessHandoff, freezeProtectedWitness, prepareProtectedWitnessTransfer, installProtectedWitnessTransfer,
  activateProtectedWitnessTransfer, installProtectedCoordinatorTransfer, retainOriginalWitnessCertificate, type WitnessFreezeEvidence, type WitnessTerminalEvidence, type WitnessTerminalPins } from './protected-witness-handoff.js';
import type { WitnessTransferManifest } from './witness-handoff-state.js';
import type { AdmissionWitnessSet, AdmissionSpendCertificate } from '@resonance/core/admission-witness';
import type { SignedAdmissionPolicy } from '@resonance/core/admission-policy';
const EVIDENCE_BYTES = 256*1024*1024;
// Immutable exclusive artifacts reserve their actual encoded length. The format
// ceiling bounds input/verification; reserving that ceiling for every tiny export
// would spend the fixed authority on unused capacity.
function writeOutput(path: string, value: unknown, ceiling: number) {
  const encoded=JSON.stringify(value);
  if(encoded===undefined)throw new Error('Handoff output must encode JSON');
  const bytes=Buffer.byteLength(encoded+'\n');
  if(bytes>ceiling)throw new Error('Handoff output exceeds its existing byte limit');
  writeOperatorJsonNew(path,value,bytes);
}
function read(path: string, ceiling = MAX_ADMISSION_POLICY_BYTES) {
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size < 1 || size > ceiling) throw new Error('Witness handoff input exceeds its existing byte limit');
  return readOperatorJson(path,size);
}
export async function runWitnessHandoffCommand(command: string, args: readonly string[], options: { signal?: AbortSignal; transportFile?: string } = {}) {
  options.signal?.throwIfAborted();
  if (command === 'witness-transfer-prepare') {
    if (args.length !== 8) throw new Error('Witness transfer preparation needs proposal, independent pins, four terminal pairs, manifest output and seal output');
    const values = args.slice(2,6).map(path => read(path,EVIDENCE_BYTES) as WitnessTerminalEvidence);
    const manifest = await prepareProtectedWitnessTransfer(read(args[0]) as WitnessTransferManifest['proposal'],values,options.signal,read(args[1],65536) as WitnessTerminalPins[]);
    writeOutput(args[6],manifest,8*1024*1024);writeOutput(args[7],{version:1,proposal:manifest.proposal,manifest:witnessHandoffDigest(manifest),freezes:manifest.freezes,activation:null},32768); return { result:'witness-transfer-prepared', manifest: witnessHandoffDigest(manifest), output:args[6] };
  }
  if(command==='witness-drain-prepare'){if(args.length!==6)throw new Error('Drain certificate needs manifest, four observer reports and output');const manifest=read(args[0],8*1024*1024) as WitnessTransferManifest;const drained=parseWitnessDrainCertificate(args.slice(1,5).map(path=>read(path)),manifest.proposal,witnessHandoffDigest(manifest));writeOutput(args[5],drained,32768);return{result:'witness-drain-prepared',output:args[5]};}
  if (command === 'witness-activation-prepare') {
    if (args.length !== 10) throw new Error('Activation needs prior policy, manifest, drain certificate, four readiness reports, authority key, policy output and advance output');
    const previous = read(args[0]) as SignedAdmissionPolicy, manifest = read(args[1],8*1024*1024) as WitnessTransferManifest;
    const drained = read(args[2]) as WitnessDrainReport[], ready = args.slice(3,7).map(path => read(path) as WitnessReadyReport), key = readOperatorSigningKey(args[7]);
    try {
      const activation = createWitnessHandoffActivation({ proposal:manifest.proposal, manifest:witnessHandoffDigest(manifest), freezes:manifest.freezes, drained, ready },key);
      const { authority: _, signature: __, ...body } = previous;
      const next = await signAdmissionPolicy({ ...body, revision:previous.revision+1, keys:body.keys.map(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === activation.proposal.issuerKey ? { ...entry,witnesses:activation.proposal.newSet,witnessHandoff:activation } : entry) },previous.authority,key.secretKey);
      const advance = await createAdmissionPolicyAdvance(previous,next,activation.proposal.context,key,activation.proposal.previous);
      options.signal?.throwIfAborted(); writeOutput(args[8],next,MAX_ADMISSION_POLICY_BYTES); writeOutput(args[9],advance,MAX_ADMISSION_POLICY_BYTES+4096);
      return { result:'witness-activation-prepared', policy:args[8], advance:args[9], manifest:activation.manifest };
    } finally { key.secretKey.fill(0); }
  }
  const lengths: Record<string,number> = { 'witness-activation-prepare-v3':13, 'witness-enroll':8, 'witness-propose':7, 'witness-prepare':7, 'witness-terminal-prepare':9, 'witness-install':13, 'witness-coordinator-install':13, 'witness-activate':6, 'witness-recover-certificate':5 };
  if (lengths[command] !== args.length) throw new Error('Invalid explicit witness handoff command or arguments');
  const [configFile,policyFile,storageKeyFile,directory] = args;
  const protection = loadAdmissionHistoryProtectionFile(configFile), encryptionKey = readOperatorStorageKey(storageKeyFile);
  const transport = createHistoryOperatorTransport(protection,options.transportFile,options.signal);
  let history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>> | undefined;
  const abort = () => { history?.close(); transport.close(); }; options.signal?.addEventListener('abort',abort,{once:true});
  try {
    const policy = read(policyFile) as SignedAdmissionPolicy;
    history = await openProtectedAdmissionSpendHistory({ directory,encryptionKey,authority:protection.context.authority,policy,
      protection:{...protection,...transport.protection}, ...(command === 'witness-activate' ? { policyAdvance:read(args[5]) } : {}) });
    if (command !== 'witness-terminal-prepare' || args[5] !== 'resume') await history.ready();
    if(command==='witness-activation-prepare-v3'){
      history.assertHandoffFunding();
      const manifest=read(args[4],8*1024*1024) as WitnessTransferManifest,drained=read(args[5]) as WitnessDrainReport[],ready=args.slice(6,10).map(path=>read(path) as WitnessReadyReport),key=readOperatorSigningKey(args[10]);
      try{
        const activation=createWitnessHandoffActivation({proposal:manifest.proposal,manifest:witnessHandoffDigest(manifest),freezes:manifest.freezes,drained,ready},key),current=history.policy(),saved=history.read();
        if(!saved.image.policyProof)throw new Error('V3 handoff requires the original protected policy proof');
        const proof=createAdmissionPolicyHistoryProof({context:saved.context,encryptionKey,source:history.originalBlocks,reference:saved.image.policyProof,candidate:saved.image,signal:options.signal}),previous={capability:await proof.matches(current)};
        const limits=saved.image.policyProof.limits,reader=proof.reader;
        const prepared=await prepareAdmissionPolicyV3Successor({previous:previous.capability,next:{revision:current.revision+1,issuedAt:current.issuedAt,expiresAt:current.expiresAt,activeKey:current.activeKey,keys:current.keys.map(entry=>admissionKeyFingerprint(entry.profile.issuerPublicKey)===activation.proposal.issuerKey?{...entry,witnesses:activation.proposal.newSet,witnessHandoff:activation}:entry)},reader,limits});
        if(prepared.pages.length)throw new Error('Same-key handoff cannot change the existing archive');
        const next=await signAdmissionPolicyV3(prepared.body,current.authority,key.secretKey),advance=(await createResolvedAdmissionPolicyAdvance({previous:previous.capability,policy:next,key,reader,limits})).advance;
        options.signal?.throwIfAborted();writeOutput(args[11],next,MAX_ADMISSION_POLICY_BYTES);writeOutput(args[12],advance,MAX_ADMISSION_POLICY_BYTES+4096);
        return{result:'witness-v3-activation-prepared',policy:args[11],advance:args[12],manifest:activation.manifest};
      }finally{key.secretKey.fill(0);}
    }
    if (command === 'witness-enroll') {
      const context = read(args[4]) as Parameters<NonNullable<typeof history>['backfillPolicyProof']>[1]['context'];
      const limits = read(args[5]) as NonNullable<Parameters<NonNullable<typeof history>['backfillPolicyProof']>[2]>;
      if(!history.read().image.policyProof)await history.backfillPolicyProof({version:1,kind:'genesis',policy},{context,installed:context.genesis,observed:context.genesis},limits);
      const roles=history.roleState(),keys=[];try{
        if(args[6]!=='-'){const key=readOperatorSigningKey(args[6]);keys.push(key);const witness=Buffer.from(key.publicKey).toString('base64url');if(roles.witness&&roles.witness.witness!==witness)throw new Error('Cannot replace captured witness');roles.witness??={version:2,witness,votes:[],retiredIssuerKeys:[]};}
        if(args[7]!=='-'){const key=readOperatorSigningKey(args[7]);keys.push(key);const coordinator=Buffer.from(key.publicKey).toString('base64url');if(roles.coordinator&&roles.coordinator.coordinator!==coordinator)throw new Error('Cannot replace captured coordinator');roles.coordinator??={version:2,coordinator,certificates:[],retiredIssuerKeys:[]};}
        const review=await history.planRoleCapture(roles);await history.captureRoles(roles,review.approvalDigest);
      }finally{keys.forEach(key=>key.secretKey.fill(0));}
      await enrollProtectedWitnessEpoch(history,policy); return {result:'witness-enrolled'};
    }
    if (command === 'witness-propose') {
      const key = readOperatorSigningKey(args[5]);
      try { const proposal = proposeProtectedWitnessHandoff(history,policy.activeKey,read(args[4]) as AdmissionWitnessSet,key); writeOutput(args[6],proposal,32768); return {result:'witness-proposed',output:args[6]}; }
      finally { key.secretKey.fill(0); }
    }
    if (command === 'witness-prepare') {
      const key = readOperatorSigningKey(args[5]);
      try { const evidence = await freezeProtectedWitness(history,read(args[4]) as WitnessTransferManifest['proposal'],key,encryptionKey); options.signal?.throwIfAborted(); writeOutput(args[6],evidence,EVIDENCE_BYTES); return {result:'witness-old-fenced',output:args[6],evidence:evidence.report.evidence}; }
      finally { key.secretKey.fill(0); }
    }
    if (command === 'witness-terminal-prepare') {
      if (!['create-new','resume'].includes(args[5]) || !/^[1-9][0-9]*$/.test(args[6])) throw new Error('Terminal export needs explicit create-new/resume and next generation');
      // Capture authority from this configured, encrypted local owner, before
      // obtaining any exported pair. Imported bundles never supply these pins.
      const saved = history.read(), first = history.originalBlocks()[Symbol.iterator]().next();
      if (first.done) throw new Error('Terminal export requires retained original genesis');
      const head = saved.pending ? { sequence:saved.pending.sequence,id:historyCheckpointEnvelopeId(saved.pending) } : saved.applied;
      if (!head) throw new Error('Terminal export requires an exact local head');
      const pins: WitnessTerminalPins = { context:structuredClone(saved.context),genesisId:historyCheckpointEnvelopeId(first.value),
        rootId:historyCheckpointEnvelopeId(saved.root),generation:saved.root.generation,nextGeneration:Number(args[6]),head:{...head} };
      const pair = await history.prepareTerminalWitness(read(args[4]) as WitnessTransferManifest['proposal'],
        { mode:args[5] as 'create-new'|'resume',nextGeneration:pins.nextGeneration,signal:options.signal });
      options.signal?.throwIfAborted(); writeOutput(args[8],pins,65536); writeOutput(args[7],pair,EVIDENCE_BYTES);
      return {result:'witness-terminal-prepared',output:args[7],pins:args[8]};
    }
    if (command === 'witness-install' || command === 'witness-coordinator-install') {
      const manifest = read(args[4],8*1024*1024) as WitnessTransferManifest, drained = read(args[5]) as WitnessDrainReport[], pins = read(args[6],65536) as WitnessTerminalPins[], key = readOperatorSigningKey(args[7]);
      try {
        const values = args.slice(8,12).map(path=>read(path,EVIDENCE_BYTES) as WitnessTerminalEvidence);
        const ready = command==='witness-install'?await installProtectedWitnessTransfer(history,values,manifest,drained,key,options.signal,pins):await installProtectedCoordinatorTransfer(history,values,manifest,drained,key,options.signal,pins);
        writeOutput(args[12],ready,4096); return {result:command==='witness-install'?'witness-new-ready':'witness-coordinator-installed',output:args[12],manifest:ready.manifest};
      } finally { key.secretKey.fill(0); }
    }
    if (command === 'witness-activate') { const input=read(args[4]) as WitnessHandoffActivationOrPolicy;await activateProtectedWitnessTransfer(history,parseWitnessHandoffActivation('keys' in input?input.keys.find(e=>e.witnessHandoff)?.witnessHandoff:input)); return {result:'witness-active-new'}; }
    return {result:'witness-original-certificate-retained',constraint:await retainOriginalWitnessCertificate(history,read(args[4]) as AdmissionSpendCertificate)};
  } catch (error) { throw transport.failure(error); }
  finally { options.signal?.removeEventListener('abort',abort); abort(); encryptionKey.fill(0); protection.signingKey.secretKey.fill(0); }
}

type WitnessHandoffActivationOrPolicy=SignedAdmissionPolicy|import('@resonance/core/admission-witness-handoff').WitnessHandoffActivation;
