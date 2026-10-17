import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { generateIdentity } from '@resonance/core';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { createHistoryOperatorTransport, readHistoryOperatorTransportFile } from '../history-operator-transport.js';
import { loadExistingRelayIdentity, loadOrCreateRelayIdentity } from '../relay-identity-store.js';
import type { AdmissionHistoryProtection } from '../protected-admission-history.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function setup() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-operator-transport-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ids = f.context.members.map(() => generateIdentity().did), operatorId = generateIdentity().did;
  const path = join(directory, 'operator.json'), links = join(directory, 'links.json');
  const value = { version: 1, identityDirectory: 'identity', identityPassphraseFile: 'passphrase', expectedRelayId: operatorId,
    linksFile: 'links.json', deadlineMs: 15000, contacts: ids.map((relayId, i) => ({ relayId, endpoint: `ws://127.0.0.1:${9 + i}/` })) };
  writeFileSync(links, JSON.stringify({ version: 1, members: f.context.members.map((publicKey, i) => ({ publicKey, relayId: ids[i] })) }));
  const save = (v: unknown = value) => writeFileSync(path, JSON.stringify(v)); save();
  let directCalls = 0;
  const protection: AdmissionHistoryProtection = { context: f.context, signingKey: f.owner,
    members: f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${9 + i}/history-checkpoint` })),
    transport: async () => { directCalls++; throw new Error('Unexpected direct fallback'); } };
  return { ...f, directory, path, links, ids, value, save, protection, directCalls: () => directCalls };
}
it.each(['checkpoint', 'agreement', 'data', 'provision', 'compaction'] as const)('cancels a silent direct %s request through the shared operation signal', async kind => {
  const n = setup(), server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  cleanup.push(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (typeof address === 'string' || !address) throw new Error('Missing port');
  const member = { publicKey: n.context.members[0], endpoint: `ws://127.0.0.1:${address.port}/history-${kind === 'checkpoint' ? 'checkpoint' : 'agreement'}` };
  const controller = new AbortController();
  const transport = createHistoryOperatorTransport({ ...n.protection, transport: undefined }, undefined, controller.signal);
  cleanup.push(transport.close);
  const send = () => {
    const signal = new AbortController().signal;
    if (kind === 'checkpoint') return transport.protection.transport!(member, { request: { replica: member.publicKey, action: 'head' } } as never, signal);
    if (kind === 'agreement') return transport.agreementTransport(member, { request: { replica: member.publicKey, action: 'promise' } } as never, signal);
    if (kind === 'data') return transport.dataTransport(member, { action: 'read', authorization: { request: { replica: member.publicKey } } } as never, signal);
    if (kind === 'compaction') return transport.compactionTransport(member, {} as never, signal);
    return transport.provisionTransport(member, { replica: member.publicKey } as never, signal);
  };
  const connection = once(server, 'connection');
  const pending = Promise.resolve().then(send), rejected = expect(pending).rejects.toThrow('cancelled');
  const [socket] = await connection; const received = once(socket, 'message'); await received;
  const closed = once(socket, 'close'); controller.abort(); await rejected; await closed;
  expect(server.clients.size).toBe(0);
  await expect(Promise.resolve().then(send)).rejects.toThrow('cancelled');
});
it('keeps offline adapters lazy, refuses missing identity without replacement or direct fallback', async () => {
  const n = setup(), transport = createHistoryOperatorTransport(n.protection, n.path); cleanup.push(transport.close);
  expect(existsSync(join(n.directory, 'identity'))).toBe(false);
  expect(n.directCalls()).toBe(0);
  const send = () => transport.protection.transport!(n.protection.members[0], {} as never, new AbortController().signal);
  await expect(Promise.resolve().then(send)).rejects.toThrow('passphrase file');
  expect(existsSync(join(n.directory, 'identity'))).toBe(false); expect(n.directCalls()).toBe(0);
  await expect(Promise.resolve().then(send)).rejects.toThrow('unavailable');
});
it('rejects unknown fields, unpinned contacts, insecure transport, duplicate and incomplete routes', () => {
  const n = setup();
  for (const bad of [{ ...n.value, extra: true }, { ...n.value, deadlineMs: 300001 }, { ...n.value, contacts: [] },
    { ...n.value, contacts: n.value.contacts.map(() => n.value.contacts[0]) },
    { ...n.value, contacts: n.value.contacts.map((c, i) => i ? c : { ...c, relayId: generateIdentity().did }) },
    { ...n.value, contacts: n.value.contacts.map((c, i) => i ? c : { ...c, endpoint: 'ws://example.com/' }) }]) {
    n.save(bad); expect(() => readHistoryOperatorTransportFile(n.path, n.context)).toThrow();
  }
  expect(n.directCalls()).toBe(0);
});
it('reads an encrypted retained identity without rewriting it and refuses plaintext, missing or oversized keys', () => {
  const n = setup(), directory = join(n.directory, 'identity'), passphrase = 'operator retained secret';
  const original = loadOrCreateRelayIdentity(directory), path = join(directory, 'relay-identity.json');
  expect(() => loadExistingRelayIdentity(directory, passphrase)).toThrow('already be encrypted');
  loadOrCreateRelayIdentity(directory, passphrase).secretKey.fill(0);
  const before = readFileSync(path), stat = statSync(path), reopened = loadExistingRelayIdentity(directory, passphrase);
  expect(reopened.did).toBe(original.did); expect(readFileSync(path)).toEqual(before); expect(statSync(path).mtimeMs).toBe(stat.mtimeMs);
  expect(() => loadExistingRelayIdentity(join(n.directory, 'absent'), passphrase)).toThrow();
  expect(existsSync(join(n.directory, 'absent'))).toBe(false);
  expect(() => loadExistingRelayIdentity(directory, 'wrong password of sufficient length')).toThrow();
  writeFileSync(path, ' '.repeat(4097)); expect(() => loadExistingRelayIdentity(directory, passphrase)).toThrow('regular file');
  reopened.secretKey.fill(0); original.secretKey.fill(0);
});
it('closes a silent pending handshake at the whole-session deadline without a direct retry', async () => {
  const n = setup(), sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const identity = loadOrCreateRelayIdentity(join(n.directory, 'identity'), 'operator retained secret');
  writeFileSync(join(n.directory, 'passphrase'), 'operator retained secret');
  const bridgeId = generateIdentity().did;
  writeFileSync(n.links, JSON.stringify({ version: 2, members: n.context.members.map((publicKey, i) => ({ publicKey, relayId: n.ids[i] })),
    bridge: { relayId: bridgeId, endpoint: `ws://127.0.0.1:${address.port}/` } }));
  n.save({ ...n.value, expectedRelayId: identity.did, deadlineMs: 500, contacts: [] });
  identity.secretKey.fill(0);
  const transport = createHistoryOperatorTransport(n.protection, n.path); cleanup.push(transport.close);
  const connection = once(server, 'connection');
  const pending = Promise.resolve().then(() => transport.protection.transport!(n.protection.members[0],
    { request: { replica: n.context.members[0] } } as never, new AbortController().signal));
  const rejection = expect(pending).rejects.toThrow();
  const [socket] = await connection; socket.resume(); const ended = once(socket, 'close');
  await rejection; await ended; expect(sockets.size).toBe(0); expect(n.directCalls()).toBe(0);
  await expect(Promise.resolve().then(() => transport.agreementTransport!(n.protection.members[0], {} as never, new AbortController().signal))).rejects.toThrow('unavailable');
}, 10000);

