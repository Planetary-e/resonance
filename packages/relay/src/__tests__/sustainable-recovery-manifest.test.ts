import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,openSync,writeSync,closeSync,existsSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {generateSigningKeyPair} from '@resonance/core';
import {openStorageReservationAuthority} from '@resonance/core/storage-reservations';
import {signAdmissionPolicy,admissionKeyFingerprint} from '@resonance/core/admission-policy';
import {parseAdmissionWitnessSet,admissionWitnessSetId} from '@resonance/core/admission-witness';
import {assertSustainableRetryKey} from '../sustainable-recovery-runtime.js';
import {compileSustainableRecoveryManifest,preflightSustainableRecoveryManifest,type RecoveryAllocationManifest} from '../sustainable-recovery-manifest.js';
import {openSustainableRecoveryArena} from '../sustainable-recovery-arena.js';
import {createSustainableRecoveryReplica,generateRecoveryRecipientKey,openSustainableProtectedArena,recoveryDigest,selectInitialRecoveryPair} from '../sustainable-recovery-protected-arena.js';
import {chargeSustainableRecoveryWork,sustainableRecoveryJson,sustainableRecoveryParse,sustainableRecoveryWorkUsage,withSustainableRecoveryWork} from '../sustainable-recovery-work.js';
import {closeRecoveryPairValidationOperation,createRecoveryCapsule,createRecoveryRecipientEnrollment,parseOpaqueRecoveryObjectBytes,prepareOpaqueRecoveryObject,recoveryPairIdentity,verifyRecoveryCapsule,verifyRecoveryOriginalProvenance,verifyRecoveryRecipientEnrollment} from '../sustainable-recovery-opaque.js';

