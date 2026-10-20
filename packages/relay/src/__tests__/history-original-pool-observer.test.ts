import { type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPolicyObserverHistoryRoot } from '../protected-policy-observer.js';
import { replayPolicyObserverHistory } from '../policy-observer-history-replay.js';
import { admissionPolicyObserversId } from '@resonance/core/admission-policy-freshness';
import { advanceAdmissionPolicyObserverState, type AdmissionPolicyObserverState } from '../admission-policy-observer-state.js';
import { historyOriginalPoolFixture } from './fixtures/history-original-pool-fixture.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));
it('retains policy conflict obligations across100 real pooled recoveries and downloads/reopens across a page', async () => {
  const f = await policyObserverFixture(); cleanup.push(f.close); const started = performance.now();
  const enrolled = await createPolicyObserverHistoryRoot({ context: f.context, signingKey: f.keys[0], encryptionKey: f.options.encryptionKey, policy: f.first, now: () => f.now });
  const initial: AdmissionPolicyObserverState = { version: 1, contextId: admissionPolicyObserversId(f.context), policy: f.first, previous: null, advance: null, conflict: null };
  const advanced = advanceAdmissionPolicyObserverState(initial, f.advance, f.context), conflicted = advanceAdmissionPolicyObserverState(advanced, f.conflict, f.context);
  const n = historyOriginalPoolFixture({ context: enrolled.context, root: enrolled.root, encryptionKey: f.options.encryptionKey, owner: f.keys[0], memberKeys: f.keys }); cleanup.push(n.close);
  let proposal!: HistorySuccessorProposal;
  for (let generation = 0; generation <= 100; generation++) {
    if (generation === 1) n.append(advanced);
    if (generation === 64) n.append(conflicted);
    proposal = n.select();
    if (generation === 64 || generation === 100) {
      n.reopen(); writeFileSync(`/tmp/resonance-original-pool-observer-${generation+1}.json`, JSON.stringify(n.measurement(), null, 2));
      const result = await replayPolicyObserverHistory({ context: f.context, historyContext: enrolled.context, genesisId: n.genesisId, proposal,
        encryptionKey: f.options.encryptionKey, blocks: n.blocks(), minimumState: conflicted });
      expect(result.generations).toBe(generation + 1); expect(result.state).toEqual(conflicted); expect(result.state.conflict).toEqual(f.conflict.commitment);
      expect(result.state.advance).toEqual(f.advance.commitment); expect(result.state.policy).toEqual(f.second);
    }
    if (generation < 100) n.rotate(proposal);
  }
  let download = n.download(proposal); cleanup.push(() => download.close());
  const partial = await download.run({ maxBlocks: 66 }); expect(partial.complete).toBe(false); expect(partial.page).toBe(1);
  expect(() => [...download.blocks()]).toThrow('incomplete'); download.close(); download = n.download(proposal, false);
  expect((await download.run({ maxBlocks: 10001 })).complete).toBe(true); expect([...download.blocks()]).toEqual(n.blocks());
  const descending = n.blocks().reverse();
  const baseBytes = 4 * 1024 * 1024;
  const blockLimited = n.download(proposal, true, { directory: join(n.directory, 'download-block-budget'), maxBytes: 8 * 1024 * 1024, maxBlocks: 66 });
  try { await expect(blockLimited.run({ maxBlocks: 10001 })).rejects.toThrow('capacity');
    expect(blockLimited.read().blocks).toBe(66); expect(blockLimited.read().page).toBe(1); expect(() => [...blockLimited.blocks()]).toThrow('incomplete'); }
  finally { blockLimited.close(); }
  const byteLimit = baseBytes + descending.slice(0, 66).reduce((sum, block) => sum + Buffer.byteLength(JSON.stringify(block)), 0);
  const byteLimited = n.download(proposal, true, { directory: join(n.directory, 'download-byte-budget'), maxBytes: byteLimit });
  try { await expect(byteLimited.run({ maxBlocks: 10001 })).rejects.toThrow('capacity'); expect(byteLimited.read().blocks).toBe(66); expect(byteLimited.read().page).toBe(1); }
  finally { byteLimited.close(); }
  let attemptElapsed = 0, crossed = false; const attemptClock = vi.spyOn(performance, 'now').mockImplementation(() => attemptElapsed);
  const timed = n.download(proposal, true, { directory: join(n.directory, 'download-deadline'), maxBytes: 8 * 1024 * 1024, timeoutMs: 30000,
    transport: async (member, frame) => { if (frame.request.generation <= 36) { crossed = true; attemptElapsed = 30001; }
      return n.services()[enrolled.context.members.indexOf(member.publicKey)].checkpoint(frame); } });
  try { await expect(timed.run({ maxBlocks: 10001 })).rejects.toThrow(/timed out|unavailable/); expect(crossed).toBe(true); expect(timed.read().page).toBe(1); expect(timed.read().complete).toBe(false); }
  finally { timed.close(); attemptClock.mockRestore(); }
  const input = { context: f.context, historyContext: enrolled.context, genesisId: n.genesisId, proposal, encryptionKey: f.options.encryptionKey, blocks: [...download.blocks()] };
  for (const damage of ['gap', 'reorder', 'blocks', 'bytes']) {
    const blocks = [...input.blocks], boundary = blocks.findIndex(b => b.generation === 64);
    if (damage === 'gap') blocks.splice(boundary, 1);
    if (damage === 'reorder') [blocks[boundary - 1], blocks[boundary]] = [blocks[boundary], blocks[boundary - 1]];
    await expect(replayPolicyObserverHistory({ ...input, blocks, ...(damage === 'blocks' ? { maxBlocks: boundary + 1 } : {}),
      ...(damage === 'bytes' ? { maxBytes: input.blocks.slice(0, boundary + 1).reduce((n, b) => n + Buffer.byteLength(JSON.stringify(b)), 0) } : {}) })).rejects.toThrow(damage === 'blocks' ? 'block capacity' : undefined);
  }
  let elapsed = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  function* delayed() { for (const block of input.blocks) { if (block.generation === 64) elapsed = 51; yield block; } }
  try { await expect(replayPolicyObserverHistory({ ...input, blocks: delayed(), timeoutMs: 50 })).rejects.toThrow('timed out'); } finally { clock.mockRestore(); }
  expect(n.refuseCatalogMutation(value => value.pages.reverse())).toBe(true);
  expect(n.refuseCatalogMutation(value => value.pages.splice(0, 1))).toBe(true);
  expect(n.refuseCatalogMutation(value => value.pages[1] = value.pages[0])).toBe(true);
  const measured = { role: 'policy-observer', durationMs: performance.now() - started, ...n.measurement() };
  writeFileSync('/tmp/resonance-original-pool-observer.json', JSON.stringify(measured, null, 2));
  expect(measured.pools.every(p => p!.pages === 2 && p!.peakBytes <= 256 * 1024 * 1024)).toBe(true);
}, 300000);


