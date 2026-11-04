import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicationRecord, generatePublicationKeyMaterial, generateIdentity, createMatchOperationV2, createMatchNoticeMessage, decodeBase64 } from '@resonance/core';
import { openStoreAsync } from '../../../node/src/store.js';
import { MatchingEngine } from '../../../relay/src/matching-engine.js';
import { bytesHash, contentHash, topicSplit, type CorpusRow, type JudgedQualityInput } from '../fingerprint-judgments.js';
import { captureEvaluationInbox, exportActualPredictions, type ActualManifest, type ActualCapture } from '../fingerprint-actual-export.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'k5-actual-'));
  const store = await openStoreAsync(join(dir, 'fixture.db'), new Uint8Array(32).fill(7));
  const start = Date.now() - 1000, end = start + 2000;
  const seed = 'actual-k5';
  const group = Array.from({length:100}, (_,i)=>`topic-${i}`).find(g=>topicSplit(seed,g)==='test')!;
  const corpusRow = (id:string, language:'es'|'en'): CorpusRow => ({id,language,text:`synthetic ${language} ${id}`,topicGroup:group,paraphraseGroup:id,split:'test'});
  const input: JudgedQualityInput = { version:1, corpus:{queries:['es','en'].map(l=>corpusRow(`${l}-q`,l as 'es'|'en')), publications:['es','en'].flatMap(l=>[1,2].map(i=>corpusRow(`${l}-p${i}`,l as 'es'|'en')))}, judgments:['es','en'].flatMap(l=>[{queryId:`${l}-q`,publicationId:`${l}-p1`,relevant:true},{queryId:`${l}-q`,publicationId:`${l}-p2`,relevant:false}]), provenance:{assessor:'synthetic fixture',method:'hand computed; no relevance qualification',independentOfEmbeddings:false,fixtureOnly:true,positiveInventoryComplete:true}, predictions:{generatedAt:new Date(end).toISOString(),configSha256:'',pipeline:'empty base awaiting actual export',rows:[]} };
  const configBytes=JSON.stringify({version:1,frozenAt:new Date(start-2000).toISOString(),testOpenedAt:new Date(start-1000).toISOString(),seed,candidateThreshold:.7,corpusSha256:contentHash(input.corpus),judgmentsSha256:contentHash(input.judgments)});
  const configSha=bytesHash(configBytes); input.predictions.configSha256=configSha;
  const manifest: ActualManifest={version:1,runId:'synthetic-actual-v1',configSha256:configSha,frozenAt:new Date(start-2000).toISOString(),designatedEvaluationCorpus:true,codeSha256:'a'.repeat(64),modelSha256:'b'.repeat(64),scope:{groupId:'public',algorithm:'random-hyperplane-lsh',bits:512,epoch:'fixture-v1'},window:{start:new Date(start).toISOString(),end:new Date(end).toISOString()},bindings:[]};
  const engine=new MatchingEngine({matchThreshold:.7});
  for(const language of ['es','en'] as const) {
    // Distinct fingerprints keep the bilingual searches separate without fake scoring.
    for(const [suffix,type,fill] of [['q','need',language==='es'?0:255],['p1','offer',language==='es'?0:255],['p2','offer',language==='es'?1:254]] as const) {
      const keys=generatePublicationKeyMaterial(),record=createPublicationRecord({groupId:'public',fingerprintEpoch:'fixture-v1',fingerprint:new Uint8Array(64).fill(fill),itemType:type,createdAt:start-5000,expiresAt:end+60000},keys);
      manifest.bindings.push({role:suffix==='q'?'query':'publication',corpusId:`${language}-${suffix}`,record});
      if(suffix==='q') {store.insertItem({id:`${language}-item`,type,rawText:`synthetic ${language} query`,embedding:new Float32Array([1]),privacyLevel:'medium'});store.insertPublication(`${language}-item`,record,keys);}
      else engine.insertAndMatch(decodeBase64(record.fingerprint.value),{did:record.publicationId,itemId:record.publicationId,itemType:type,scope:'fixture-scope',expiresAt:record.expiresAt},10,.7,false,false);
    }
  }
  // The real store suppresses a signed match between this device's own items.
  const qOwn=manifest.bindings[0].record,ownKeys=generatePublicationKeyMaterial();
  const own=createPublicationRecord({groupId:'public',fingerprintEpoch:'fixture-v1',fingerprint:decodeBase64(qOwn.fingerprint.value),itemType:'offer',createdAt:start-5000,expiresAt:end+60000},ownKeys);
  store.insertItem({id:'own-offer',type:'offer',rawText:'synthetic own item',embedding:new Float32Array([1]),privacyLevel:'medium'});store.insertPublication('own-offer',own,ownKeys);
  const ownRelay=generateIdentity();
  expect(store.insertMailboxMatch('es-item',createMatchNoticeMessage(qOwn,own,createMatchOperationV2(qOwn,own,ownRelay,{createdAt:start+1,expiresAt:end+1000}),ownRelay))).toBe(false);
  const manifestBytes=JSON.stringify(manifest),manifestSha=bytesHash(manifestBytes);
  const baseline=captureEvaluationInbox(store,manifest,manifestSha,manifest.window.start,true);
  for(const language of ['es','en']) {
    const q=manifest.bindings.find(b=>b.corpusId===`${language}-q`)!.record,p=manifest.bindings.find(b=>b.corpusId===`${language}-p1`)!.record;
    const relay=generateIdentity(),notice=createMatchNoticeMessage(q,p,createMatchOperationV2(q,p,relay,{createdAt:start+1,expiresAt:end+1000}),relay);
    expect(store.insertMailboxMatch(`${language}-item`,notice)).toBe(true);
    expect(store.insertMailboxMatch(`${language}-item`,notice)).toBe(false);
    const relay2=generateIdentity(),notice2=createMatchNoticeMessage(q,p,createMatchOperationV2(q,p,relay2,{createdAt:start+2,expiresAt:end+1000}),relay2);
    expect(store.insertMailboxMatch(`${language}-item`,notice2)).toBe(false);
  }
  const capture:ActualCapture={version:1,runId:manifest.runId,manifestSha256:manifestSha,baseline,end:captureEvaluationInbox(store,manifest,manifestSha,manifest.window.end,true),searches:manifest.bindings.filter(b=>b.role==='query').map(q=>({queryId:q.corpusId,eventKind:'ephemeral-search',observedAt:new Date(start+10).toISOString(),threshold:.7,k:5,results:engine.search(decodeBase64(q.record.fingerprint.value),q.record.itemType,5,.7,'fixture-scope')}))};
  store.close();rmSync(dir,{recursive:true,force:true});
  const run=()=>exportActualPredictions(configBytes,JSON.stringify(input),JSON.stringify(manifest),JSON.stringify(capture),configSha,manifestSha);
  return {run,manifest,capture,input,configBytes,configSha,manifestBytes,manifestSha};
}

