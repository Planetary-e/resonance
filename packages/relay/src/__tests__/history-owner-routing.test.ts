import { expect, it } from 'vitest';
import { shareHistoryOwnerRoutes } from '../history-owner-routing.js';

it('shares the same five pins independent of order without aliasing or widening either owner authorization', () => {
  const pins = Array.from({ length: 5 }, (_, i) => ({ publicKey: `key-${i}`, relayId: `relay-${i}`, viaRelayId: 'bridge' }));
  expect(shareHistoryOwnerRoutes()).toBeUndefined();
  const routes = shareHistoryOwnerRoutes(undefined, pins, [...pins].reverse()); expect(routes).toEqual(pins);
  pins[0].relayId = 'changed'; expect(routes![0].relayId).toBe('relay-0');
  for (const field of ['publicKey', 'relayId', 'viaRelayId'] as const) {
    const different = structuredClone(pins); different[0][field] += '-different';
    expect(() => shareHistoryOwnerRoutes(pins, different)).toThrow('identical');
  }
  expect(() => shareHistoryOwnerRoutes(pins, pins.slice(1))).toThrow('identical');
  expect(() => shareHistoryOwnerRoutes(pins, pins.map(({ publicKey, relayId }) => ({ publicKey, relayId })))).toThrow('identical');
});
