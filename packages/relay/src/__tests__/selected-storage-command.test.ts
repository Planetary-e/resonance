import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import * as listeners from '../history-agreement-exchange.js';
import { exchangeHistoryCheckpoint } from '../history-checkpoint-exchange.js';
import { openStorageReservationAuthority, withStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL } from '@resonance/core/storage-reservations';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { openRelayStorageOwner } from '../relay-storage-owner.js';
import { beginRelayMaintenance, acquireStoppedRelayMaintenance } from '../relay-maintenance.js';
import { runSelectedAdmissionHistoryCommand } from '../selected-admission-history-command.js';
import { openSelectedRelayStorageOwner } from '../selected-relay-storage.js';
import * as reader from '../relay-storage-selection.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const portHolder = createServer(); portHolder.listen(0, '127.0.0.1'); await once(portHolder, 'listening');
  const runtimePort = (portHolder.address() as { port: number }).port; await new Promise<void>(resolve => portHolder.close(() => resolve()));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'selected-operator-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), data = join(directory, 'data'); mkdirSync(data);
  const f = historyCheckpointFixture();
  const enrollment = join(data, 'enrollment.json'), member = join(data, 'member.json'), key = join(data, 'member.hex'), replica = join(data, 'replica');
  writeFileSync(enrollment, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context: f.context, root: f.root }));
  writeFileSync(member, JSON.stringify({ publicKey: Buffer.from(f.memberKeys[0].publicKey).toString('base64url'), secretKey: Buffer.from(f.memberKeys[0].secretKey).toString('base64url') }));
  writeFileSync(key, f.key.toString('hex'));
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + 200 * 1024 * 1024 }); cleanup.push(authority.close);
  const targets = [{ path: data, scope: 'directory' as const }]; authority.adoptExisting(targets, authority.reviewExisting(targets).approvalDigest);
  withStorageReservationAuthority(authority, () => openHistoryVolunteerService({ directory: replica, context: f.context, genesisId: f.options.rootId,
    signingKey: f.memberKeys[0], localKey: f.key, initialize: f.root }).close());
  const selection = { authorityDirectory: ledger, authorityId: authority.status().authorityId, runtimeDirectory: join(data, 'relay-data') }; authority.close();
  const runtime = openRelayStorageOwner(selection, 'runtime'); runtime.run(() => beginRelayMaintenance(selection.runtimeDirectory)); runtime.close();
  const owner = openRelayStorageOwner(selection, 'maintenance'), file = join(data, 'selection.json');
  const binding = { runtimePort, runtimeHost: '127.0.0.1' as const };
  owner.exportSelection(file, binding, owner.reviewSelectionOutput(file, binding).approvalDigest); owner.close();
  const capped = openStorageReservationAuthority({ directory: ledger, authorityId: selection.authorityId, mode: 'open-existing' });
  const limit = capped.reviewLimit(capped.status().reservedBytes); capped.applyLimit(limit.limitBytes, limit.approvalDigest); capped.close();
  return { f, runtimePort, directory, data, ledger, file, selection, args: [enrollment, member, key, replica, '0'] };
}
it('retains the selected authority and runtime claim until the actual volunteer listener stops', async () => {
  const n = await fixture(), operation = await runSelectedAdmissionHistoryCommand(n.file, 'replica-serve', n.args); cleanup.push(() => operation.stop?.());
  expect(operation.result.event).toBe('history_volunteer_listening');
  expect(() => openStorageReservationAuthority({ directory: n.ledger, authorityId: n.selection.authorityId, mode: 'open-existing' })).toThrow(/already open/);
  expect(() => acquireStoppedRelayMaintenance(n.selection.runtimeDirectory)).toThrow(/already open/);
  const delta = n.f.next(n.f.root), issuedAt = Date.now();
  const request = createHistoryExchangeRequest({ action: 'append', replica: n.f.context.members[0], rootId: n.f.options.rootId,
    generation: 0, sequence: 1, envelopeId: historyCheckpointEnvelopeId(delta), issuedAt, expiresAt: issuedAt + 30000, challenge: randomBytes(32).toString('base64url') }, n.f.context, n.f.owner);
  const member = { publicKey: n.f.context.members[0], endpoint: String(operation.result.checkpointEndpoint) };
  const response_ = await exchangeHistoryCheckpoint(member, { request, envelope: delta }, AbortSignal.timeout(3000));
  expect(parseHistoryExchangeResponse(response_, request, n.f.context).status).toBe('stored');
  const endpoint = new URL(String(operation.result.checkpointEndpoint));
  const response = await fetch(`http://${endpoint.host}/`); expect(response.status).toBe(404);
  const first = operation.stop!(); expect(operation.stop!()).toBe(first); await first;
  await expect(fetch(`http://${endpoint.host}/`)).rejects.toThrow();
  const reopened = openRelayStorageOwner(n.selection, 'maintenance'); expect(reopened.status().availableBytes).toBe(0); reopened.close();
  const again = await runSelectedAdmissionHistoryCommand(n.file, 'replica-serve', n.args); cleanup.push(() => again.stop?.());
  const now = Date.now(), head = createHistoryExchangeRequest({ action: 'head', replica: n.f.context.members[0], rootId: n.f.options.rootId,
    generation: 0, sequence: 0, envelopeId: null, issuedAt: now, expiresAt: now + 30000, challenge: randomBytes(32).toString('base64url') }, n.f.context, n.f.owner);
  const retained = await exchangeHistoryCheckpoint({ ...member, endpoint: String(again.result.checkpointEndpoint) }, { request: head, envelope: null }, AbortSignal.timeout(3000));
  expect(parseHistoryExchangeResponse(retained, head, n.f.context).head.sequence).toBe(1); await again.stop!();
}, 20000);
it('closes ownership after a real inventory command or a refused command', async () => {
  const n = await fixture(); expect((await runSelectedAdmissionHistoryCommand(n.file, 'storage-inventory', [n.data])).result.kind).toBe('storage-inventory');
  await expect(runSelectedAdmissionHistoryCommand(n.file, 'invalid-command', [])).rejects.toThrow(/Invalid/);
  const reopened = openRelayStorageOwner(n.selection, 'maintenance'); reopened.close();
});

