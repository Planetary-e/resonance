import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { signAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { admissionPolicyObserversId } from '@resonance/core/admission-policy-freshness';
import { createHistoryFreeze, sealHistoryCheckpoint, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createPolicyObserverHistoryRoot } from '../protected-policy-observer.js';
import { advanceAdmissionPolicyObserverState, type AdmissionPolicyObserverState } from '../admission-policy-observer-state.js';
import { replayPolicyObserverHistory } from '../policy-observer-history-replay.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));
async function selected() {
  const f = await policyObserverFixture(); cleanup.push(f.close);
  const owner = f.keys[0], encryptionKey = f.options.encryptionKey;
  const { context: historyContext, root } = await createPolicyObserverHistoryRoot({ context: f.context, signingKey: owner,
    encryptionKey, policy: f.first, now: () => f.now });
  let state: AdmissionPolicyObserverState = { version: 1, contextId: admissionPolicyObserversId(f.context), policy: f.first, previous: null, advance: null, conflict: null };
  const blocks: HistoryCheckpointEnvelope[] = [root];
  for (let sequence = 1; sequence < 96; sequence++) {
    const policy = await signAdmissionPolicy({ ...f.body, revision: sequence + 1 }, f.authority, f.key.secretKey);
    const advance = await createAdmissionPolicyAdvance(state.policy as typeof f.first, policy, f.context, f.key, state.advance?.next ?? f.context.genesis);
    state = advanceAdmissionPolicyObserverState(state, advance, f.context);
    blocks.push(sealHistoryCheckpoint({ context: historyContext, header: { kind: 'checkpoint', generation: 0, sequence,
      previous: historyCheckpointEnvelopeId(blocks.at(-1)!) }, plaintext: Buffer.from(JSON.stringify(state)), encryptionKey, signingKey: owner }));
  }
  const rootId = historyCheckpointEnvelopeId(root), challenge = randomBytes(32).toString('base64url');
  const freeze = createHistoryFreeze(historyContext, 0, 1, challenge, owner);
  const receipts = historyContext.members.slice(0, 4).map(replica => {
    const key = f.keys.find(key => Buffer.from(key.publicKey).toString('base64url') === replica)!;
    const request = createHistoryExchangeRequest({ action: 'freeze', rootId, generation: 0, replica, challenge,
      issuedAt: 100, expiresAt: 200, sequence: 1, envelopeId: null }, historyContext, owner);
    return createHistoryExchangeResponse(request, 'frozen', { generation: 0, rootId, sequence: blocks.length - 1,
      envelopeId: historyCheckpointEnvelopeId(blocks.at(-1)!), freeze }, null, historyContext, key);
  });
  const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation: 0, nextGeneration: 1,
    receipts, envelopes: blocks }, historyContext, owner);
  return { context: f.context, historyContext, genesisId: rootId, proposal, encryptionKey, blocks, state };
}
it('delivers scheduled external cancellation during source traversal within32 blocks', async () => {
  const input = await selected(), controller = new AbortController(), callerKey = Buffer.from(input.encryptionKey);
  let consumed = 0, closed = false;
  function* source() {
    try {
      for (const block of input.blocks) {
        if (++consumed === 1) {
          setImmediate(() => controller.abort());
        }
        yield block;
      }
    } finally { closed = true; }
  }
  await expect(replayPolicyObserverHistory({ ...input, blocks: source(), signal: controller.signal })).rejects.toThrow('cancelled');
  expect(consumed).toBeGreaterThan(0); expect(consumed).toBeLessThanOrEqual(32);
  expect(closed).toBe(true); expect(input.encryptionKey).toEqual(callerKey);
}, 30000);
it('authenticates a genuine selected policy chain and rejects missing evidence without a partial result', async () => {
  const input = await selected();
  const result = await replayPolicyObserverHistory({ ...input, minimumState: input.state });
  expect(result.state).toEqual(input.state); expect(result.blocks).toBe(96); expect(result.head.envelopeId).toBe(input.proposal.envelopeId);
  for (const blocks of [input.blocks.slice(1), [...input.blocks.slice(0, 31), ...input.blocks.slice(32)]]) {
    let closed = false;
    function* source() { try { yield* blocks; } finally { closed = true; } }
    await expect(replayPolicyObserverHistory({ ...input, blocks: source() })).rejects.toThrow();
    expect(closed).toBe(true);
  }
}, 30000);
