import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { checkRelayTlsServerIdentity } from '@resonance/core';

const certificate = new X509Certificate(readFileSync(new URL('./fixtures/tls/localhost.crt', import.meta.url))).toLegacyObject();
it.each(['::1', '0:0:0:0:0:0:0:1', '127.0.0.1', 'localhost'])('matches the authenticated certificate for %s', host => {
  expect(checkRelayTlsServerIdentity(host, certificate)).toBeUndefined();
});
it.each(['::2', '::ffff:127.0.0.1', '127.0.0.2', 'evil.localhost', '::1.evil.example'])('refuses another address or name %s', host => {
  expect(checkRelayTlsServerIdentity(host, certificate)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});
it('uses authenticated DER for IPv6 and refuses missing/malformed certificates', () => {
  expect(checkRelayTlsServerIdentity('::2', { ...certificate, subjectaltname: 'IP Address:::2' })).toBeInstanceOf(Error);
  expect(checkRelayTlsServerIdentity('::1', { ...certificate, raw: Buffer.from('bad certificate') })).toBeInstanceOf(Error);
  expect(checkRelayTlsServerIdentity('::1', { ...certificate, raw: undefined as any })).toBeInstanceOf(Error);
});
