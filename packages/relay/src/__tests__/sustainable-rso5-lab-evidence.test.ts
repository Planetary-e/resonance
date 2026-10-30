import { expect, it } from 'vitest';
import { clearLabTrafficForTests, labTrafficSnapshot, recordLabTraffic, type LabTrafficRecord } from '../sustainable-rso5-lab-transport.js';
import { driveIndependentRso5Matrix, networkEvidence } from '../sustainable-rso5-lab.js';

function record(messageId: string, outcome: LabTrafficRecord['outcome'], responseTo?: string): LabTrafficRecord {
  return { messageId, responseTo, source: outcome === 'sent' ? 'a' : 'b', destination: outcome === 'sent' ? 'b' : 'a',
    direction: outcome === 'sent' ? 'outbound' : 'inbound', purpose: 'test', transport: 'websocket-loopback',
    payloadBytes: outcome === 'sent' ? 10 : 20, frameBytes: outcome === 'sent' ? 16 : 24, outcome };
}

it('counts request+response envelopes consistently and keeps refusals separate', () => {
  clearLabTrafficForTests();
  recordLabTraffic(record('request', 'sent'));
  recordLabTraffic(record('response', 'received', 'request'));
  recordLabTraffic(record('server-response', 'sent', 'request'));
  recordLabTraffic(record('forged', 'received-refused', 'forged'));
  const evidence = networkEvidence(labTrafficSnapshot());
  expect(evidence.message_count).toBe(2);
  expect(evidence.reconciliation.refused_messages).toBe(1);
  expect(evidence.reconciliation.edge_envelopes_match).toBe(true);
  expect(evidence.reconciliation.exact).toBe(true);
  expect(evidence.edges[0].messages).toBe(2);
  expect(evidence.total_payload_bytes).toBe(20);
  expect(evidence.total_frame_bytes).toBe(32);
  clearLabTrafficForTests();
  expect(labTrafficSnapshot()).toEqual([]);
});

it('assigns unique unified identities without changing frozen scenarios or seeds', async () => {
  const selected = await driveIndependentRso5Matrix({ execute: false, identityPrefix: 'unified' });
  expect(selected).toHaveLength(20);
  expect(new Set(selected.map(run => run.executionRunId)).size).toBe(20);
  expect(selected.every(run => run.executionRunId === `unified-${run.runId}`)).toBe(true);
  expect(selected.every(run => !run.executionRunId.startsWith('matrix-'))).toBe(true);
}, 30_000);
