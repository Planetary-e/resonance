import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { runAdmissionHistoryCommand } from '../admission-history-command.js';
import { openHistoryVolunteerEnrollmentResume } from '../history-volunteer-enrollment.js';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'enrollment-resume-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const json = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const args = [json('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: h.context, root: h.root }),
    json('member.json', { publicKey: h.context.members[0], secretKey: Buffer.from(h.memberKeys[0].secretKey).toString('base64url') }), join(directory, 'storage.hex'), join(directory, 'history')];
  writeFileSync(args[2], h.localKey.toString('hex'));
  const options = { directory: args[3], localKey: h.localKey, context: h.context, signingKey: h.memberKeys[0], genesis: h.root };
  const runtime = { ...options, genesisId: historyCheckpointEnvelopeId(h.root) };
  const open = (signal?: AbortSignal) => { const value = openHistoryVolunteerEnrollmentResume(options, signal); cleanup.push(value.close); return value; };
  return { ...h, directory, args, options, runtime, open, manifest: join(args[3], 'genesis', 'history-manifest.json'), block: join(args[3], 'genesis', `${runtime.genesisId.slice(7)}.block`) };
}
async function crash(args: string[], boundary: string, resume = false) {
  const child = fork(fileURLToPath(new URL('./fixtures/volunteer-enrollment-crash.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let error = ''; child.stderr?.on('data', bytes => { error += String(bytes); }); child.on('message', value => { if (value !== 'ready') error += JSON.stringify(value); });
  const exited = once(child, 'exit'), timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    expect((await once(child, 'message'))[0]).toBe('ready'); child.send({ args, boundary, resume });
    const [code, signal] = await exited; expect(code, error).toBe(null); expect(signal, error).toBe('SIGKILL'); expect(error).toBe('');
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
}

it.each(['before-manifest', 'after-manifest', 'before-block', 'after-block', 'before-index', 'after-index', 'before-slot', 'after-slot'])(
  'preserves the independently pinned genesis after enrollment process death at %s', async boundary => {
    const n = fixture(); await crash(n.args, boundary);
    if (boundary === 'before-manifest') {
      expect(existsSync(n.manifest)).toBe(false); expect(() => n.open()).toThrow(); expect(existsSync(n.manifest)).toBe(false); return;
    }
    const before = readFileSync(n.manifest), prepared = n.open();
    expect(readFileSync(n.manifest)).toEqual(before);
    expect(prepared.review.phase).toBe(['after-index', 'before-slot', 'after-slot'].includes(boundary) ? 'retained' : 'genesis-pending');
    expect(() => prepared.apply('wrong')).toThrow('approval'); expect(readFileSync(n.manifest)).toEqual(before);
    expect(prepared.apply(prepared.review.approvalDigest)).toMatchObject({ result: 'enrollment-resumed', retainedBlocks: 1, startsService: false, readiness: 'unverified' });
    prepared.close(); const service = openHistoryVolunteerService(n.runtime);
    expect(service.describe().latest.envelopeId).toBe(n.runtime.genesisId); service.close();
  }, 20000);

it.each(['before-block', 'after-block', 'before-index', 'after-index'])(
  'resumes the same enrollment after another process death during explicit resumption at %s', async boundary => {
    const n = fixture(); await crash(n.args, 'after-manifest'); await crash(n.args, boundary, true);
    const prepared = n.open(); prepared.apply(prepared.review.approvalDigest); prepared.close();
    expect(JSON.parse(readFileSync(n.block, 'utf8'))).toEqual(n.root);
    const service = openHistoryVolunteerService(n.runtime); expect(service.health().retainedBlocks).toBe(1); service.close();
  }, 30000);

it('binds resumption to exact files, holds local ownership and supports cancellation', async () => {
  const n = fixture(); await crash(n.args, 'after-manifest');
  const controller = new AbortController(), prepared = n.open(controller.signal);
  expect(() => n.open()).toThrow(); controller.abort(); expect(() => prepared.apply(prepared.review.approvalDigest)).toThrow();
  expect(existsSync(n.block)).toBe(false); prepared.close();
  const plan = (await runAdmissionHistoryCommand('replica-resume-plan', n.args)).result;
  const keyBytes = readFileSync(n.args[1]); writeFileSync(n.args[1], Buffer.concat([keyBytes, Buffer.from('\n')]));
  await expect(runAdmissionHistoryCommand('replica-resume', ['--approve', String(plan.approvalDigest), ...n.args])).rejects.toThrow('approval');
  expect(existsSync(n.block)).toBe(false); writeFileSync(n.args[1], keyBytes);
  expect((await runAdmissionHistoryCommand('replica-resume', ['--approve', String(plan.approvalDigest), ...n.args])).result.result).toBe('enrollment-resumed');
});

it('retains complete accepted history and refuses missing or corrupt committed components', () => {
  const n = fixture(); openHistoryVolunteerService({ ...n.runtime, initialize: n.root }).close();
  const store = openHistoryCheckpointStore({ ...n.options, directory: join(n.args[3], 'genesis'),
    replica: n.context.members[0], rootId: n.runtime.genesisId, generation: 0 });
  const next = n.next(n.root); store.append(next); store.close();
  const before = readFileSync(n.manifest), prepared = n.open(); expect(prepared.review).toMatchObject({ phase: 'retained', retainedBlocks: 2 });
  prepared.apply(prepared.review.approvalDigest); prepared.close(); expect(readFileSync(n.manifest)).toEqual(before);
  const block = join(n.args[3], 'genesis', `${historyCheckpointEnvelopeId(next).slice(7)}.block`), bytes = readFileSync(block);
  rmSync(block); expect(() => n.open()).toThrow(); expect(existsSync(block)).toBe(false); writeFileSync(block, bytes);
  writeFileSync(n.manifest, 'corrupt'); expect(() => n.open()).toThrow(); expect(readFileSync(n.manifest, 'utf8')).toBe('corrupt');
  rmSync(n.manifest); expect(() => n.open()).toThrow(); expect(existsSync(n.manifest)).toBe(false);
});

it.each(['foreign-block', 'corrupt-root', 'recovery-guard', 'changed-files'])(
  'preserves refused interrupted files (%s)', async fault => {
    const n = fixture(); await crash(n.args, 'after-manifest'); const before = readFileSync(n.manifest);
    const path = fault === 'foreign-block' ? join(n.args[3], 'genesis', 'a'.repeat(64) + '.block')
      : fault === 'recovery-guard' ? n.manifest + '.recovery' : n.block;
    const prepared = fault === 'changed-files' ? n.open() : undefined;
    writeFileSync(path, 'keep this interrupted evidence');
    if (prepared) expect(() => prepared.apply(prepared.review.approvalDigest)).toThrow(); else expect(() => n.open()).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('keep this interrupted evidence'); expect(readFileSync(n.manifest)).toEqual(before);
  });

it.skipIf(process.platform === 'win32')('refuses a symlinked initial manifest without changing its target', async () => {
  const n = fixture(); await crash(n.args, 'after-manifest');
  const target = join(n.directory, 'saved-manifest'), bytes = readFileSync(n.manifest); writeFileSync(target, bytes); rmSync(n.manifest); symlinkSync(target, n.manifest);
  expect(() => n.open()).toThrow(); expect(readFileSync(target)).toEqual(bytes);
});


it('owns reviewed keys and pins through completion and refuses another pinned genesis', async () => {
  const n = fixture(); await crash(n.args, 'after-manifest');
  const other = historyCheckpointFixture(), before = readFileSync(n.manifest);
  expect(() => openHistoryVolunteerEnrollmentResume({ ...n.options, genesis: other.root, context: other.context })).toThrow();
  expect(readFileSync(n.manifest)).toEqual(before);
  const supplied = { ...n.options, context: structuredClone(n.context), genesis: structuredClone(n.root), localKey: Buffer.from(n.localKey),
    signingKey: { publicKey: new Uint8Array(n.memberKeys[0].publicKey), secretKey: new Uint8Array(n.memberKeys[0].secretKey) } };
  const prepared = openHistoryVolunteerEnrollmentResume(supplied); cleanup.push(prepared.close);
  supplied.signingKey.secretKey.fill(0); supplied.localKey.fill(0); supplied.context.members.reverse();
  prepared.apply(prepared.review.approvalDigest); prepared.close();
  const service = openHistoryVolunteerService(n.runtime); expect(service.describe().latest.envelopeId).toBe(n.runtime.genesisId); service.close();
});

it('keeps the enrollment authority when reviewed repair opens the volunteer service later', async () => {
  const n = fixture(); await crash(n.args, 'after-manifest');
  const authority = openStorageReservationAuthority({ directory: join(n.directory, 'quota'), mode: 'create-new',
    limitBytes: CONTROL + 64 * 1024 * 1024 + 8192 + 2 * 64 * 1024 + 8192 }); cleanup.push(authority.close);
  const reserve = vi.spyOn(authority, 'reserve'); cleanup.push(() => reserve.mockRestore());
  const prepared = withStorageReservationAuthority(authority, () => n.open());
  expect(prepared.review.phase).toBe('genesis-pending');
  const charged = authority.status(), calls = reserve.mock.calls.length, before = readFileSync(n.manifest);
  const other = openStorageReservationAuthority({ directory: join(n.directory, 'other-quota'), mode: 'create-new', limitBytes: CONTROL }); cleanup.push(other.close);
  expect(() => withStorageReservationAuthority(other, () => prepared.apply(prepared.review.approvalDigest))).toThrow(/switch/);
  expect(readFileSync(n.manifest)).toEqual(before); expect(existsSync(n.block)).toBe(false);
  expect(prepared.apply(prepared.review.approvalDigest)).toMatchObject({ result: 'enrollment-resumed', retainedBlocks: 1 });
  expect(reserve.mock.calls.length).toBeGreaterThan(calls);
  expect(authority.status()).toEqual(charged); expect(charged).toMatchObject({ components: 3, availableBytes: 0 });
});
