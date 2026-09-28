import { describe, expect, it, vi } from 'vitest';
import { verifyPrivateDestinationAddressV1 } from '../private-destination-dns.js';

const ENDPOINT = 'wss://relay.example.test/';

describe('independent private destination DNS check', () => {
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