describe('actual v2 snapshot exporter',()=>{
  it('joins bilingual actual search scores with durable store delta and duplicate-relay suppression',async()=>{
    const f=await fixture(),r=f.run();
    expect(r.input.predictions.rows).toHaveLength(4);
    for(const language of r.report.languages) {
      expect(language.notificationCount).toBe(1);
      expect(language.notifiedPrecisionJudgedOnly.value).toBe(1);
      expect(language.recallAt5KnownPositives.value).toBe(1);
      expect(language.knownNegativePairsWithDecisions).toBe(0);
      expect(language.notifiedFalsePositiveRateKnownNegatives.value).toBeNull();
      expect(language.candidateFalsePositiveRateKnownNegatives.value).toBe(1);
    }
    expect(r.input.predictions.rows.filter(p=>p.notified===null)).toHaveLength(2);
    expect(r.complete).toBe(false);expect(r.k5Qualified).toBe(false);
    const out=process.env.K5_ACTUAL_FIXTURE_OUT;
    if(out) for(const [name,value] of Object.entries({config:f.configBytes,input:JSON.stringify(f.input),manifest:f.manifestBytes,capture:JSON.stringify(f.capture),export:JSON.stringify(r)})) writeFileSync(join(out,`${name}.json`),value,{flag:'wx'});
  });
  it('baseline notices are never recounted; absent/cancelled/failed negatives remain unknown',async()=>{
    const f=await fixture();f.capture.baseline.notices=f.capture.end.notices;
    expect(f.run().input.predictions.rows.every(r=>r.notified===null)).toBe(true);
  });
  it.each(['run','window','score','foreign','kind','duplicate','missing-score','duplicate-notice','lost-baseline'])('refuses %s capture substitution',async kind=>{
    const f=await fixture();
    if(kind==='run')f.capture.runId='old-run';
    if(kind==='window')f.capture.end.capturedAt=f.manifest.window.start;
    if(kind==='score')f.capture.searches[0].results[0].similarity=.99;
    if(kind==='foreign')f.capture.searches[0].results[0].did='foreign-publication';
    if(kind==='kind')(f.capture.searches[0] as any).eventKind='publication-match';
    if(kind==='duplicate')f.capture.searches.push(f.capture.searches[0]);
    if(kind==='missing-score')f.capture.searches[0].results=[];
    if(kind==='duplicate-notice')f.capture.end.notices.push(f.capture.end.notices[0]);
    if(kind==='lost-baseline'){f.capture.baseline.notices=f.capture.end.notices;f.capture.end.notices=[];}
    expect(()=>f.run()).toThrow();
  });
  it.each(['epoch','revision','duplicate','corpus','model'])('refuses pinned %s manifest substitution',async kind=>{
    const f=await fixture();
    if(kind==='epoch')f.manifest.scope.epoch='other';
    if(kind==='revision')f.manifest.bindings[0].record.sequence++;
    if(kind==='duplicate')f.manifest.bindings.push(f.manifest.bindings[0]);
    if(kind==='corpus')f.manifest.bindings[0].corpusId='unfrozen';
    if(kind==='model')f.manifest.modelSha256='c'.repeat(64);
    expect(()=>f.run()).toThrow(/manifest digest/);
    // Repinning cannot authorize ambiguous mapping, a false signature, or foreign scope.
    if(kind!=='model') {
      const sha=bytesHash(JSON.stringify(f.manifest));f.capture.manifestSha256=sha;f.capture.baseline.manifestSha256=sha;f.capture.end.manifestSha256=sha;
      expect(()=>exportActualPredictions(f.configBytes,JSON.stringify(f.input),JSON.stringify(f.manifest),JSON.stringify(f.capture),f.configSha,sha)).toThrow(/scope|signed|Ambiguous|held-out/);
    }
  });
  it('an empty completed snapshot cannot invent false decisions for scored negative candidates',async()=>{
    const f=await fixture();f.capture.end.notices=[];
    const r=f.run();expect(r.input.predictions.rows.every(p=>p.notified===null)).toBe(true);
    expect(r.report.languages.every(l=>l.notifiedFalsePositiveRateKnownNegatives.value===null)).toBe(true);
  });
  it('rejects unexpected capture fields rather than propagating private data',async()=>{
    const f=await fixture();(f.capture as any).privateText='must not propagate';expect(()=>f.run()).toThrow(/schema keys/);
  });
  it('requires opt-in before consulting a store',()=>{
    expect(()=>captureEvaluationInbox({listMailboxMatches(){throw new Error('must not read');}},{} as any,'','',false)).toThrow(/opt-in/);
  });
});