it('refuses a different retained infrastructure identity before dialing any history transport', async () => {
  const n = setup();
  loadOrCreateRelayIdentity(join(n.directory, 'identity'), 'operator retained secret').secretKey.fill(0);
  writeFileSync(join(n.directory, 'passphrase'), 'operator retained secret');
  const transport = createHistoryOperatorTransport(n.protection, n.path); cleanup.push(transport.close);
  await expect(Promise.resolve().then(() => transport.protection.transport!(n.protection.members[0], {} as never,
    new AbortController().signal))).rejects.toThrow('does not match');
  expect(n.directCalls()).toBe(0);
});

it.skipIf(process.platform === 'win32')('cancels a CLI inspection on SIGTERM while its bridge handshake is silent', async () => {
  const n = setup(), sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.resume(); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const identity = loadOrCreateRelayIdentity(join(n.directory, 'identity'), 'operator retained secret');
  writeFileSync(join(n.directory, 'passphrase'), 'operator retained secret');
  writeFileSync(n.links, JSON.stringify({ version: 2, members: n.context.members.map((publicKey, i) => ({ publicKey, relayId: n.ids[i] })),
    bridge: { relayId: generateIdentity().did, endpoint: `ws://127.0.0.1:${address.port}/` } }));
  n.save({ ...n.value, expectedRelayId: identity.did, contacts: [], deadlineMs: 300000 }); identity.secretKey.fill(0);
  const key = join(n.directory, 'owner.json'), config = join(n.directory, 'history.json'), enrollment = join(n.directory, 'enrollment.json');
  writeFileSync(key, JSON.stringify({ publicKey: Buffer.from(n.owner.publicKey).toString('base64url'), secretKey: Buffer.from(n.owner.secretKey).toString('base64url') }));
  writeFileSync(config, JSON.stringify({ version: 1, context: n.context, members: n.protection.members, ownerKeyFile: key }));
  writeFileSync(enrollment, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.root }));
  const script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url)), connected = once(server, 'connection');
  const child = spawn(process.execPath, ['--import', 'tsx', script, 'owner-inspect', config, enrollment],
    { stdio: 'ignore', env: { ...process.env, RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE: n.path } });
  const exited = once(child, 'exit'); cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const [socket] = await connected, closed = once(socket, 'close');
  child.kill('SIGTERM'); expect(await exited).toEqual([1, null]); await closed;
  expect(sockets.size).toBe(0); expect(n.directCalls()).toBe(0);
}, 10000);

it('does not read secrets or start a session for a pre-cancelled exchange', async () => {
  const n = setup(), transport = createHistoryOperatorTransport(n.protection, n.path), controller = new AbortController();
  cleanup.push(transport.close); controller.abort();
  await expect(Promise.resolve().then(() => transport.protection.transport!(n.protection.members[0], {} as never, controller.signal))).rejects.toThrow('request cancelled');
  // A later valid exchange still attempts the original configured identity.
  await expect(Promise.resolve().then(() => transport.protection.transport!(n.protection.members[0], {} as never, new AbortController().signal))).rejects.toThrow('passphrase file');
  expect(n.directCalls()).toBe(0);
});
it.skipIf(process.platform === 'win32')('refuses a named pipe identity without blocking on its open', () => {
  const n = setup(), directory = join(n.directory, 'identity');
  loadOrCreateRelayIdentity(directory, 'operator retained secret').secretKey.fill(0);
  const path = join(directory, 'relay-identity.json'); rmSync(path); execFileSync('mkfifo', [path]);
  expect(() => loadExistingRelayIdentity(directory, 'operator retained secret')).toThrow('regular file');
});
