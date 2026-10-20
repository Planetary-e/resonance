/** Run a COPY of this probe from the frozen 04c86f6 producer checkout.
 * External package dependencies may be shared, but @resonance package symlinks
 * must resolve inside that producer. COMPAT_CONSUMER_ROOT selects the candidate.
 * BASELINE.json contains the full producer commit and SHA256 files manifest.
 * Artifacts contain TEST ONLY keys, are private, and must not be committed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { protectedIssuerRestoreFixture } from '../packages/node/src/__tests__/fixtures/protected-issuer-restore-fixture.ts';
import * as oldRecovery from '../packages/node/src/admission-issuer-recovery.ts';
import * as oldOwner from '../packages/node/src/protected-admission-issuer-ledger.ts';
import { createAdmissionIssuanceBatch } from '../packages/node/src/blind-admission-issuance.ts';
import { openEncryptedLocalState } from '@resonance/core/local-state';
const current = process.env.COMPAT_CONSUMER_ROOT;
if (!current) throw new Error('Set COMPAT_CONSUMER_ROOT to the independently checked-out candidate');
const fresh = await import(pathToFileURL(join(current, 'packages/node/src/admission-issuer-recovery.ts')).href);
const freshOwner = await import(pathToFileURL(join(current, 'packages/node/src/protected-admission-issuer-ledger.ts')).href);
const out = fs.mkdtempSync('/tmp/resonance-issuer-compat-04c86f6-'); fs.chmodSync(out,0o700);
const cleanup: Array<()=>void|Promise<void>>=[]; const records:any[]=[];
const save=(name:string,value:unknown)=>fs.writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2),{mode:0o600});
function hashes(path:string):Record<string,string> {
 if(!fs.existsSync(path))return {};
 if(fs.statSync(path).isFile())return {'.':createHash('sha256').update(fs.readFileSync(path)).digest('hex')};
 const result:Record<string,string>={};
 for(const name of fs.readdirSync(path).sort())for(const [child,hash] of Object.entries(hashes(join(path,name))))result[child==='.'?name:name+'/'+child]=hash;
 return result;
}
function copy(from:string,to:string){fs.cpSync(from,to,{recursive:true});}
function replace(from:string,to:string){fs.rmSync(to,{recursive:true,force:true});copy(from,to);}
try {
 const n=await protectedIssuerRestoreFixture(close=>cleanup.push(close)); await n.ledger.ready();
 const assignment=await n.assign(), permit=await n.ledger.grantForAssignment(assignment,n.proof());
 const batch=await createAdmissionIssuanceBatch(n.profile,1),response=await n.ledger.approve(permit,batch.request,n.proof());
 const pendingAssignment=await n.assign();n.online(3);
 await assert.rejects(n.ledger.grantForAssignment(pendingAssignment,n.proof()));assert.equal(n.ledger.status().protection.pending,true);n.online(5);n.ledger.close();
 const sourceBackup=join(out,'source-before-fence');copy(join(n.directory,'owner'),sourceBackup);
 const opts={directory:join(n.directory,'recovery'),context:n.context,genesis:n.genesis,profile:n.profile,authority:n.authority,
  signingKey:n.options.protection.signingKey,encryptionKey:n.key,members:n.members,timeoutMs:10000};
 save('pins',{directory:n.directory,opts,ownerOptions:{...n.options,privateKey:undefined,now:undefined},privateKey:n.issuerPrivateKey.export({type:'pkcs8',format:'pem'}),assignment,permit,response,pendingAssignment});
 const unavailableOpts={...opts,directory:join(n.directory,'unavailable-review')};
 let owner=await oldOwner.openProtectedAdmissionIssuerLedger(n.options);
 const capturedSource=await owner.reviewRecoverySource();const capturedEvidence=oldOwner.readProtectedIssuerRecoverySource(capturedSource);assert.equal(capturedEvidence.minimumEvidence.length,2);assert.ok(capturedEvidence.pending);
 const oldAvailable=await oldRecovery.prepareProtectedIssuerRecovery({...opts,source:capturedSource});
 const oldUnavailable=await oldRecovery.prepareProtectedIssuerRecovery({...unavailableOpts,source:'unavailable'});
 save('old-available-review',oldAvailable);save('old-unavailable-review',oldUnavailable);
 let recovery=await oldRecovery.openProtectedIssuerRecovery({...opts,initialize:{review:oldAvailable,approvedDigest:oldAvailable.approvalDigest}});
 const oldInitialStatus=recovery.status();recovery.close();owner.close();
 const initial=join(out,'old-initial');copy(opts.directory,initial);
 async function readCheck(label:string,module:any,options=opts){
  const before=hashes(options.directory);const h=await module.openProtectedIssuerRecovery(options);const status=h.status();h.close();
  assert.deepEqual(hashes(options.directory),before,label+' must not rewrite files');records.push({label,status,hashes:before});return status;
 }
 assert.deepEqual(await readCheck('new reads old initial',fresh),oldInitialStatus);
 replace(sourceBackup,join(n.directory,'owner'));fs.rmSync(opts.directory,{recursive:true});
 owner=await freshOwner.openProtectedAdmissionIssuerLedger(n.options);
 const newAvailable=await fresh.prepareProtectedIssuerRecovery({...opts,source:await owner.reviewRecoverySource()});
 assert.equal(JSON.stringify(newAvailable),JSON.stringify(oldAvailable));
 await assert.rejects(fresh.openProtectedIssuerRecovery({...opts,initialize:{review:structuredClone(newAvailable),approvedDigest:oldAvailable.approvalDigest}}));
 recovery=await fresh.openProtectedIssuerRecovery({...opts,initialize:{review:newAvailable,approvedDigest:oldAvailable.approvalDigest}});recovery.close();owner.close();
 assert.deepEqual(await readCheck('old reads new initial',oldRecovery),oldInitialStatus);
 const newUnavailable=await fresh.prepareProtectedIssuerRecovery({...unavailableOpts,source:'unavailable'});
 assert.equal(JSON.stringify(newUnavailable),JSON.stringify(oldUnavailable));
 const unavailable=await fresh.openProtectedIssuerRecovery({...unavailableOpts,initialize:{review:newUnavailable,approvedDigest:oldUnavailable.approvalDigest}});unavailable.close();
 await readCheck('old reads new unavailable initial',oldRecovery,unavailableOpts);
 replace(initial,opts.directory);
 const journal=join(fs.realpathSync(opts.directory),oldRecovery.PROTECTED_ISSUER_RECOVERY_FILENAME);
 function plaintext(){const state=openEncryptedLocalState<any>({path:journal,key:n.key,domain:'resonance:admission-issuer-recovery:v1',mode:'open-existing',initial:undefined,maxBytes:48*1024*1024,validate:(v:unknown):v is any=>true});try{return JSON.stringify(state.read());}finally{state.close();}}
 const originalRename=fs.renameSync;let hits=0;
 recovery=await oldRecovery.openProtectedIssuerRecovery(opts);
 fs.renameSync=(from,to)=>{if(String(to)===journal&&++hits===2)throw Error('compatibility checkpoint before registration');originalRename(from,to);};syncBuiltinESMExports();
 try{await assert.rejects(recovery.advance(),/compatibility checkpoint/);}finally{fs.renameSync=originalRename;syncBuiltinESMExports();recovery.close();}
 const creating=join(out,'old-creating-unregistered');copy(opts.directory,creating);save('old-creating-plaintext',plaintext());
 await readCheck('new reads old creating component',fresh);
 const phases:any[]=[];
 for(let step=0;step<8;step++){
  recovery=await oldRecovery.openProtectedIssuerRecovery(opts);const status=await recovery.advance({maxBlocks:10001});recovery.close();
  const snapshot=join(out,`old-phase-${step}`);copy(opts.directory,snapshot);const plain=plaintext();save(`old-phase-${step}-plaintext`,plain);
  assert.deepEqual(await readCheck(`new reads old phase ${step}`,fresh),status);
  assert.equal(plaintext(),plain);phases.push({step,status,snapshot});
  if(status.phase==='download-and-confirm'||status.phase==='provision'){
   recovery=await fresh.openProtectedIssuerRecovery(opts);await recovery.advance({maxBlocks:10001});recovery.close();
   await readCheck('old reads new advancement from '+status.phase,oldRecovery);
   // Download is read-only remotely; provisioning the same certified root is idempotent.
   // Restore the old artifact before the old producer's next step, without asking
   // an already activated generation to conduct agreement confirmation again.
   replace(snapshot,opts.directory);
  }
  if(status.complete)break;
 }
 assert.equal(phases.at(-1).status.complete,true);const complete=phases.at(-1).snapshot;
 replace(complete,opts.directory);
 const destination={path:join(n.directory,'restored.json'),writerDirectory:join(n.directory,'restored.history')};
 recovery=await oldRecovery.openProtectedIssuerRecovery(opts);const oldRestore=await recovery.reviewRestore(destination);recovery.close();
 save('old-restore-review',oldRestore.preparation.review);
 recovery=await fresh.openProtectedIssuerRecovery(opts);const newRestore=await recovery.reviewRestore(destination);recovery.close();
 assert.equal(JSON.stringify(newRestore.preparation.review),JSON.stringify(oldRestore.preparation.review));
 const restored=await freshOwner.openProtectedAdmissionIssuerLedger({...n.options,path:destination.path,protection:{...n.options.protection,writerDirectory:destination.writerDirectory,initializeWriter:true,initializeArchive:true},restore:{preparation:newRestore.preparation,approvedDigest:oldRestore.preparation.review.approvalDigest}});restored.close();
 const ownerBytes=fs.readFileSync(destination.path);const writerBackup=join(out,'restored-writer');copy(destination.writerDirectory,writerBackup);
 for(const state of ['owner-only','owner-and-writer','complete-unapplied']){
  fs.writeFileSync(destination.path,ownerBytes);fs.rmSync(destination.writerDirectory,{recursive:true,force:true});
  if(state!=='owner-only'){copy(writerBackup,destination.writerDirectory);if(state==='owner-and-writer')fs.rmSync(join(destination.writerDirectory,'payloads'),{recursive:true});}
  recovery=await oldRecovery.openProtectedIssuerRecovery(opts);let resume=await recovery.reviewResumption(destination,{privateKey:n.privateKey});const oldReview=resume.review();resume.close();recovery.close();save('old-resumption-'+state,oldReview);
  const before=[hashes(destination.path),hashes(destination.writerDirectory),hashes(opts.directory)];
  recovery=await fresh.openProtectedIssuerRecovery(opts);resume=await recovery.reviewResumption(destination,{privateKey:n.privateKey});const newReview=resume.review();
  assert.equal(JSON.stringify(newReview),JSON.stringify(oldReview));
  resume.close();recovery.close();assert.deepEqual([hashes(destination.path),hashes(destination.writerDirectory),hashes(opts.directory)],before);
  recovery=await fresh.openProtectedIssuerRecovery(opts);resume=await recovery.reviewResumption(destination,{privateKey:n.privateKey});
  const result=await resume.apply(oldReview.approvalDigest);assert.equal(result.readiness,'unverified');resume.close();recovery.close();
  records.push({label:'old resumption digest accepted for '+state,before,after:[hashes(destination.path),hashes(destination.writerDirectory)]});
 }
 const occupiedBefore=[hashes(destination.path),hashes(destination.writerDirectory),hashes(opts.directory)];
 recovery=await oldRecovery.openProtectedIssuerRecovery(opts);const oldInspected=await recovery.inspectRestored(destination);recovery.close();
 recovery=await fresh.openProtectedIssuerRecovery(opts);const newInspected=await recovery.inspectRestored(destination);recovery.close();assert.deepEqual(newInspected,oldInspected);
 assert.deepEqual([hashes(destination.path),hashes(destination.writerDirectory),hashes(opts.directory)],occupiedBefore);
 owner=await freshOwner.openProtectedAdmissionIssuerLedger({...n.options,path:destination.path,protection:{...n.options.protection,writerDirectory:destination.writerDirectory}});
 await owner.ready();assert.deepEqual(await owner.grantForAssignment(assignment,n.proofFor(owner)),permit);assert.deepEqual(await owner.approve(permit,batch.request,n.proofFor(owner)),response);assert.equal(owner.status().allocatedPermits,2);owner.close();
 const provenance=JSON.parse(fs.readFileSync(new URL('../BASELINE.json',import.meta.url),'utf8'));for(const [file,expected] of Object.entries(provenance.files))assert.equal(createHash('sha256').update(fs.readFileSync(new URL('../'+file,import.meta.url))).digest('hex'),expected);
 save('RESULT',{producer:'04c86f6',consumer:current,result:'PASS',checks:records,phases});
 console.log(JSON.stringify({result:'PASS',artifacts:out,readChecks:records.length,phases:phases.length,reviewMatches:6,retainedPermits:2}));
}finally{for(const close of cleanup.reverse())await close();}