const cleanup:Array<()=>void>=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
import {finiteRecoveryManifest} from './sustainable-recovery-fixture.js';
function setup(){const directory=mkdtempSync(join(tmpdir(),'sustainable-resources-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
 const authority=openStorageReservationAuthority({directory:join(directory,'funding'),mode:'create-new',limitBytes:2*1024**3});cleanup.push(authority.close);
 return {directory,authority,manifest:finiteRecoveryManifest(join(directory,'arenas'))};}
it('sustainable recovery closes 98 exact scopes and preserves fresh/prospective/exhausted arithmetic',()=>{
 const f=setup(),compiled=compileSustainableRecoveryManifest(f.manifest),before=f.authority.status();
 expect(compiled.requests).toHaveLength(98);expect(compiled.arenaBytes).toBe(163545088);
 const review=preflightSustainableRecoveryManifest(f.authority,f.manifest,'new');expect(review.review.fits).toBe(true);expect(f.authority.status()).toEqual(before);
 expect(1879374726+compiled.arenaBytes).toBeLessThanOrEqual(2*1024**3);expect(346+98).toBe(444);expect(512+98).toBe(610);
 f.authority.reserveReservations(compiled.requests);expect(f.authority.status().components).toBe(98);
 expect(preflightSustainableRecoveryManifest(f.authority,f.manifest,'existing').review.additionalBytes).toBe(0);
});
it('sustainable recovery refuses unknown/work/byte/entry/metadata envelopes without ledger effects',()=>{
 const f=setup(),path=join(f.directory,'funding','reservations.json'),before=readFileSync(path),bad=structuredClone(f.manifest);(bad.owners[0] as any).C=undefined;
 expect(()=>preflightSustainableRecoveryManifest(f.authority,bad,'new')).toThrow();expect(readFileSync(path)).toEqual(before);
 const work=structuredClone(f.manifest);work.work.J=256*1024**2;expect(()=>preflightSustainableRecoveryManifest(f.authority,work,'new')).toThrow('work');
 const large=structuredClone(f.manifest);large.owners[0].C=2*1024**3;expect(()=>preflightSustainableRecoveryManifest(f.authority,large,'new')).toThrow();expect(readFileSync(path)).toEqual(before);
 const requests=Array.from({length:512},(_,i)=>({path:join(f.directory,`entry-${i}`),component:'test',scope:'file' as const,maximumBytes:1}));
 f.authority.reserveReservations(requests);const exhausted=readFileSync(path);expect(()=>preflightSustainableRecoveryManifest(f.authority,f.manifest,'new')).toThrow('entry');expect(readFileSync(path)).toEqual(exhausted);
});
it('sustainable recovery atomically refuses serialized metadata overflow in a complete finite batch',()=>{
 const f=setup(),before=readFileSync(join(f.directory,'funding','reservations.json'));
 const component='x'.repeat(256),root=join(f.directory,...Array.from({length:4},()=> '\\'.repeat(220)));
 const requests=Array.from({length:512},(_,i)=>({path:join(root,`${i}`),component,scope:'file' as const,maximumBytes:1}));
 expect(()=>f.authority.reserveReservations(requests)).toThrow('metadata');expect(readFileSync(join(f.directory,'funding','reservations.json'))).toEqual(before);
});
it('sustainable recovery enforces summed child partitions and exact immutable originals through reopen',()=>{
 const f=setup(),key=randomBytes(32),options={authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:0,key};
 const arena=openSustainableRecoveryArena({...options,mode:'new'});const bytes=Buffer.from('original signed business bytes'),id=arena.put(bytes);
 expect(arena.put(bytes)).toBe(id);const usage=arena.usage();expect(()=>arena.write('state',Buffer.alloc(65536))).toThrow('partition');expect(arena.usage()).toEqual(usage);
 arena.write('state',Buffer.from('state one'));arena.write('state',Buffer.from('state two'));arena.close();
 const reopened=openSustainableRecoveryArena({...options,mode:'existing'});cleanup.push(reopened.close);expect(reopened.get(id)).toEqual(bytes);expect(reopened.read()!.bytes.toString()).toBe('state two');
 expect(()=>reopened.get(`sha256:${'a'.repeat(64)}`)).toThrow('Missing');
});
it('sustainable recovery completes a funded opaque pending record after exhaustion and fresh restart selection',async()=>{
 const f=setup(),owner=generateSigningKeyPair(),keys=Array.from({length:5},generateSigningKeyPair),localKey=randomBytes(32),scope=recoveryDigest(Buffer.from('actual protected endpoint')),recipientKey=await generateRecoveryRecipientKey();
 const localOptions={authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:0,key:localKey};
 const local=openSustainableRecoveryArena({...localOptions,mode:'new'}),arenas=keys.map((_,i)=>openSustainableRecoveryArena({authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:i+1,key:randomBytes(32),mode:'new'}));arenas.forEach(a=>cleanup.push(a.close));
 const replicas=keys.map((key,i)=>createSustainableRecoveryReplica({arena:arenas[i],scope,owner:Buffer.from(owner.publicKey).toString('base64url'),signingKey:key}));
 let fail=true;const transport=async(key:string,request:any)=>{const i=replicas.findIndex(r=>r.replica===key);if(fail&&i>1)throw new Error('offline');return replicas[i].exchange(request);};
 let protectedArena=openSustainableProtectedArena({arena:local,scope,signingKey:owner,recipientKey,replicas:replicas.map(r=>r.replica),transport});
 await expect(protectedArena.write(Buffer.from('accepted completion promise'))).rejects.toThrow('Four');const state=f.authority.status();f.authority.reserve({path:join(f.directory,'all-remaining'),component:'test',scope:'file',maximumBytes:state.availableBytes});
 protectedArena.close();fail=false;
 const reopened=openSustainableRecoveryArena({...localOptions,mode:'existing'});protectedArena=openSustainableProtectedArena({arena:reopened,scope,signingKey:owner,recipientKey,replicas:replicas.map(r=>r.replica),transport});cleanup.push(protectedArena.close);
 expect((await protectedArena.startup())!.toString()).toBe('accepted completion promise');expect(f.authority.status().availableBytes).toBe(0);
 protectedArena.configureOriginal({genesis:recoveryDigest(Buffer.from('genesis')),configuration:recoveryDigest(Buffer.from('configuration')),context:recoveryDigest(Buffer.from('context'))});
 const original=Buffer.from('original exact proof');const id=await protectedArena.put(original);const sizes=arenas.map(a=>a.usage().archiveBytes);expect(await protectedArena.put(original)).toBe(id);expect(arenas.map(a=>a.usage().archiveBytes)).toEqual(sizes);
});

it('sustainable recovery refuses UNKNOWN and overloaded prospective closure before funding or arena effects',()=>{
 const f=setup(),ledger=readFileSync(join(f.directory,'funding','reservations.json')),old=structuredClone(f.manifest);
 delete (old.owners[0] as any).closure;
 expect(()=>preflightSustainableRecoveryManifest(f.authority,old,'new')).toThrow();
 const overloaded=structuredClone(f.manifest);
 // Retained original failing witness telemetry: 255346 + 14138 = 269484,
 // already 7340 over C before any following activation bytes.
 overloaded.owners[5].closure.original.bytes=255346+14138;
 expect(()=>preflightSustainableRecoveryManifest(f.authority,overloaded,'new')).toThrow('prospective opaque proof closure exceeds C');
 expect(readFileSync(join(f.directory,'funding','reservations.json'))).toEqual(ledger);expect(existsSync(f.manifest.root)).toBe(false);
});
it('sustainable recovery refuses an ambiguous trailing-zero torn extent without clearing either image',()=>{
 const f=setup(),key=randomBytes(32),options={authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:0,key};
 const arena=openSustainableRecoveryArena({...options,mode:'new'});cleanup.push(arena.close);arena.write('state',Buffer.from('generation zero'));arena.write('state',Buffer.from('durable generation one'));
 const file=join(arena.path,'arena.bin'),torn=Buffer.alloc(43,0x5a);torn[torn.length-1]=0;
 const fd=openSync(file,'r+');writeSync(fd,torn,0,torn.length,256);closeSync(fd);const before=readFileSync(file);
 expect(()=>arena.read()).toThrow('Interrupted');
 expect(()=>arena.recover()).toThrow('Failed-byte F allowance exhausted');
 expect(readFileSync(file)).toEqual(before);expect(()=>arena.read()).toThrow('Interrupted');
});
it('sustainable recovery refuses ambiguous header corruption instead of ignoring damaged images',()=>{
 const f=setup(),arena=openSustainableRecoveryArena({authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:0,key:randomBytes(32),mode:'new'});cleanup.push(arena.close);
 arena.write('state',Buffer.from('zero'));arena.write('state',Buffer.from('one'));const fd=openSync(join(arena.path,'arena.bin'),'r+');writeSync(fd,Buffer.from('BADC'),0,4,0);closeSync(fd);
 expect(()=>arena.recover()).toThrow('protected floor');expect(()=>arena.read()).toThrow('Interrupted');
});
it('sustainable recovery selects the authenticated remote r+1 before making a replacement r+2',async()=>{
 const f=setup(),owner=generateSigningKeyPair(),keys=Array.from({length:5},generateSigningKeyPair),localKey=randomBytes(32),scope=recoveryDigest(Buffer.from('lagging returning owner')),recipientKey=await generateRecoveryRecipientKey();
 const localOptions={authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:0,key:localKey};let local=openSustainableRecoveryArena({...localOptions,mode:'new'});
 const arenas=keys.map((_,i)=>openSustainableRecoveryArena({authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:i+1,key:randomBytes(32),mode:'new'}));arenas.forEach(a=>cleanup.push(a.close));
 const replicas=keys.map((key,i)=>createSustainableRecoveryReplica({arena:arenas[i],scope,owner:Buffer.from(owner.publicKey).toString('base64url'),signingKey:key})),transport=async(key:string,request:any)=>replicas.find(r=>r.replica===key)!.exchange(request);
 let storage=openSustainableProtectedArena({arena:local,scope,signingKey:owner,recipientKey,replicas:replicas.map(r=>r.replica),transport});
 await storage.write(Buffer.from('r0'));const snapshot=join(f.directory,'stale-local.bin');copyFileSync(join(local.path,'arena.bin'),snapshot);await storage.write(Buffer.from('r1'));storage.close();
 copyFileSync(snapshot,join(local.path,'arena.bin'));local=openSustainableRecoveryArena({...localOptions,mode:'existing'});storage=openSustainableProtectedArena({arena:local,scope,signingKey:owner,recipientKey,replicas:replicas.map(r=>r.replica),transport});cleanup.push(storage.close);
 expect((await storage.startup())!.toString()).toBe('r1');await storage.write(Buffer.from('r2'));expect(storage.read()!.toString()).toBe('r2');
});

it('sustainable recovery binds retry cutoff to authenticated issuer fingerprint as well as a shared witness set',async()=>{
 const authority=generateSigningKeyPair(),members=Array.from({length:5},generateSigningKeyPair),pub=(k:ReturnType<typeof generateSigningKeyPair>)=>Buffer.from(k.publicKey).toString('base64url');
 const set=parseAdmissionWitnessSet({version:1,quorum:4,members:members.map((k,i)=>({publicKey:pub(k),endpoint:`ws://127.0.0.1:${45000+i}/`})),coordinators:[pub(authority)]});
 const issuer=()=>generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'pem',type:'spki'}).toString(),one=issuer(),two=issuer(),now=Date.now();
 const entry=(issuerPublicKey:string,retryUntil:number)=>({profile:{version:1 as const,scope:{issuer:'shared-set',community:'public',epoch:'one'},issuerPublicKey,relayUrls:['ws://127.0.0.1:33000/']},notBefore:now-10000,issueUntil:now-8000,spendUntil:now-6000,retryUntil,witnesses:set});
 const policy=await signAdmissionPolicy({version:1,kind:'admission-policy',revision:1,issuedAt:now-10000,expiresAt:now+10000,activeKey:admissionKeyFingerprint(one),keys:[entry(one,now+5000),entry(two,now-1000)]},pub(authority),authority.secretKey);
 expect(assertSustainableRetryKey(policy,{issuerKey:admissionKeyFingerprint(one),setId:admissionWitnessSetId(set)},now).profile.issuerPublicKey).toBe(one);
 expect(()=>assertSustainableRetryKey(policy,{issuerKey:admissionKeyFingerprint(two),setId:admissionWitnessSetId(set)},now)).toThrow('retired');
 expect(()=>assertSustainableRetryKey({...policy,keys:[...policy.keys].reverse()},{issuerKey:admissionKeyFingerprint(two),setId:admissionWitnessSetId(set)},now)).toThrow('retired');
});

