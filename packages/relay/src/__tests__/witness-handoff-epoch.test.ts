/** Signature fixtures isolate authenticated ancestry validation; the node
 * integration test supplies actual frozen owner histories and real drains. */
import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair, withSuccessfulEd25519VerificationReuse } from '@resonance/core';
import { signAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { createWitnessHandoffProposal, parseWitnessFreezeReport, parseWitnessHandoffProposal, createWitnessHandoffActivation, createWitnessFreezeReport, createWitnessDrainReport, createWitnessReadyReport, witnessHandoffDigest, witnessHandoffKeyDigest, witnessHandoffObserverPins } from '@resonance/core/admission-witness-handoff';
import { parseAdmissionWitnessSet, admissionWitnessSetId, type AdmissionWitnessSet } from '@resonance/core/admission-witness';
import { emptyWitnessEvidence, mergeWitnessEvidence, parseWitnessInheritedEvidence } from '../witness-handoff-state.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';
const cleanup:Array<()=>void>=[];afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()));
it('rejects original and intermediate historical epoch reuse in independently verified flat ancestry, preserving fresh A identities',async()=>{
  const f=await policyObserverFixture();cleanup.push(f.close);
  await withSuccessfulEd25519VerificationReuse({check:()=>{}},async usage=>{
  const a=Array.from({length:5},generateSigningKeyPair),b=Array.from({length:5},generateSigningKeyPair),pub=(k:typeof a[number])=>Buffer.from(k.publicKey).toString('base64url');
  const make=(keys:typeof a):AdmissionWitnessSet=>parseAdmissionWitnessSet({version:2,epoch:randomBytes(32).toString('base64url'),observerContext:witnessHandoffObserverPins(f.context),quorum:4,members:keys.map((k,i)=>({publicKey:pub(k),endpoint:`ws://127.0.0.1:${36000+i}/`})),coordinators:[pub(a[0])]});
  const A=make(a),B=make(b),freshA={...A,epoch:randomBytes(32).toString('base64url')};
  const genesis=await signAdmissionPolicy({...f.body,keys:[{...f.body.keys[0],witnesses:A}]},f.authority,f.key.secretKey),context=parseAdmissionPolicyObservers({...f.context,genesis:admissionPolicyHead(genesis)});
  function activation(oldSet:AdmissionWitnessSet,newSet:AdmissionWitnessSet,oldKeys:typeof a,newKeys:typeof a,revision:number){
    const proposal=createWitnessHandoffProposal({id:randomBytes(32).toString('base64url'),previous:{...context.genesis,revision},issuerKey:genesis.activeKey,keyDigest:witnessHandoffKeyDigest(genesis.keys[0]),oldSet,newSet,context},f.key),manifest=witnessHandoffDigest(['fixture',revision]);
    const freezes=oldKeys.slice(0,4).map(k=>createWitnessFreezeReport(proposal,witnessHandoffDigest('fixture-evidence'),witnessHandoffDigest('fixture-head'),k)),drained=f.keys.slice(0,4).map(k=>createWitnessDrainReport(proposal,manifest,k)),ready=newKeys.slice(0,4).map(k=>createWitnessReadyReport(proposal,manifest,drained,k));
    return createWitnessHandoffActivation({proposal,manifest,freezes,drained,ready},f.key);
  }
  const ab=activation(A,B,a,b,1),valid=activation(B,freshA,b,a,2);
  const evidence=(sets:AdmissionWitnessSet[],activations:ReturnType<typeof activation>[])=>mergeWitnessEvidence([{...emptyWitnessEvidence(),sets,activations}]);
  expect(()=>parseWitnessInheritedEvidence(evidence([A,B,freshA],[valid,ab]),genesis)).not.toThrow();
  expect(()=>parseWitnessFreezeReport(ab.freezes[0],valid.proposal)).toThrow();
  expect(()=>parseWitnessHandoffProposal({...valid.proposal,version:2})).toThrow();
  const originalReuse=activation(B,A,b,a,2);
  expect(()=>parseWitnessInheritedEvidence(evidence([A,B],[originalReuse,ab]),genesis)).toThrow(/Historical witness epoch/);
  // Same epoch with changed membership also refuses; identity is not just setId.
  const alteredOriginal={...freshA,epoch:A.epoch,members:make(b).members};
  expect(()=>parseWitnessInheritedEvidence(evidence([A,B,alteredOriginal],[ab,activation(B,alteredOriginal,b,b,2)]),genesis)).toThrow(/Historical witness epoch/);
  const intermediateReuse=activation(freshA,B,a,b,3);
  expect(()=>parseWitnessInheritedEvidence(evidence([A,B,freshA],[ab,valid,intermediateReuse]),genesis)).toThrow(/Historical witness epoch/);
  expect(usage().hits).toBeGreaterThan(0);
  });
});

// Mechanical deterministic canonicalization only; these fixed byte identities
// are not evidence of live signatures or quorum authorization.
it('distinguishes an unordered literal from the canonical witness set used by signed policy',()=>{
  const key=(i:number)=>Buffer.alloc(32,i).toString('base64url');
  const literal:AdmissionWitnessSet={version:2,epoch:key(7),observerContext:'sha256:'+'8'.repeat(64),quorum:4,members:[5,4,3,2,1].map(i=>({publicKey:key(i),endpoint:`ws://127.0.0.1:${36000+i}/`})),coordinators:[key(6)]};
  const canonical=parseAdmissionWitnessSet(literal),golden='sha256:40ed7ce23c1d77eda14f806a80135a57577635981ff261e1f9913b9bfb568520';
  expect(admissionWitnessSetId(literal)).not.toBe(golden);
  expect(admissionWitnessSetId(canonical)).toBe(golden);
  expect(admissionWitnessSetId(parseAdmissionWitnessSet(JSON.parse(JSON.stringify(canonical))))).toBe(golden);
});
