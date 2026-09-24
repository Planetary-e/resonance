import { describe, expect, it } from 'vitest';
import { parseLanBeacon } from '../lan-discovery.js';

describe('LAN relay hints', () => {
  it('uses only the sender address and a bounded port', () => {
    expect(parseLanBeacon(Buffer.from('resonance-lan-v1:9091'), '192.168.1.7'))
      .toBe('ws://192.168.1.7:9091/');
    expect(parseLanBeacon(Buffer.from('resonance-lan-v1:99999'), '192.168.1.7'))
      .toBeNull();
    expect(parseLanBeacon(Buffer.from('resonance-lan-v1:9091:evil.example'), '192.168.1.7'))
      .toBeNull();
    expect(parseLanBeacon(Buffer.from('resonance-lan-v1:9091'), 'evil.example'))
      .toBeNull();
    expect(parseLanBeacon(Buffer.from('x'.repeat(65)), '192.168.1.7'))
      .toBeNull();
  });
});
