import { describe, expect, it, vi } from 'vitest';
import { Resolver } from 'node:dns/promises';
import { verifyPrivateDestinationAddressV1 } from '../private-destination-dns.js';

const ENDPOINT = 'wss://relay.example.test/';

describe('independent private destination DNS check', () => {
  it('cancels both native DNS queries when the operation is aborted', async () => {
    const controller = new AbortController();
    const queries: Array<(error: Error) => void> = [];
    const resolve4 = vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation(() => new Promise((_, reject) => { queries.push(reject); }));
    const resolve6 = vi.spyOn(Resolver.prototype, 'resolve6').mockImplementation(() => new Promise((_, reject) => { queries.push(reject); }));
    const cancel = vi.spyOn(Resolver.prototype, 'cancel').mockImplementation(() => {
      queries.forEach(reject => reject(Object.assign(new Error('Cancelled'), { code: 'ECANCELLED' })));
    });
    try {
      const pending = verifyPrivateDestinationAddressV1(ENDPOINT, '203.0.113.10', '198.51.100.5', undefined, controller.signal);
      const reason = new Error('Operation deadline');
      const outcome = expect(pending).rejects.toBe(reason);
      await Promise.resolve();
      expect(queries).toHaveLength(2);
      controller.abort(reason);
      await outcome;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { resolve4.mockRestore(); resolve6.mockRestore(); cancel.mockRestore(); }
  });

  it('aborts a stalled lookup and ignores its late answer', async () => {
    const controller = new AbortController();
    let complete!: (addresses: string[]) => void;
    const lookup = vi.fn(() => new Promise<string[]>(resolve => { complete = resolve; }));
    const pending = verifyPrivateDestinationAddressV1(ENDPOINT, '203.0.113.10', '198.51.100.5', lookup, controller.signal);
    const reason = new Error('Operation deadline');
    const result = expect(pending).rejects.toBe(reason);
    await Promise.resolve();
    controller.abort(reason);
    await result;
    expect(lookup).toHaveBeenCalledWith('relay.example.test', controller.signal);
    complete(['203.0.113.10']);
    await expect(verifyPrivateDestinationAddressV1(
      ENDPOINT, '203.0.113.10', '198.51.100.5', lookup, controller.signal,
    )).rejects.toBe(reason);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('accepts a reported address only when all independently resolved addresses avoid the entry domain', async () => {
    const lookup = vi.fn(async () => ['203.0.113.10', '2001:db8:2::10']);
    await verifyPrivateDestinationAddressV1(
      ENDPOINT, '203.0.113.10', '198.51.100.5', lookup,
    );
    expect(lookup).toHaveBeenCalledWith('relay.example.test');
  });

  it('rejects a fabricated entry observation and ambiguous overlapping DNS answers', async () => {
    await expect(verifyPrivateDestinationAddressV1(
      ENDPOINT, '203.0.113.11', '198.51.100.5',
      async () => ['203.0.113.10'],
    )).rejects.toThrow('absent from independent DNS');
    await expect(verifyPrivateDestinationAddressV1(
      ENDPOINT, '203.0.113.10', '198.51.100.5',
      async () => ['203.0.113.10', '198.51.100.99'],
    )).rejects.toThrow('overlap the entry');
  });

  it('fails closed on an unavailable or unbounded DNS answer', async () => {
    await expect(verifyPrivateDestinationAddressV1(
      ENDPOINT, '203.0.113.10', '198.51.100.5', async () => [],
    )).rejects.toThrow('unavailable or invalid');
    await expect(verifyPrivateDestinationAddressV1(
      ENDPOINT, '203.0.113.10', '198.51.100.5', async () => Array(65).fill('203.0.113.10'),
    )).rejects.toThrow('unavailable or invalid');
    await expect(verifyPrivateDestinationAddressV1(
      ENDPOINT, '203.0.113.10', '198.51.100.5', async () => { throw new Error('DNS offline'); },
    )).rejects.toThrow('DNS offline');
  });

  it('checks a signed literal-IP endpoint without sending any DNS request', async () => {
    const lookup = vi.fn(async () => ['203.0.113.99']);
    await verifyPrivateDestinationAddressV1(
      'wss://203.0.113.10/', '203.0.113.10', '198.51.100.5', lookup,
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