it('sustainable recovery preserves an interrupted archive tail and refuses to reuse it as empty space',()=>{
 const f=setup(),key=randomBytes(32),options={authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:0,key};
 const arena=openSustainableRecoveryArena({...options,mode:'new'}),file=join(arena.path,'arena.bin'),fd=openSync(file,'r+');
 const row=f.manifest.owners.find(o=>o.owner==='witness-0')!,start=2*row.L+2*row.D+2*row.P;
 writeSync(fd,Buffer.from('interrupted object payload without commit header'),0,47,start+256);closeSync(fd);arena.close();
 const before=readFileSync(file);expect(()=>openSustainableRecoveryArena({...options,mode:'existing'})).toThrow('archive tail');expect(readFileSync(file)).toEqual(before);
});

it('sustainable recovery shares one cumulative work budget through nested operations and resets at the boundary',async()=>{
 let nestedUsage=0;
 await withSustainableRecoveryWork(1000,async()=>{
  const bytes=sustainableRecoveryJson({kind:'original',value:'abc'},'J');sustainableRecoveryParse(bytes,'J');
  await withSustainableRecoveryWork(1,async()=>{chargeSustainableRecoveryWork(10,'V');nestedUsage=sustainableRecoveryWorkUsage()!.usedBytes;});
  expect(sustainableRecoveryWorkUsage()!.maximumBytes).toBe(1000);
 });
 const first=sustainableRecoveryWorkUsage();expect(first).toBeUndefined();expect(nestedUsage).toBeGreaterThan(10);
 withSustainableRecoveryWork(1000,()=>chargeSustainableRecoveryWork(5,'L'));
 expect(()=>withSustainableRecoveryWork(20,()=>{sustainableRecoveryJson({too:'large'},'L');})).toThrow('cumulative work');
 expect(()=>chargeSustainableRecoveryWork(1)).toThrow('not scoped');
});

