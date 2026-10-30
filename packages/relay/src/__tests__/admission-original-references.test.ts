import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createAdmissionOriginalReferences } from '../admission-original-references.js';

const context = `sha256:${'1'.repeat(64)}`, head = `sha256:${'2'.repeat(64)}`;
const original = { signed: { version: 1, signature: 's'.repeat(86), payload: 'original'.repeat(100) }, order: { b: 1, a: 2 } };
const nodeHash = (term: unknown) => createHash('sha256').update('resonance:admission-original-json:v1\n').update(JSON.stringify(term)).digest('base64url');

describe('authenticated original reference representation', () => {
  it('preserves exact original JSON and field order across legacy, new and repeated records', () => {
    const writer = createAdmissionOriginalReferences(context), reader = createAdmissionOriginalReferences(context);
    writer.accept(original, null); reader.accept(original, null);
    const next = { inherited: [original.signed, original.signed], accepted: original, phase: 'OLD_FENCED' };
    const packet = writer.encode(next, head);
    expect(JSON.stringify(packet).length).toBeLessThan(JSON.stringify(next).length / 2);
    expect(JSON.stringify(reader.accept(packet, head))).toBe(JSON.stringify(next));
    expect(JSON.stringify(reader.accept(packet, head))).toBe(JSON.stringify(next));
    expect(original.order).toEqual({ b: 1, a: 2 });
  });

  it('requires the original prefix and exact context/base, and rejects tampering without retaining additions', () => {
    const writer = createAdmissionOriginalReferences(context); writer.accept(original, null);
    const next = { original, added: 'n'.repeat(400) };
    const packet = writer.encode(next, head), reader = createAdmissionOriginalReferences(context);
    expect(() => reader.accept(packet, head)).toThrow(/Missing|forward/);
    expect(reader.usage().nodes).toBe(0);
    reader.accept(original, null);
    expect(() => reader.accept(packet, null)).toThrow(/prefix/);
    expect(() => createAdmissionOriginalReferences('another-history').accept(packet, head)).toThrow(/prefix/);
    const changed = structuredClone(packet); changed.nodes[0][1] = ['a', 'altered'];
    const before = reader.usage();
    expect(() => reader.accept(changed, head)).toThrow(/hash/);
    expect(reader.usage()).toEqual(before);
    expect(reader.accept(packet, head)).toEqual(next);
  });

  it('refuses forward and cyclic references even when their term hash is correct', () => {
    const term: any = ['a', ['r', 'unknown']], id = nodeHash(term);
    const reader = createAdmissionOriginalReferences(context);
    expect(() => reader.accept({ version: 1, kind: 'admission-original-references', context, previous: head,
      root: ['r', id], nodes: [[id, term]] }, head)).toThrow(/Missing|forward/);
    expect(reader.usage().nodes).toBe(0);
  });

  it('bounds shared-DAG expansion before materializing its output', () => {
    let term: any = ['a', 'x'.repeat(128)], id = nodeHash(term);
    const nodes: any[] = [[id, term]];
    for (let i = 0; i < 17; i++) { term = ['a', ['r', id], ['r', id]]; id = nodeHash(term); nodes.push([id, term]); }
    const reader = createAdmissionOriginalReferences(context);
    expect(() => reader.accept({ version: 1, kind: 'admission-original-references', context, previous: head,
      root: ['r', id], nodes }, head)).toThrow(/expansion/);
    expect(reader.usage().nodes).toBe(0);
  });

  it('bounds cumulative repeated reconstruction, dictionary bytes, depth and delta expanded size', () => {
    const writer = createAdmissionOriginalReferences(context), packet = writer.encode(original, head);
    const reader = createAdmissionOriginalReferences(context, { maxExpandedBytes: 2 * Buffer.byteLength(JSON.stringify(original)) });
    reader.accept(packet, head); reader.accept(packet, head);
    expect(() => reader.accept(packet, head)).toThrow(/cumulative/);
    expect(() => createAdmissionOriginalReferences(context, { maxDictionaryBytes: 100 }).accept(packet, head)).toThrow(/dictionary/);
    expect(() => createAdmissionOriginalReferences(context).accept(packet, head, 100)).toThrow(/capacity/);
    let nested: unknown = 'leaf'; for (let i = 0; i < 66; i++) nested = [nested];
    expect(() => writer.encode(nested, head)).toThrow(/depth/);
  });

  it('does not expose dictionary values to mutation by a consumer', () => {
    const refs = createAdmissionOriginalReferences(context), packet = refs.encode(original, head);
    const decoded = refs.accept(packet, head) as typeof original; decoded.signed.signature = 'changed';
    expect(refs.accept(packet, head)).toEqual(original);
  });
});
