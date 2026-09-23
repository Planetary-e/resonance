import { describe, expect, it } from 'vitest';
import { createRelayClient } from '../relay-client.js';

describe('relay client transport boundary', () => {
  it('rejects a public cleartext primary relay before dialing', () => {
    expect(() => createRelayClient({ relayUrl: 'ws://relay.example.org/' }))
      .toThrow('Internet-facing relay endpoints require wss://');
  });

  it('rejects a public cleartext fallback before dialing', () => {
    expect(() => createRelayClient({
      relayUrl: 'wss://relay.example.org/',
      fallbackUrls: ['ws://fallback.example.org/'],
    })).toThrow('Internet-facing relay endpoints require wss://');
  });
});