it('sustainable recovery authenticates RSO3 pairs and privately repairs exact recipient copies',async()=>{
 const f=setup(),owner=generateSigningKeyPair(),keys=Array.from({length:5},generateSigningKeyPair),encryptionKeys=Array.from({length:5},()=>randomBytes(32)),localKey=randomBytes(32),scope=recoveryDigest(Buffer.from('opaque replica archive')),recipientKey=await generateRecoveryRecipientKey();
 const binding={genesis:recoveryDigest(Buffer.from('original genesis')),configuration:recoveryDigest(Buffer.from('original configuration')),context:recoveryDigest(Buffer.from('original context'))};
 const localOptions={authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:0,key:localKey};
 let local=openSustainableRecoveryArena({...localOptions,mode:'new'}),arenas=keys.map((_,i)=>openSustainableRecoveryArena({authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:i+1,key:encryptionKeys[i],mode:'new'}));arenas.forEach(a=>cleanup.push(a.close));
 let replicas=keys.map((key,i)=>createSustainableRecoveryReplica({arena:arenas[i],scope,owner:Buffer.from(owner.publicKey).toString('base64url'),signingKey:key}));
 let mode=0;const transport=async(key:string,request:any)=>{const index=replicas.findIndex(r=>r.replica===key);if(mode===1&&index>=3)throw new Error('offline');if(mode===2&&index===3)throw new Error('offline');return replicas[index].exchange(request);};
 let storage=openSustainableProtectedArena({arena:local,scope,signingKey:owner,recipientKey,replicas:replicas.map(r=>r.replica),transport});cleanup.push(storage.close);storage.configureOriginal(binding);
 const plaintext=Buffer.from('owner-only exact original proof bytes'),prepared=await storage.preflight([{bytes:plaintext,kind:'original'}],4096),pair=prepared[0],identity=recoveryPairIdentity(pair),id=await storage.put(plaintext,'original',pair);
 expect(prepared[0].dek).toBeUndefined();const retained=arenas[0].getPair(identity),parsed=parseOpaqueRecoveryObjectBytes(retained.frame);expect(recoveryPairIdentity(retained)).toEqual(identity);expect(retained.frame).toEqual(pair.frame);expect(retained.capsuleBytes).toEqual(pair.capsuleBytes);expect(parsed.ciphertext.equals(plaintext)).toBe(false);expect(retained.capsuleBytes.includes(plaintext)).toBe(false);
 const provenance={...binding,proofId:id,kind:'original' as const,signers:[storage.owner]};expect(verifyRecoveryOriginalProvenance(pair,provenance).proofId).toBe(id);
 expect(()=>verifyRecoveryOriginalProvenance(pair,{...provenance,signers:[]})).toThrow('signer/scope/configuration');expect(()=>verifyRecoveryOriginalProvenance(pair,{...provenance,configuration:recoveryDigest(Buffer.from('wrong configuration'))})).toThrow('signer/scope/configuration');
 expect(()=>verifyRecoveryOriginalProvenance(pair,{...provenance,genesis:recoveryDigest(Buffer.from('wrong genesis'))})).toThrow('signer/scope/configuration');expect(()=>verifyRecoveryOriginalProvenance(pair,{...provenance,context:recoveryDigest(Buffer.from('wrong context'))})).toThrow('signer/scope/configuration');
 const damaged=Buffer.from(retained.frame);damaged[damaged.length-1]^=1;expect(()=>parseOpaqueRecoveryObjectBytes(damaged)).toThrow();expect(()=>parseOpaqueRecoveryObjectBytes(Buffer.concat([retained.frame,Buffer.alloc(1)]))).toThrow('length/trailing');
 expect(()=>arenas[0].putPair({pair:{...pair,frame:damaged}})).toThrow();expect(()=>arenas[0].putPair({pair:{...pair,commitment:{...pair.commitment,frameDigest:`sha256:${'0'.repeat(64)}`}}})).toThrow('commitment');
 expect(()=>verifyRecoveryCapsule({...pair.capsule,proposal:`sha256:${'0'.repeat(64)}`},pair.frame)).toThrow();expect(()=>verifyRecoveryCapsule(pair.capsule,pair.frame,{proposal:`sha256:${'0'.repeat(64)}`})).toThrow('Invalid recovery capsule');
 const enrollment=createRecoveryRecipientEnrollment({material:recipientKey,signingKey:owner,role:'witness',genesis:binding.genesis,context:binding.context}),otherRecipientKey=await generateRecoveryRecipientKey();expect(verifyRecoveryRecipientEnrollment(enrollment).keyId).toBe(recipientKey.keyId);
 expect(()=>verifyRecoveryRecipientEnrollment({...enrollment,signature:'A'.repeat(86)})).toThrow();expect(()=>verifyRecoveryRecipientEnrollment({...enrollment,publicKey:otherRecipientKey.publicKey})).toThrow();
 expect(()=>selectInitialRecoveryPair({candidates:[pair,pair],original:binding,owner:storage.owner,proofId:id,kind:'original',enrollment})).toThrow('Multiple eligible');
 const repeated=await storage.preflight([{bytes:plaintext,kind:'original'}],4096);expect(repeated[0].frame).toEqual(pair.frame);expect(repeated[0].commitment).toEqual(pair.commitment);expect(repeated[0].capsuleBytes).toEqual(pair.capsuleBytes);expect(repeated[0].identity).toEqual(pair.identity);
 const before=arenas[0].usage();expect(await storage.put(plaintext,'original',repeated[0])).toBe(id);expect(arenas[0].usage()).toEqual(before);
 const alternate=prepareOpaqueRecoveryObject({plaintext,kind:'original',original:binding,signingKey:owner}),alternatePair=await createRecoveryCapsule({frame:alternate.frame,dek:alternate.dek,proposal:pair.capsule.proposal,exporter:owner,enrollment});alternate.dek.fill(0);
 expect(alternatePair.commitment.frameDigest).not.toBe(pair.commitment.frameDigest);expect(()=>arenas[0].putPair({pair:alternatePair})).toThrow('Conflicting frames');expect(arenas[0].usage()).toEqual(before);
 const validated=arenas[0].validatePair(pair,false),originalFirst=pair.frame[0];pair.frame[0]^=1;expect(validated.view.frame[0]).toBe(originalFirst);pair.frame[0]^=1;
 expect(arenas[0].putValidatedPair(validated.view,validated.operation)).toEqual(identity);closeRecoveryPairValidationOperation(validated.operation);
 expect(()=>arenas[0].putValidatedPair(validated.view,validated.operation)).toThrow('Stale');expect(arenas[0].usage()).toEqual(before);
 const mutated=arenas[0].validatePair(pair,false);mutated.view.frame[mutated.view.frame.length-1]^=1;expect(()=>arenas[0].putValidatedPair(mutated.view,mutated.operation)).toThrow('Mutated');closeRecoveryPairValidationOperation(mutated.operation);
 const cross=local.validatePair(pair,true);expect(()=>arenas[0].putValidatedPair(cross.view,cross.operation,randomBytes(32))).toThrow('Cross-arena');closeRecoveryPairValidationOperation(cross.operation);
 const wrongKey=arenas[0].validatePair(pair,true);expect(()=>arenas[0].putValidatedPair(wrongKey.view,wrongKey.operation)).toThrow('wrong-key');closeRecoveryPairValidationOperation(wrongKey.operation);
 expect(()=>arenas[0].putPair({pair:{...pair,identity:{...pair.identity,proofId:`sha256:${'0'.repeat(64)}`}}})).toThrow();expect(arenas[0].usage()).toEqual(before);
 expect(()=>arenas[0].preflightPairMetadata([{commitment:pair.commitment,identity:pair.identity,frameBytes:pair.frame.length+1,capsuleBytes:pair.capsuleBytes.length,initialKey:false}])).toThrow('metadata');expect(arenas[0].usage()).toEqual(before);
 storage.close();arenas.forEach(a=>a.close());local=openSustainableRecoveryArena({...localOptions,mode:'existing'});
 arenas=keys.map((_,i)=>openSustainableRecoveryArena({authority:f.authority,manifest:f.manifest,owner:'witness-0',copy:i+1,key:encryptionKeys[i],mode:'existing'}));arenas.forEach(a=>cleanup.push(a.close));
 replicas=keys.map((key,i)=>createSustainableRecoveryReplica({arena:arenas[i],scope,owner:Buffer.from(owner.publicKey).toString('base64url'),signingKey:key}));
 storage=openSustainableProtectedArena({arena:local,scope,signingKey:owner,recipientKey,replicas:replicas.map(r=>r.replica),transport});cleanup.push(storage.close);storage.configureOriginal(binding);expect(recoveryPairIdentity(arenas[0].getPair(identity))).toEqual(identity);
 const second=Buffer.from('second original'),preparedTwo=await storage.preflight([{bytes:second,kind:'original'}],4096),secondIdentity=recoveryPairIdentity(preparedTwo[0]);mode=1;
 await expect(storage.put(second,'original',preparedTwo[0])).rejects.toThrow('Four');mode=0;expect(await storage.put(second,'original',preparedTwo[0])).toBe(recoveryDigest(second));
 const row=f.manifest.owners.find(o=>o.owner==='witness-0')!,archiveStart=2*row.L+2*row.D+2*row.P,file=local.path+'/arena.bin',fd=openSync(file,'r+');writeSync(fd,Buffer.alloc(row.C),0,row.C,archiveStart);closeSync(fd);storage.close();
 local=openSustainableRecoveryArena({...localOptions,mode:'existing'});storage=openSustainableProtectedArena({arena:local,scope,signingKey:owner,recipientKey,replicas:replicas.map(r=>r.replica),transport:async(key,request)=>{
  const index=replicas.findIndex(r=>r.replica===key);if(mode===2&&index===0&&request.action==='object-read')return replicas[1].exchange({...request,frame:pair.frame.toString('base64url'),capsule:pair.capsuleBytes.toString('base64url'),commitment:pair.commitment,capsuleDigest:pair.capsuleDigest});return replicas[index].exchange(request);
 }});cleanup.push(storage.close);storage.configureOriginal(binding);
 expect(await storage.recoverProof(id,'original',identity)).toEqual(plaintext);mode=2;expect(await storage.recoverProof(recoveryDigest(second),'original',secondIdentity)).toEqual(second);mode=0;
 await storage.put(second,'original',preparedTwo[0]);expect(arenas.every(arena=>arena.pairStatus(secondIdentity).digest===secondIdentity.frameDigest)).toBe(true);
});

