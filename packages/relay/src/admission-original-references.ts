import { ownAdmissionReplayValue } from '@resonance/core';
/** Lossless original JSON references inside authenticated admission histories.
 * This dictionary is local to one retained prefix. It is never a semantic anchor. */
import { createHash } from 'node:crypto';
import { HISTORY_CHECKPOINT_MAX_PAYLOAD } from '@resonance/core/history-checkpoint';

const KIND = 'admission-original-references';
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 64;
type Scalar = null | boolean | number | string;
interface TermList extends Array<Scalar | TermList> {}
type Term = Scalar | TermList;
interface Node { term: Term; value: unknown; bytes: number; depth: number }
export interface OriginalReferencePacket { version: 1; kind: typeof KIND; context: string; previous: string | null; root: Term; nodes: Array<[string, Term]> }
const digest = (term: Term) => createHash('sha256').update('resonance:admission-original-json:v1\n').update(JSON.stringify(term)).digest('base64url');
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const exact = (value: object, fields: string[]) => Object.keys(value).sort().join(',') === fields.sort().join(',');

/** One reconstruction allowance survives dictionary replacement and rescanning. */
export interface OriginalReferenceWorkBudget { charge(bytes: number): void; usedBytes(): number }
export function createOriginalReferenceWorkBudget(maximum = MAX_TOTAL_BYTES): OriginalReferenceWorkBudget {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_TOTAL_BYTES) throw new Error('Invalid original reference work capacity');
  let used = 0;
  return {
    charge(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum - used) throw new Error('Original reference reconstruction exceeds cumulative capacity');
      used += bytes;
    },
    usedBytes: () => used,
  };
}
const operationWork = new WeakMap<object, OriginalReferenceWorkBudget>();
export function originalReferenceWorkBudget(operation: object): OriginalReferenceWorkBudget {
  let budget = operationWork.get(operation);
  if (!budget) { budget = createOriginalReferenceWorkBudget(); operationWork.set(operation, budget); }
  return budget;
}
/** Trusted nested operations adopt their caller's allowance before decoding. */
export function shareOriginalReferenceWorkBudget(operation: object, budget: OriginalReferenceWorkBudget): OriginalReferenceWorkBudget {
  const existing = operationWork.get(operation);
  if (existing && existing !== budget && existing.usedBytes() !== 0) throw new Error('Original reference work scope changed after reconstruction');
  operationWork.set(operation, budget); return budget;
}