it('reviews a fixed history pool under stopped selected ownership and refuses unfunded activation before preserving a funded reopen', async () => {
  const n = await fixture(), args = [...n.args.slice(0, 4), '2'];
  const review = await runSelectedAdmissionHistoryCommand(n.file, 'replica-pool-plan', args);
  expect(review.result).toMatchObject({ slots: 2, readiness: 'unverified' });
  const approved = ['--approve', String(review.result.approvalDigest), ...args];
  await expect(runSelectedAdmissionHistoryCommand(n.file, 'replica-pool-enable', approved)).rejects.toThrow('exhausted');
  const authority = openStorageReservationAuthority({ directory: n.ledger, authorityId: n.selection.authorityId, mode: 'open-existing' });
  const limit = CONTROL + 200 * 1024 * 1024; authority.applyLimit(limit, authority.reviewLimit(limit).approvalDigest); authority.close();
  expect((await runSelectedAdmissionHistoryCommand(n.file, 'replica-pool-enable', approved)).result).toMatchObject({ result: 'history-pool-enabled', readiness: 'unverified' });
  const owner = openRelayStorageOwner(n.selection, 'maintenance'), funded = owner.status(); owner.close();
  const serving = await runSelectedAdmissionHistoryCommand(n.file, 'replica-serve', n.args); cleanup.push(() => serving.stop?.());
  expect(serving.result.generations).toBe(1); await serving.stop!();
  const reopened = openRelayStorageOwner(n.selection, 'maintenance'); expect(reopened.status()).toEqual(funded); reopened.close();
}, 20000);