it('fails fast on a repeated genesis and closes its source before block capacity', async () => {
  const f = await policyObserverFixture(); cleanup.push(f.close);
  const enrolled = await createPolicyObserverHistoryRoot({ context: f.context, signingKey: f.keys[0], encryptionKey: f.options.encryptionKey, policy: f.first, now: () => f.now });
  const n = historyOriginalPoolFixture({ context: enrolled.context, root: enrolled.root, encryptionKey: f.options.encryptionKey, owner: f.keys[0], memberKeys: f.keys }); cleanup.push(n.close);
  const proposal = n.select();
  let reads = 0, returned = false;
  function* repeated() { try { while (true) { reads++; yield enrolled.root; } } finally { returned = true; } }
  await expect(replayPolicyObserverHistory({ context: f.context, historyContext: enrolled.context, genesisId: n.genesisId, proposal,
    encryptionKey: f.options.encryptionKey, blocks: repeated(), maxBlocks: 3 })).rejects.toThrow('Policy observer history has a gap, fork or wrong generation');
  expect(reads).toBe(2); expect(returned).toBe(true);
});

it('exhausts block capacity on a genuine selected chain and closes its source', async () => {
  const f = await policyObserverFixture(); cleanup.push(f.close);
  const enrolled = await createPolicyObserverHistoryRoot({ context: f.context, signingKey: f.keys[0], encryptionKey: f.options.encryptionKey, policy: f.first, now: () => f.now });
  const initial: AdmissionPolicyObserverState = { version: 1, contextId: admissionPolicyObserversId(f.context), policy: f.first, previous: null, advance: null, conflict: null };
  const advanced = advanceAdmissionPolicyObserverState(initial, f.advance, f.context), conflicted = advanceAdmissionPolicyObserverState(advanced, f.conflict, f.context);
  const n = historyOriginalPoolFixture({ context: enrolled.context, root: enrolled.root, encryptionKey: f.options.encryptionKey, owner: f.keys[0], memberKeys: f.keys }); cleanup.push(n.close);
  n.append(advanced); n.append(conflicted); const first = n.select(); n.rotate(first);
  const input = { context: f.context, historyContext: enrolled.context, genesisId: n.genesisId, proposal: n.select(), encryptionKey: f.options.encryptionKey, blocks: n.blocks() };
  const complete = await replayPolicyObserverHistory({ ...input, minimumState: conflicted });
  expect(complete.blocks).toBe(4); expect(complete.generations).toBe(2); expect(complete.state).toEqual(conflicted);
  let reads = 0, returned = false;
  function* valid() { try { for (const block of input.blocks) { reads++; yield block; } } finally { returned = true; } }
  await expect(replayPolicyObserverHistory({ ...input, blocks: valid(), maxBlocks: 3 })).rejects.toThrow('block capacity');
  expect(reads).toBe(4); expect(returned).toBe(true);
});