export function createAdmissionOriginalReferences(context: string, limits: { maxExpandedBytes?: number; maxDictionaryBytes?: number; check?: () => void; workBudget?: OriginalReferenceWorkBudget } = {}) {
  const nodes = new Map<string, Node>();
  let dictionaryBytes = 0, expandedBytes = 0;
  const maximumExpanded = limits.maxExpandedBytes ?? MAX_TOTAL_BYTES;
  const maximumDictionary = limits.maxDictionaryBytes ?? MAX_TOTAL_BYTES;
  if (![maximumExpanded, maximumDictionary].every(v => Number.isSafeInteger(v) && v > 0 && v <= MAX_TOTAL_BYTES)) throw new Error('Invalid original reference capacity');
  const localWork = createOriginalReferenceWorkBudget(maximumExpanded);
  let work = 0;
  const check = () => { if (++work % 128 === 0) limits.check?.(); };

  function expand(term: Term, lookup: Map<string, Node>, depth = 0): Node {
    check();
    if (depth > MAX_DEPTH) throw new Error('Original reference depth exceeds capacity');
    if (!Array.isArray(term)) {
      if (term !== null && !['string','boolean','number'].includes(typeof term) || typeof term === 'number' && !Number.isFinite(term)) throw new Error('Invalid original reference scalar');
      return { term, value: term, bytes: size(term), depth: 0 };
    }
    if (term[0] === 'r') {
      if (term.length !== 2 || typeof term[1] !== 'string' || !lookup.has(term[1])) throw new Error('Missing or forward original reference');
      const node = lookup.get(term[1])!;
      if (depth + node.depth > MAX_DEPTH) throw new Error('Original reference depth exceeds capacity');
      return node;
    }
    if (term[0] !== 'a' && term[0] !== 'o' || term[0] === 'o' && term.length % 2 !== 1) throw new Error('Invalid original reference node');
    let bytes = 2, childDepth = 0;
    const array: unknown[] = [], object: Record<string, unknown> = {};
    const add = (child: Node, overhead: number) => {
      bytes += child.bytes + overhead; childDepth = Math.max(childDepth, child.depth + 1);
      if (bytes > HISTORY_CHECKPOINT_MAX_PAYLOAD) throw new Error('Original reference expansion exceeds frame capacity');
    };
    for (let i = 1; i < term.length; i += term[0] === 'o' ? 2 : 1) {
      if (term[0] === 'o') {
        const key = term[i];
        if (typeof key !== 'string' || Object.hasOwn(object, key)) throw new Error('Invalid original reference object key');
        const child = expand(term[i + 1] as Term, lookup, depth + 1);
        add(child, size(key) + 1 + (i > 1 ? 1 : 0));
        Object.defineProperty(object, key, { value: child.value, enumerable: true, writable: true, configurable: true });
      } else {
        const child = expand(term[i] as Term, lookup, depth + 1); add(child, i > 1 ? 1 : 0); array.push(child.value);
      }
    }
    return { term, value: term[0] === 'a' ? array : object, bytes, depth: childDepth };
  }
  function encode(value: unknown, previous: string | null): OriginalReferencePacket {
    const added = new Map<string, Node>(), entries: Array<[string, Term]> = [];
    function visit(value: unknown, depth: number): Term {
      check();
      if (depth > MAX_DEPTH) throw new Error('Original reference depth exceeds capacity');
      if (value === null || typeof value !== 'object') return value as Scalar;
      const term = (Array.isArray(value) ? ['a', ...value.map(v => visit(v, depth + 1))]
        : ['o', ...Object.entries(value).flatMap(([key, v]) => [key, visit(v, depth + 1)])]) as Term;
      if (size(term) < 160) return term;
      const id = digest(term);
      if (!nodes.has(id) && !added.has(id)) { entries.push([id, term]); added.set(id, { term, value, bytes: 0, depth: 0 }); }
      return ['r', id];
    }
    return { version: 1, kind: KIND, context, previous, root: visit(value, 0), nodes: entries };
  }
  function accept(value: unknown, previous: string | null, maximumFrameBytes = HISTORY_CHECKPOINT_MAX_PAYLOAD,
    workBudget = limits.workBudget ?? localWork): unknown {
    limits.check?.();
    if (size(value) > maximumFrameBytes) throw new Error('Original reference physical frame exceeds capacity');
    const packet = value as OriginalReferencePacket;
    const encoded = packet?.kind === KIND ? packet : encode(value, previous);
    if (!exact(encoded, ['version','kind','context','previous','root','nodes']) || encoded.version !== 1 || encoded.context !== context
      || encoded.previous !== previous || !Array.isArray(encoded.nodes)) throw new Error('Original reference prefix differs');
    // A failed decode cannot add nodes for a later record.
    const next = new Map(nodes); let addedBytes = 0;
    for (const entry of encoded.nodes) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || digest(entry[1]) !== entry[0]) throw new Error('Original reference hash differs');
      const [id, term] = entry;
      const old = next.get(id);
      if (old) { if (JSON.stringify(old.term) !== JSON.stringify(term)) throw new Error('Conflicting original reference'); continue; }
      const node = expand(term, next);
      addedBytes += size(entry);
      if (dictionaryBytes + addedBytes > maximumDictionary) throw new Error('Original reference dictionary exceeds cumulative capacity');
      next.set(id, node);
    }
    const root = expand(encoded.root, next);
    if (root.bytes > maximumFrameBytes || root.bytes > maximumExpanded) throw new Error('Original reference reconstruction exceeds frame capacity');
    workBudget.charge(root.bytes); // Never reset with a new prefix dictionary.
    for (const [id, node] of next) if (!nodes.has(id)) { ownAdmissionReplayValue(node.term); ownAdmissionReplayValue(node.value); nodes.set(id, node); }
    dictionaryBytes += addedBytes; expandedBytes += root.bytes;
    // Do not expose the immutable dictionary's objects to business-state mutation.
    return structuredClone(root.value);
  }
  return { encode, accept, usage: () => ({ nodes: nodes.size, dictionaryBytes, expandedBytes }) };
}
