import { describe, expect, it } from 'vitest';
import { assertSecureRelayTransportEndpoint } from '../relay-transport.js';

describe('relay transport boundary', () => {
  it.each([
    'wss://relay.example.org/',
    'ws://localhost:9000/',
    'ws://127.0.0.1:9000/',
    'ws://10.0.1.2:9000/',
    'ws://172.31.0.1:9000/',
    'ws://192.168.1.2:9000/',
    'ws://[::1]:9000/',
    'ws://[fd12::1]:9000/',
    'ws://[fe80::1]:9000/',
  ])('accepts %s', endpoint => {
    expect(() => assertSecureRelayTransportEndpoint(endpoint)).not.toThrow();
  });

  it.each([
    'ws://relay.example.org/',
    'ws://198.51.100.8:9000/',
    'ws://8.8.8.8:9000/',
    'ws://[2606:4700:4700::1111]:9000/',
    'ws://localhost.example.org/',
    'ws://0.0.0.0:9000/',
    'ws://172.32.0.1:9000/',
    'ws://192.169.1.2:9000/',
    'http://relay.example.org/',
  ])('rejects insecure or invalid %s', endpoint => {
    expect(() => assertSecureRelayTransportEndpoint(endpoint)).toThrow();
  });

  it('rejects credentials and URL metadata', () => {
    expect(() => assertSecureRelayTransportEndpoint('wss://user:secret@relay.example.org/')).toThrow();
    expect(() => assertSecureRelayTransportEndpoint('wss://relay.example.org/?token=secret')).toThrow();
    expect(() => assertSecureRelayTransportEndpoint('wss://relay.example.org/#fragment')).toThrow();
  });
});
