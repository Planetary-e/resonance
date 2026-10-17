import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import HistoryHealth from './HistoryHealth.js';
import type { RelayHistoryHealth } from '@resonance/relay';

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
  expect(renderToStaticMarkup(<HistoryHealth health={{ owner: null, volunteer: null, transport: null }} />)).toBe('');
});
