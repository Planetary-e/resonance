import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHistoryContinuationRoot, historyContinuationRootId, parseHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { openHistoryCheckpoint, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { historyAgreementFixture } from './fixtures/history-agreement-fixture.js';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../history-checkpoint-store.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const cleanup: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); cleanup.splice(0).reverse().forEach(f => f()); });

function fixture(tail: Parameters<typeof historyAgreementFixture>[0] = 'none') {
  const n = historyAgreementFixture(tail); cleanup.push(() => n.close());
  function decide(view: number) {
    const reports = n.promise(view), frames = n.frames('prepare', view, n.a, reports);
    const prepared = n.certificate(frames.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
    const confirmed = n.certificate(n.frames('confirm', view, n.a, prepared).slice(0, 4).map((f, i) => n.roles[i].exchange(f)), 'confirmed');
    return { prepared, confirmed, root: createHistoryContinuationRoot(n.a, confirmed, n.context) };
  }
  const proof = decide(1);
  function child(parent = n.stores[0], initialize = true) {
    const store = openHistoryCheckpointStore({ ...n.options, directory: join(n.directory, 'child'), generation: 1,
      rootId: historyContinuationRootId(proof.root), ...(initialize ? { initialize: proof.root } : {}), parent });
    cleanup.push(() => store.close()); return store;
  }
  return { ...n, ...proof, decide, child };
}

describe('certificate-controlled history continuation', () => {
  it('derives one root from a decided value across genuine later-view proofs, with no standalone replacement snapshot', () => {
    const n = fixture(), later = n.decide(2);
    expect(later.confirmed).not.toEqual(n.confirmed);
    expect(historyContinuationRootId(later.root)).toBe(historyContinuationRootId(n.root));
    n.stores[0].activateContinuation(n.root);
    expect(n.stores[0].activateContinuation(later.root)).toEqual(n.root);
    expect(historyCheckpointEnvelopeId(n.root)).toBe(historyContinuationRootId(n.root));
    expect(parseHistoryContinuationRoot(JSON.parse(JSON.stringify(n.root)), n.context)).toEqual(n.root);
    expect(() => openHistoryCheckpoint(n.root, n.context, n.key)).toThrow('predecessor');
    for (const bad of [{ ...n.root, certificate: n.prepared }, { ...n.root, proposal: n.b }, { ...n.root, generation: 2 },
      { ...n.root, previous: n.options.rootId }, { ...n.root, ciphertext: 'empty snapshot' },
      { ...n.root, certificate: { ...n.confirmed, votes: n.confirmed.votes.slice(0, 3) } }]) {
      expect(() => parseHistoryContinuationRoot(bad, n.context)).toThrow();
    }
  });

  it('requires durable parent authority on creation and reopen, retains the parent and keeps its writer frozen', () => {
    const n = fixture(), before = n.stores[0].read();
    expect(() => n.child()).toThrow('not activated');
    const result = n.stores[0].activateContinuation(n.root);
    result.certificate.votes[0].signature = 'mutated caller copy';
    expect(n.stores[0].activatedContinuation()).toEqual(n.root);
    expect(n.stores[0].activateContinuation(n.root)).toEqual(n.root);
    n.reopen(0); const child = n.child();
    const delta = n.next(n.root); child.append(delta);
    expect(n.stores[0].read()).toEqual(before);
    expect(() => n.stores[0].append(n.next(before.envelopes[0]))).toThrow('frozen');
    expect(() => n.roles[0].exchange(n.frames('promise', 3)[0])).toThrow('activated');
    child.close();
    expect(() => openHistoryCheckpointStore({ ...n.options, directory: join(n.directory, 'child'), generation: 1,
      rootId: historyContinuationRootId(n.root) })).toThrow('predecessor');
    expect(n.child(n.stores[0], false).read().envelopes).toEqual([n.root, delta]);
    expect(() => n.stores[1].requireContinuation(n.root, n.context.members[0])).toThrow();
  });

  it.each(['missing', 'newer'] as const)('refuses a %s selected history without erasing it', tail => {
    const n = fixture(tail), before = n.stores[4].read();
    expect(() => n.stores[4].activateContinuation(n.root)).toThrow('complete selected');
    expect(n.stores[4].read()).toEqual(before);
  });

  it('refuses legacy reservations without erasing them', () => {
    const legacy = fixture(); legacy.stores[4].seal(legacy.b);
    expect(() => legacy.stores[4].activateContinuation(legacy.root)).toThrow('eligible frozen');
    expect(legacy.stores[4].reservedSuccessor()).toEqual(legacy.b);
  });

  it('refuses reopening a child after parent activation rollback or predecessor ciphertext corruption', () => {
    const n = fixture(), path = join(n.directory, 'r0', HISTORY_MANIFEST_FILENAME), earlier = readFileSync(path);
    n.stores[0].activateContinuation(n.root); n.child().close();
    n.roles[0].close(); n.stores[0].close(); writeFileSync(path, earlier); n.reopen(0);
    expect(() => n.child(n.stores[0], false)).toThrow('not activated');
    n.stores[0].activateContinuation(n.root);
    n.roles[0].close(); n.stores[0].close();
    writeFileSync(join(n.directory, 'r0', `${n.options.rootId.slice(7)}.block`), '{}');
    expect(() => n.reopen(0)).toThrow();
    expect(() => n.child(n.stores[0], false)).toThrow();
  });

  it('enforces ancestor depth and aggregate byte capacity before creating a child directory', () => {
    const n = fixture(); n.stores[0].activateContinuation(n.root);
    const directory = join(n.directory, 'over-budget');
    for (const change of [{ depth: 65 }, { bytes: 256 * 1024 * 1024 }]) {
      expect(() => openHistoryCheckpointStore({ ...n.options, directory, generation: 1, rootId: historyContinuationRootId(n.root),
        initialize: n.root, parent: { requireContinuation(root, replica) {
          return { ...n.stores[0].requireContinuation(root, replica), ...change };
        } } })).toThrow('ancestry capacity');
      expect(existsSync(directory)).toBe(false);
      expect(n.stores[0].activatedContinuation()).toEqual(n.root);
    }
  });

  it.each([1, 2])('refuses child activation after uncertain parent flush %i, then reopens and retries the exact boundary', failure => {
    const n = fixture(); let calls = 0;
    vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === failure) throw new Error('activation disk failure'); actualFsync(fd); });
    expect(() => n.stores[0].activateContinuation(n.root)).toThrow('activation disk failure');
    expect(() => n.child()).toThrow();
    vi.mocked(fsyncSync).mockImplementation(actualFsync); n.reopen(0);
    n.stores[0].activateContinuation(n.root);
    expect(n.child().read().envelopes).toEqual([n.root]);
    expect(n.stores[0].read().envelopes).toEqual([n.preparation.envelopes[0]]);
  });
});
