import type { RecoveryJournal } from './sustainable-recovery-runtime.js';
import { decodeRecoveryJournal, encodeRecoveryJournal } from './sustainable-recovery-codec.js';
import { rso5Digest, type Rso5CheckpointEntry, type Rso5FrameIdentity } from './sustainable-rso5-opaque.js';
import { sustainableRecoveryBytes, sustainableRecoveryConcat, sustainableRecoveryView, withSustainableRecoveryWork } from './sustainable-recovery-work.js';
import { SUSTAINABLE_RECOVERY_LIMITS } from './sustainable-recovery-manifest.js';

export interface Rso5ReferenceJournal { journal: RecoveryJournal; references: Rso5FrameIdentity[] }
function digestBytes(value: string) { return sustainableRecoveryBytes(value.slice(7), 'hex', 'V'); }
function referenceBytes(reference: Rso5FrameIdentity): Buffer {
  return sustainableRecoveryConcat([digestBytes(reference.scopeId), digestBytes(reference.proofId), digestBytes(reference.frameDigest),
    sustainableRecoveryBytes(Uint8Array.of(reference.kind === 'original' ? 0 : reference.kind === 'frame' ? 1 : reference.kind === 'policy' ? 2 : 3)),
    (() => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(reference.frameBytes); return bytes; })()], 'V');
}
export function rso5ProofRoot(references: Rso5FrameIdentity[]): string {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    const ordered = references.map(reference => ({ ...reference })).sort((a, b) => a.scopeId === b.scopeId ? a.proofId === b.proofId ? a.frameDigest < b.frameDigest ? -1 : 1 : a.proofId < b.proofId ? -1 : 1 : a.scopeId < b.scopeId ? -1 : 1);
    const seen = new Set<string>(); for (const reference of ordered) { if (seen.has(reference.frameDigest)) throw new Error('Duplicate RSO5 proof root frame'); seen.add(reference.frameDigest); }
    return rso5Digest(sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:proof-root:v1\n', 'utf8', 'V'), ...ordered.map(referenceBytes)], 'V'));
  });
}
export function encodeRso5ReferenceJournal(value: Rso5ReferenceJournal): Buffer {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    const journal = encodeRecoveryJournal(value.journal), root = rso5ProofRoot(value.references);
    return sustainableRecoveryConcat([sustainableRecoveryBytes('RSJ5', 'ascii', 'V'), digestBytes(root), (() => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(journal.length); return bytes; })(), journal,
      (() => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value.references.length); return bytes; })(), ...value.references.map(referenceBytes)], 'V');
  });
}
export function decodeRso5ReferenceJournal(bytes: Uint8Array, getProof: (id: string) => Buffer): Rso5ReferenceJournal {
  return withSustainableRecoveryWork(SUSTAINABLE_RECOVERY_LIMITS.work, () => {
    const data = sustainableRecoveryView(bytes);
    if (data.length < 52 || data.toString('ascii', 0, 4) !== 'RSJ5') throw new Error('Invalid RSO5 reference journal');
    const expectedRoot = `sha256:${data.subarray(4, 36).toString('hex')}`, journalBytes = data.readUInt32BE(36), count = data.readUInt32BE(40 + journalBytes);
    if (count > 72 || data.length !== 48 + journalBytes + count * 101) throw new Error('RSO5 reference journal length');
    const journal = decodeRecoveryJournal(data.subarray(44, 44 + journalBytes), getProof), references: Rso5FrameIdentity[] = [];
    for (let index = 0; index < count; index++) {
      const offset = 44 + journalBytes + index * 101, scopeId = `sha256:${data.subarray(offset, offset + 32).toString('hex')}`, proofId = `sha256:${data.subarray(offset + 32, offset + 64).toString('hex')}`;
      const frameDigest = `sha256:${data.subarray(offset + 64, offset + 96).toString('hex')}`, kindNumber = data[offset + 96], kind = kindNumber === 0 ? 'original' : kindNumber === 1 ? 'frame' : kindNumber === 2 ? 'policy' : kindNumber === 3 ? 'activation' : undefined;
      if (!kind) throw new Error('RSO5 reference kind differs'); references.push({ scopeId, proofId, kind, frameDigest, frameBytes: data.readUInt32BE(offset + 97) });
    }
    if (rso5ProofRoot(references) !== expectedRoot) throw new Error('RSO5 reference journal root differs');
    return { journal, references };
  });
}
export function assertRso5CheckpointCoverage(checkpoint: { entries: Rso5CheckpointEntry[] }, references: Rso5FrameIdentity[]): void {
  const entries = new Map(checkpoint.entries.map(entry => [entry.frameDigest, entry]));
  for (const reference of references) {
    const entry = entries.get(reference.frameDigest);
    if (!entry || entry.scopeId !== reference.scopeId || entry.proofId !== reference.proofId || entry.kind !== reference.kind || entry.frameBytes !== reference.frameBytes) throw new Error('RSO5 checkpoint proof coverage differs');
  }
}