it.each(['replacement', 'corruption'] as const)('refuses a selection %s during ownership acquisition and releases its claims', async change => {
  const n = await fixture(), read = reader.readRelayStorageSnapshot; let first = true;
  vi.spyOn(reader, 'readRelayStorageSnapshot').mockImplementation(file => {
    const snapshot = read(file);
    if (first) { first = false; const bytes = readFileSync(file); renameSync(file, file + '-retained'); writeFileSync(file, change === 'replacement' ? bytes : 'corrupt selection'); }
    return snapshot;
  });
  await expect(runSelectedAdmissionHistoryCommand(n.file, 'storage-inventory', [n.data])).rejects.toThrow(/changed|invalid/);
  const owner = openRelayStorageOwner(n.selection, 'maintenance'); owner.close();
});
it('refuses a runtime directory mismatch before opening ownership and honours pre-cancelled commands', async () => {
  const n = await fixture(), before = readFileSync(join(n.ledger, 'reservations.json'));
  await expect(openSelectedRelayStorageOwner(n.file, { purpose: 'runtime', runtimeDirectory: join(n.directory, 'wrong'), runtimePort: n.runtimePort, runtimeHost: '127.0.0.1' })).rejects.toThrow(/differs/);
  await expect(runSelectedAdmissionHistoryCommand(n.file, 'storage-inventory', [n.data], { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
});

it('holds ownership through actual asynchronous listener shutdown and releases after a reported shutdown failure', async () => {
  const n = await fixture(), listen = listeners.listenHistoryAgreementReplica; let closes = 0;
  vi.spyOn(listeners, 'listenHistoryAgreementReplica').mockImplementation(async (...args) => {
    const server = await listen(...args);
    return { ...server, async close() { closes++; await server.close(); throw new Error('shutdown confirmation failed'); } };
  });
  const operation = await runSelectedAdmissionHistoryCommand(n.file, 'replica-serve', n.args);
  cleanup.push(() => operation.stop?.().catch(() => {}));
  const stopping = operation.stop!();
  expect(() => openRelayStorageOwner(n.selection, 'maintenance')).toThrow(/already open/);
  await expect(stopping).rejects.toThrow(/shutdown confirmation failed/);
  expect(operation.stop!()).toBe(stopping); expect(closes).toBe(1);
  const owner = openRelayStorageOwner(n.selection, 'maintenance'); owner.close();
});

it('refuses a live configured listener even when an older process owns no runtime or authority lock', async () => {
  const n = await fixture(), legacy = createServer(); legacy.listen(n.runtimePort, '127.0.0.1'); await once(legacy, 'listening');
  cleanup.push(() => new Promise<void>(resolve => legacy.close(() => resolve())));
  await expect(runSelectedAdmissionHistoryCommand(n.file, 'storage-inventory', [n.data])).rejects.toThrow(/listener is not closed/);
  const released = openRelayStorageOwner(n.selection, 'maintenance'); released.close();
});

it('selects the authority in the actual CLI process and retains it until SIGTERM closes its listener', async () => {
  const n = await fixture(), inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RESONANCE_')));
  const script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script, 'replica-serve', ...n.args], {
    env: { ...inherited, RESONANCE_RELAY_STORAGE_SELECTION_FILE: n.file }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit'); let output = '', listening = false;
  const read = (bytes: Buffer) => { output += String(bytes); listening ||= output.includes('history_volunteer_listening'); };
  child.stdout.on('data', read); child.stderr.on('data', read);
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const deadline = performance.now() + 10000;
  while (!listening) { if (child.exitCode !== null || child.signalCode !== null || performance.now() > deadline) throw new Error(`CLI did not start: ${output}`); await new Promise(resolve => setTimeout(resolve, 20)); }
  expect(() => openRelayStorageOwner(n.selection, 'maintenance')).toThrow(/already open/);
  child.kill('SIGTERM'); expect((await exited)[0]).toBe(0);
  const owner = openRelayStorageOwner(n.selection, 'maintenance'); expect(owner.status().availableBytes).toBe(0); owner.close();
}, 15000);
it.each(['admission-history.ts', 'retire-admission-history.ts', 'recover-admission-spends.ts'])('refuses a missing explicit selection in %s before interpreting its command', async script => {
  const n = await fixture(), child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(`../../../../scripts/${script}`, import.meta.url)), 'storage-inventory', n.data], {
    env: { ...process.env, RESONANCE_RELAY_STORAGE_SELECTION_FILE: n.file + '-missing' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit'); let output = ''; child.stdout.on('data', bytes => { output += String(bytes); });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await exited)[0]).toBe(1); expect(output).toBe('');
});

it.each(['admission-policy.ts', 'rotate-admission-policy.ts', 'issue-admission-tokens.ts'])('refuses to ignore an explicit relay budget in the separate offline tool %s', async script => {
  const n = await fixture(), child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(`../../../../scripts/${script}`, import.meta.url))], {
    env: { ...process.env, RESONANCE_RELAY_STORAGE_SELECTION_FILE: n.file }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit'); let output = ''; child.stderr.on('data', bytes => { output += String(bytes); });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await exited)[0]).toBe(1); expect(output).toContain('do not use the relay storage budget');
});