it('sustainable recovery transfers exact proofs old to disjoint and back with recipient-only recovery',async()=>{
 const f=setup(),binding={genesis:recoveryDigest(Buffer.from('transfer genesis')),configuration:recoveryDigest(Buffer.from('transfer configuration')),context:recoveryDigest(Buffer.from('transfer context'))};
 async function node(ownerName:string,signingKey:ReturnType<typeof generateSigningKeyPair>,recipientKey:Awaited<ReturnType<typeof generateRecoveryRecipientKey>>){
  const scope=recoveryDigest(Buffer.from(`endpoint:${ownerName}`)),localOptions={authority:f.authority,manifest:f.manifest,owner:ownerName,copy:0,key:randomBytes(32)};
  const local=openSustainableRecoveryArena({...localOptions,mode:'new'}),keys=Array.from({length:5},generateSigningKeyPair),arenas=keys.map((_,index)=>openSustainableRecoveryArena({authority:f.authority,manifest:f.manifest,owner:ownerName,copy:index+1,key:randomBytes(32),mode:'new'}));arenas.forEach(arena=>cleanup.push(arena.close));
  const replicas=keys.map((key,index)=>createSustainableRecoveryReplica({arena:arenas[index],scope,owner:Buffer.from(signingKey.publicKey).toString('base64url'),signingKey:key})),transport=async(key:string,request:any)=>replicas.find(replica=>replica.replica===key)!.exchange(request);
  const value={localOptions,scope,signingKey,recipientKey,replicas,transport,storage:openSustainableProtectedArena({arena:local,scope,signingKey,recipientKey,replicas:replicas.map(replica=>replica.replica),transport})};cleanup.push(()=>value.storage.close());value.storage.configureOriginal(binding);return value;
 }
 async function reopen(value:Awaited<ReturnType<typeof node>>){value.storage.close();const local=openSustainableRecoveryArena({...value.localOptions,mode:'existing'});value.storage=openSustainableProtectedArena({arena:local,scope:value.scope,signingKey:value.signingKey,recipientKey:value.recipientKey,replicas:value.replicas.map(replica=>replica.replica),transport:value.transport});value.storage.configureOriginal(binding);return value.storage;}
 const source=await node('witness-0',generateSigningKeyPair(),await generateRecoveryRecipientKey()),destination=await node('witness-5',generateSigningKeyPair(),await generateRecoveryRecipientKey());
 const plaintext=Buffer.from('exact proof through two recipient transfers'),prepared=await source.storage.preflight([{bytes:plaintext,kind:'original'}],4096),id=await source.storage.put(plaintext,'original',prepared[0]);
 const destinationEnrollment=createRecoveryRecipientEnrollment({material:destination.recipientKey,signingKey:destination.signingKey,role:'witness',genesis:binding.genesis,context:binding.context}),proposal=recoveryDigest(Buffer.from('old to disjoint'));
 const exported=(await source.storage.exportProofs([id],proposal,destinationEnrollment))[0],destinationIdentity=recoveryPairIdentity(exported.pair);expect(exported.pair.frame).toEqual(prepared[0].frame);expect(exported.pair.capsule.exporter).toBe(source.storage.owner);expect(exported.pair.capsule.recipient).toBe(destination.storage.owner);
 await expect(destination.storage.validateTransfer(exported,recoveryDigest(Buffer.from('cross proposal')),source.storage.owner)).rejects.toThrow();await expect(destination.storage.validateTransfer(exported,proposal,destination.storage.owner)).rejects.toThrow();
 await expect(destination.storage.validateTransfer({...exported,bytes:Buffer.from('changed plaintext').toString('base64url')},proposal,source.storage.owner)).rejects.toThrow();
 expect(await destination.storage.validateTransfer(exported,proposal,source.storage.owner)).toEqual(plaintext);const imported=await destination.storage.preflight([{bytes:plaintext,kind:'original',pair:exported.pair}],4096);await destination.storage.put(plaintext,'original',imported[0]);
 const usage=destination.replicas.map(replica=>replica.exchange({action:'object-status',scope:destination.scope,challenge:randomBytes(32).toString('base64url'),identity:destinationIdentity}));expect((await Promise.all(usage)).every(reply=>reply.proof?.digest===destinationIdentity.frameDigest&&reply.record===null)).toBe(true);
 await reopen(destination);const before=destination.replicas[0].exchange({action:'object-status',scope:destination.scope,challenge:randomBytes(32).toString('base64url'),identity:destinationIdentity});expect((await before).proof?.capsuleDigest).toBe(destinationIdentity.capsuleDigest);await destination.storage.put(plaintext,'original',imported[0]);
 destination.storage.close();const destinationRow=f.manifest.owners.find(owner=>owner.owner==='witness-5')!,destinationStart=2*destinationRow.L+2*destinationRow.D+2*destinationRow.P,destinationFd=openSync(join(f.manifest.root,'witness-5','local','arena.bin'),'r+');writeSync(destinationFd,Buffer.alloc(destinationRow.C),0,destinationRow.C,destinationStart);closeSync(destinationFd);await reopen(destination);
 expect(await destination.storage.recoverProof(id,'original',destinationIdentity)).toEqual(plaintext);
 const returningEnrollment=createRecoveryRecipientEnrollment({material:source.recipientKey,signingKey:source.signingKey,role:'witness',genesis:binding.genesis,context:binding.context}),returningProposal=recoveryDigest(Buffer.from('disjoint to returning'));
 const returned=(await destination.storage.exportProofs([id],returningProposal,returningEnrollment))[0],returnedIdentity=recoveryPairIdentity(returned.pair);expect(returned.pair.frame).toEqual(exported.pair.frame);expect(returned.pair.capsule.exporter).toBe(destination.storage.owner);expect(returned.pair.capsule.recipient).toBe(source.storage.owner);
 expect(await source.storage.validateTransfer(returned,returningProposal,destination.storage.owner)).toEqual(plaintext);const returnedPrepared=await source.storage.preflight([{bytes:plaintext,kind:'original',pair:returned.pair}],4096);await source.storage.put(plaintext,'original',returnedPrepared[0]);
 source.storage.close();const sourceRow=f.manifest.owners.find(owner=>owner.owner==='witness-0')!,sourceStart=2*sourceRow.L+2*sourceRow.D+2*sourceRow.P,sourceFd=openSync(join(f.manifest.root,'witness-0','local','arena.bin'),'r+');writeSync(sourceFd,Buffer.alloc(sourceRow.C),0,sourceRow.C,sourceStart);closeSync(sourceFd);await reopen(source);
 expect(await source.storage.recoverProof(id,'original',returnedIdentity)).toEqual(plaintext);
});
