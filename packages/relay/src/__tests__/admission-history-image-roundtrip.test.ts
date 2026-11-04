import { expect, it } from 'vitest';
import { parseAdmissionHistoryImage } from '../admission-history-records.js';
import { admissionHistoryReplayDigest } from '../admission-history-replay.js';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';
import { historyCheckpointContextId, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { historySuccessorProposalId } from '@resonance/core/history-successor';

it('uses the same existing digest after parser round-trip of reordered authenticated image fields and distinguishes actual changes', async () => {
  const n = await admissionRestoreFixture();
  try {
    const image = n.image, reordered = Object.fromEntries(Object.entries(image).reverse());
    const a = await parseAdmissionHistoryImage(image, n.context.authority), b = await parseAdmissionHistoryImage(reordered, n.context.authority);
    const pins = [historyCheckpointContextId(n.context), historyCheckpointEnvelopeId(n.root), historySuccessorProposalId(n.continuation().proposal)] as const;
    const digest = (value: typeof a) => admissionHistoryReplayDigest(...pins, value);
    expect(reordered).toEqual(image); expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(image));
    expect(a).toEqual(image); expect(b).toEqual(a); expect(digest(a)).toBe(digest(b));
    const changed = structuredClone(a); changed.state.retiredIssuerKeys = [];
    const parsedChange = await parseAdmissionHistoryImage(changed, n.context.authority);
    expect(digest(parsedChange)).not.toBe(digest(a));
    const forged = structuredClone(a); forged.policy.revision++;
    await expect(parseAdmissionHistoryImage(forged, n.context.authority)).rejects.toThrow();
  } finally { await n.close(); }
}, 30_000);
