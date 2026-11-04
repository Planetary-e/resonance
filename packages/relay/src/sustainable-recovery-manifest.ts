/** Explicit experimental finite physical contract. No business readiness follows
 * from this resource check. It uses the existing monotone authority unchanged. */
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { openStorageReservationAuthority, StorageReservationRequest } from '@resonance/core/storage-reservations';

export const SUSTAINABLE_RECOVERY_LIMITS = Object.freeze({ bytes: 2 * 1024 ** 3, entries: 512,
  metadata: 1024 ** 2, operationWork: 26611731, work: 1016959841, liveMs: 3000, offlineMs: 30000 });
export type RecoveryProofKind = 'original' | 'frame' | 'policy' | 'activation';
export interface RecoveryProofClosure {
  original:{count:number;bytes:number}; frame:{count:number;bytes:number};
  policy:{count:number;maximumBytes:number}; activation:{count:number;maximumBytes:number};
}
// Binary signed opaque object + both AEAD envelopes + archive header, including
// longest kind-qualified scope. This is an upper bound, never logical bytes alone.
export const RECOVERY_OBJECT_OVERHEAD = 600;
export interface RecoveryOwnerEnvelope {
  owner: string; role: 'observer' | 'witness' | 'issuer' | 'wallet';
  /** Complete physical encoded maxima, including encryption/framing. */
  L: number; D: number; P: number; C: number; F: number; closure:RecoveryProofClosure;
}
export interface RecoveryOriginal {
  /** Exact immutable encoded bytes, including original signature domain. */
  id: string; owner: string; privacyScope: string; bytes: number;
}
export interface RecoveryAllocationManifest {
  version: 1; root: string; transitions: number; returns: number;
  owners: RecoveryOwnerEnvelope[]; operatorCopies: number;
  originals: RecoveryOriginal[];
  /** Every retained outside allocation must be supplied, even on fresh bootstrap. */
  outside: StorageReservationRequest[];
  /** Selected closure maxima, in physical bytes, for one cumulative operation. */
  work: { L: number; D: number; V: number; H: number; J: number };
}
const safe = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const add = (...values: number[]) => { const n = values.reduce((a,b) => a+b, 0); if (!safe(n)) throw new Error('Recovery envelope counter overflow'); return n; };
const fields = (v: unknown, names: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...names].sort().join(',');

