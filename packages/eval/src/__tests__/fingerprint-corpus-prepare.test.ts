import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesHash, evaluateJudgedQuality } from '../fingerprint-judgments.js';
import { prepareCorpus, prepareFromFiles, PREPARATION_SEED, type PreparationManifest } from '../fingerprint-corpus-prepare.js';
function fixture() {
  const data = new Map<string, string>();
  const files: PreparationManifest['files'] = [];
  for (const language of ['en','es'] as const) {
    const passages = [{query_id:'1',query:`${language} query1`,positive_passages:[{docid:'1#0',text:`${language} pos`,title:'A'}],negative_passages:[{docid:'2#0',text:`${language} neg`,title:'B'}]}, {query_id:'2',query:`${language} query2`,positive_passages:[{docid:'2#1',text:`${language} next`,title:'B'}],negative_passages:[]}];
    for (const [kind, text] of [['topics',`1\t${language} query1\n2\t${language} query2\n`],['qrels','1 Q0 1#0 1\n1 Q0 2#0 0\n2 Q0 2#1 1\n'],['passages',passages.map(p=>JSON.stringify(p)).join('\n')]] as const) {
      const path=`${language}-${kind}`;data.set(path,text);files.push({path,language,kind,url:'https://example.org/source',revision:'a'.repeat(40),bytes:Buffer.byteLength(text),sha256:bytesHash(text)});
    }
  }
  const manifest: PreparationManifest={version:1,files,frozenAt:'2026-10-22T15:00:00Z',testOpenedAtPlan:'2026-10-23T15:00:00Z',candidateThreshold:.75};
  const run=()=>prepareCorpus(manifest,s=>data.get(s.path)!);
  const alter=(path:string,fn:(s:string)=>string)=>{const text=fn(data.get(path)!);data.set(path,text);Object.assign(files.find(f=>f.path===path)!,{bytes:Buffer.byteLength(text),sha256:bytesHash(text)});};
  return {manifest,data,run,alter};
}
describe('bounded MIRACL diagnostic corpus preparation',()=>{
 it('preserves every positive/negative and namespaced IDs deterministically',()=>{const f=fixture(),r=f.run();expect(r).toEqual(f.run());expect(r.receipt.seed).toBe(PREPARATION_SEED);expect(r.allJudgments.filter(j=>j.relevant)).toHaveLength(4);expect(r.allJudgments.filter(j=>!j.relevant)).toHaveLength(2);expect(new Set(r.input.corpus.queries.map(q=>q.id)).size).toBe(4);expect(r.receipt.totals.testJudgments+r.receipt.totals.excludedDevelopmentJudgments).toBe(6);expect(r.input.predictions.rows).toEqual([]);expect(evaluateJudgedQuality(JSON.stringify(r.config),JSON.stringify(r.input),r.receipt.hashes.config).k5Qualified).toBe(false);});
 it('keeps article siblings and qrel-linked queries in one component',()=>{const r=fixture().run();for(const language of ['en','es'])expect(new Set([...r.input.corpus.queries,...r.input.corpus.publications].filter(x=>x.language===language).map(x=>x.topicGroup)).size).toBe(1);});
 it('joins normalized exact text across languages conservatively',()=>{const f=fixture();f.alter('es-passages',s=>s.replace('es pos','en pos'));const r=f.run();expect(new Set(r.input.corpus.queries.map(q=>q.topicGroup)).size).toBe(1);});
 it.each(['missing','duplicate','conflict','unknown'] as const)('rejects %s annotated judgment',kind=>{const f=fixture();f.alter('en-passages',s=>{const a=s.split('\n').map(x=>JSON.parse(x));if(kind==='missing')a[0].negative_passages=[];if(kind==='duplicate')a[0].positive_passages.push(a[0].positive_passages[0]);if(kind==='conflict')a[0].negative_passages[0].docid='1#0';if(kind==='unknown')a[0].positive_passages[0].docid='99#0';return a.map(x=>JSON.stringify(x)).join('\n');});expect(f.run).toThrow();});
 it('rejects conflicting text/title on repeated document',()=>{const f=fixture();f.alter('en-qrels',s=>s+'2 Q0 1#0 0\n');f.alter('en-passages',s=>{const a=s.split('\n').map(x=>JSON.parse(x));a[1].negative_passages=[{docid:'1#0',text:'different',title:'A'}];return a.map(x=>JSON.stringify(x)).join('\n');});expect(f.run).toThrow('Conflicting passage');});
 it('rejects duplicate qrels and nonbinary grades',()=>{for(const suffix of ['1 Q0 1#0 1\n','1 Q0 3#0 NaN\n']){const f=fixture();f.alter('en-qrels',s=>s+suffix);expect(f.run).toThrow();}});
 it('rejects substituted bytes, oversized source, missing source',()=>{const f=fixture();f.data.set('en-topics','substituted');expect(f.run).toThrow('hash/size');f.manifest.files[0].bytes=33*1024*1024;expect(f.run).toThrow('size');const missing=fixture();missing.manifest.files.pop();expect(missing.run).toThrow('Missing es/passages');});
 it('rejects invalid planned opening and threshold',()=>{const f=fixture();f.manifest.candidateThreshold=NaN;expect(f.run).toThrow('threshold');f.manifest.candidateThreshold=.5;f.manifest.testOpenedAtPlan=f.manifest.frozenAt;expect(f.run).toThrow('Opening');});
 it('CLI helper refuses existing output without modifying it',()=>{const f=fixture(),dir=mkdtempSync(join(tmpdir(),'k5-prepare-test-'));for(const source of f.manifest.files){const text=f.data.get(source.path)!;source.path=join(dir,source.path);writeFileSync(source.path,text);}const mp=join(dir,'manifest.json'),out=join(dir,'prepared');writeFileSync(mp,JSON.stringify(f.manifest));prepareFromFiles(mp,out,bytesHash(JSON.stringify(f.manifest)));expect(()=>prepareFromFiles(mp,join(dir,'substitution'),'0'.repeat(64))).toThrow('manifest digest');const before=readFileSync(join(out,'input.json'),'utf8');expect(()=>prepareFromFiles(mp,out,bytesHash(JSON.stringify(f.manifest)))).toThrow();expect(readFileSync(join(out,'input.json'),'utf8')).toBe(before);});
});
