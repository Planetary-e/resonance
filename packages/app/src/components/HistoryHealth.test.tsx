import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import HistoryHealth from './HistoryHealth.js';
import type { RelayHistoryHealth } from '@resonance/relay';

it('distinguishes observer startup and local policy failures without implying a current remote quorum', () => {
  const health: RelayHistoryHealth = { owner: null, volunteer: null, transport: null, observer: { state: 'starting' } };
  expect(renderToStaticMarkup(<HistoryHealth health={health} />)).toContain('Its listener is not ready');
  health.observer = { state: 'unavailable' };
  expect(renderToStaticMarkup(<HistoryHealth health={health} />)).toContain('Retain its history for inspection');
  const usage = { pending: false, listening: true, policyCurrent: true, blocked: false, fenced: false,
    retainedBlocks: 2, retainedCiphertextBytes: 800, maximumBlocks: 100, maximumCiphertextBytes: 16000000 };
  health.observer = { state: 'available', usage };
  const html = renderToStaticMarkup(<HistoryHealth health={health} />);
  expect(html).toContain('Each observation still requires four current history copies');
  expect(html).toContain('Observer history: 2 / 100 blocks'); expect(html).toContain('do not confirm current remote copies');
  for (const [change, text] of [
    [{ pending: true }, 'unfinished policy update'], [{ listening: false }, 'accepted work is draining'],
    [{ policyCurrent: false }, 'needs a current signed policy'], [{ blocked: true }, 'conflicting signed policies'],
    [{ fenced: true }, 'retired by recovery'],
  ] as const) {
    health.observer = { state: 'available', usage: { ...usage, ...change } };
    expect(renderToStaticMarkup(<HistoryHealth health={health} />)).toContain(text);
  }
});

it('explains local retention, unfinished work and unknown observations without reporting a live quorum', () => {
  const health: RelayHistoryHealth = {
    owner: { state: 'available', usage: { initialized: true, busy: false, pending: true,
      retainedBlocks: 2, retainedCiphertextBytes: 1048576, maximumBlocks: 100, maximumCiphertextBytes: 16777216 } },
    volunteer: { state: 'unavailable' },
    transport: { state: 'available', usage: { configuredMembers: 5, connectedDirectMembers: 0, configuredOwnerBridges: 1, connectedOwnerBridges: 1,
      configuredBridgeRoutes: 0, connectedBridgeTargets: 0, configuredControllers: 0, connectedControllers: 0,
      operations: 2, maximumOperations: 8, bufferBytes: 1048576, maximumBufferBytes: 67108864 } },
  };
  const html = renderToStaticMarkup(<HistoryHealth health={health} />);
  expect(html).toContain('unfinished history update'); expect(html).toContain('2 / 100 blocks');
  expect(html).toContain('Volunteer history status is unavailable'); expect(html).toContain('Checking status does not clear saved history');
  expect(html).toContain('0 direct member connections'); expect(html).toContain('1 / 1 bridge connections');
  expect(html).toContain('do not confirm current remote copies');
  if (health.transport?.state === 'available') health.transport.usage.configuredLocalMembers = 1;
  const coLocated = renderToStaticMarkup(<HistoryHealth health={health} />);
  expect(coLocated).toContain('hosted on this device and uses a local route');
  expect(coLocated).toContain('needs confirmation from four members');
  expect(renderToStaticMarkup(<HistoryHealth health={{ owner: null, volunteer: null, transport: null }} />)).toBe('');
});

it('explains that collection capacities and generations are totals across independent histories', () => {
  const health: RelayHistoryHealth = { owner: null, transport: null, volunteer: { state: 'available', usage: {
    histories: 5, generations: 6, maximumGenerations: 40, retainedBlocks: 9, stagedBlocks: 0, retainedCiphertextBytes: 30000,
    manifestReserveBytes: 25165824, reservedBytes: 25195824, currentGenerationReservedBytes: 21001520, currentGenerationBlocks: 7,
    maximumGenerationBytes: 83886080, maximumGenerationBlocks: 5000, maximumAncestryBytes: 1342177280,
  } } };
  const html = renderToStaticMarkup(<HistoryHealth health={health} />);
  expect(html).toContain('5 independent histories'); expect(html).toContain('totals cover all of them'); expect(html).toContain('6 / 40 history generations');
});
