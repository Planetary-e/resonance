import { expect, it } from 'vitest';
import { clearLabTrafficForTests, labTrafficCount, labTrafficPage, labTrafficSince, labTrafficSnapshot, recordLabTraffic, type LabTrafficRecord } from '../sustainable-rso5-lab-transport.js';
import { appendLabTraffic, driveIndependentRso5Matrix, networkEvidence, waitForLabInterval } from '../sustainable-rso5-lab.js';

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

it('pages and slices traffic without changing record identity', () => {
  clearLabTrafficForTests();
  for (let index = 0; index < 5; index++) recordLabTraffic(record(`message-${index}`, 'sent'));
  expect(labTrafficCount()).toBe(5);
  expect(labTrafficPage(1, 2)).toEqual({ total: 5, records: [record('message-1', 'sent'), record('message-2', 'sent')] });
  expect(labTrafficSince(3)).toEqual([record('message-3', 'sent'), record('message-4', 'sent')]);
  clearLabTrafficForTests();
});

it('waits for at least the requested monotonic interval', async () => {
  const started = performance.now();
  await waitForLabInterval(10);
  expect(performance.now() - started).toBeGreaterThanOrEqual(10);
});

it('appends large traffic batches without spreading them onto the call stack', () => {
  const target: LabTrafficRecord[] = [], source = Array.from({ length: 200_000 }, (_, index) => record(`large-${index}`, 'sent'));
  appendLabTraffic(target, source);
  expect(target).toHaveLength(200_000);
  expect(target[0].messageId).toBe('large-0');
  expect(target.at(-1)?.messageId).toBe('large-199999');
});