export function compileSustainableRecoveryManifest(value: RecoveryAllocationManifest) {
  if (!fields(value, ['version','root','transitions','returns','owners','operatorCopies','originals','outside','work'])
    || value.version !== 1 || typeof value.root !== 'string' || !isAbsolute(value.root) || resolve(value.root) !== value.root
    || !safe(value.transitions) || !safe(value.returns) || value.returns % 5 !== 0 || !safe(value.operatorCopies)
    || !Array.isArray(value.owners) || value.owners.length !== 17 || !Array.isArray(value.originals) || !Array.isArray(value.outside)
    || !fields(value.work, ['L','D','V','H','J']) || !Object.values(value.work).every(safe)) throw new Error('Unknown or invalid finite recovery envelope');
  const byRole = { observer: 0, witness: 0, issuer: 0, wallet: 0 }, names = new Set<string>();
  const requests: StorageReservationRequest[] = [];
  let witness = 0;
  for (const row of value.owners) {
    if (!fields(row, ['owner','role','L','D','P','C','F','closure']) || typeof row.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.owner)
      || names.has(row.owner) || !Object.hasOwn(byRole,row.role) || ![row.L,row.D,row.P,row.C,row.F].every(safe)
      || row.D < 32 * 16384) throw new Error('Unknown or invalid owner physical maxima');
    if(!fields(row.closure,['original','frame','policy','activation']))throw new Error('UNKNOWN prospective proof closure');
    for(const kind of ['original','frame','policy','activation'] as const){const budget=row.closure[kind];
      if(!fields(budget,['count',kind==='original'||kind==='frame'?'bytes':'maximumBytes'])||!Object.values(budget).every(safe))throw new Error('UNKNOWN prospective proof closure');}
    if(row.closure.policy.count<value.transitions||row.closure.activation.count<value.transitions
      ||row.closure.policy.maximumBytes<1||row.closure.activation.maximumBytes<1)throw new Error('Incomplete future installation closure');
    const physical=add(row.closure.original.bytes,row.closure.frame.bytes,
      row.closure.policy.count*row.closure.policy.maximumBytes,row.closure.activation.count*row.closure.activation.maximumBytes,
      RECOVERY_OBJECT_OVERHEAD*add(...(['original','frame','policy','activation'] as const).map(k=>row.closure[k].count)));
    if(physical>row.C)throw new Error(`Complete prospective opaque proof closure exceeds C: owner=${row.owner} required=${physical} limit=${row.C}`);
    names.add(row.owner); byRole[row.role]++;
    const returning = row.role === 'witness' && witness++ < 5 ? value.returns / 5 : 0;
    const K = 16384 * add(value.transitions, returning, 2);
    const maximumBytes = add(8192, 2*row.L, 2*row.D, 2*row.P, row.C, row.F, K);
    const count = row.role === 'wallet' ? 1 : 6;
    for (let copy = 0; copy < count; copy++) requests.push({ path: join(value.root, row.owner, copy === 0 ? 'local' : `replica-${copy}`),
      component: 'sustainable-recovery-arena-v1', scope: 'directory', maximumBytes });
  }
  if (byRole.observer !== 5 || byRole.witness !== 10 || byRole.issuer !== 1 || byRole.wallet !== 1) throw new Error('Finite recovery physical inventory differs from reviewed 98 scopes');
  requests.push({ path: join(value.root,'operator'), component: 'sustainable-recovery-arena-v1', scope: 'directory',
    maximumBytes: add(8192, value.operatorCopies, 16384 * add(value.transitions,value.returns,2)) });
  if (requests.length !== 98) throw new Error('Invalid recovery scope inventory');
  if(requests.some(request=>Buffer.byteLength(JSON.stringify(request))>1024))throw new Error('Recovery scope metadata exceeds declared 1024-byte bound');
  const objects = new Set<string>(), perOwner = new Map<string, number>(), originalCounts=new Map<string,number>();
  for (const object of value.originals) {
    if (!fields(object,['id','owner','privacyScope','bytes']) || !/^sha256:[a-f0-9]{64}$/.test(object.id) || !names.has(object.owner)
      || typeof object.privacyScope !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(object.privacyScope) || !safe(object.bytes) || object.bytes < 1) throw new Error('Unknown original proof obligation');
    const identity = `${object.owner}:${object.privacyScope}:${object.id}`;
    if (objects.has(identity)) throw new Error('Original must be stored exactly once per physical privacy scope');
    objects.add(identity); perOwner.set(object.owner, add(perOwner.get(object.owner) ?? 0, object.bytes)); originalCounts.set(object.owner,(originalCounts.get(object.owner)??0)+1);
  }
  for (const owner of value.owners) if ((perOwner.get(owner.owner) ?? 0) > owner.closure.original.bytes || (originalCounts.get(owner.owner)??0)>owner.closure.original.count) throw new Error(`Complete original proof closure exceeds declared C: owner=${owner.owner} bytes=${perOwner.get(owner.owner)} count=${originalCounts.get(owner.owner)} budget=${JSON.stringify(owner.closure.original)}`);
  const paths = new Set(requests.map(r=>r.path));
  for (const outside of value.outside) {
    if (!fields(outside,['path','component','scope','maximumBytes']) || typeof outside.path !== 'string' || !isAbsolute(outside.path)
      || resolve(outside.path) !== outside.path || !safe(outside.maximumBytes) || !['file','directory'].includes(outside.scope)
      || typeof outside.component !== 'string' || paths.has(outside.path)
      || outside.path === value.root || outside.path.startsWith(value.root+'/')) throw new Error('Invalid or hidden outside recovery obligation');
    paths.add(outside.path); requests.push({...outside});
  }
  const maximumWork = SUSTAINABLE_RECOVERY_LIMITS.operationWork;
  const cumulativeWork = 4 * add(...Object.values(value.work));
  if (!safe(cumulativeWork) || cumulativeWork > SUSTAINABLE_RECOVERY_LIMITS.work) throw new Error('Recovery cumulative work envelope exhausted');
  const manifest = structuredClone(value);
  const digest = `sha256:${createHash('sha256').update('resonance:sustainable-recovery-manifest:v1\n').update(JSON.stringify(manifest)).digest('hex')}`;
  return { manifest, digest, requests, maximumWork, arenaBytes: add(...requests.slice(0,98).map(r=>r.maximumBytes)),
    totalDeclaredBytes: add(...requests.map(r=>r.maximumBytes)) };
}

type Authority = ReturnType<typeof openStorageReservationAuthority>;
/** No effects or partial allocations on any failed layout dimension. Callers
 * must still enforce partitions/child peaks; these are not directory leases. */
export function preflightSustainableRecoveryManifest(authority: Authority, value: RecoveryAllocationManifest, mode: 'new' | 'existing') {
  const compiled = compileSustainableRecoveryManifest(value), status = authority.status();
  if (status.limitBytes > SUSTAINABLE_RECOVERY_LIMITS.bytes) throw new Error('Recovery authority exceeds unchanged resource limit');
  const review = authority.reviewReservations(compiled.requests);
  if (!review.fits || review.metadataBytes > SUSTAINABLE_RECOVERY_LIMITS.metadata || review.components > SUSTAINABLE_RECOVERY_LIMITS.entries) throw new Error('Recovery allocation envelope does not fit');
  if (mode !== 'new' && mode !== 'existing') throw new Error('Select explicit recovery funding mode');
  if (mode === 'existing' && review.additionalBytes !== 0) throw new Error('Recovery reopen requires complete existing funding');
  return { ...compiled, authorityId: status.authorityId, review };
}
