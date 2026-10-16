import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyContinuationRootId } from '@resonance/core/history-continuation';
import { createHistoryProvisionReceipt, parseHistoryProvisionReceipt, parseHistoryProvisionRequest } from '@resonance/core/history-provision';
import { openHistoryGenerationProvisioner, HISTORY_PROVISION_FILENAME } from '../history-generation-provisioner.js';
import { HISTORY_MANIFEST_FILENAME } from '../history-checkpoint-store.js';
import { historyProvisionFixture } from './fixtures/history-provision-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const cleanup: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); cleanup.splice(0).reverse().forEach(f => f()); });
function fixture() { const n = historyProvisionFixture(); cleanup.push(() => n.close()); return n; }
function open(n: ReturnType<typeof fixture>, initialize = true) {
  const role = openHistoryGenerationProvisioner({ ...n.provisionOptions(), initialize }); cleanup.push(() => role.close()); return role;
}

describe('bounded authenticated history generation provisioning', () => {
  it('binds requests and receipts to fresh owner intent, decided proof and the pinned target', () => {
    const n = fixture(), request = n.request(), receipt = createHistoryProvisionReceipt(request, n.memberKeys[0]);
    expect(parseHistoryProvisionReceipt(receipt, request)).toEqual(receipt);
    for (const changed of [{ ...request, replica: n.context.members[1] }, { ...request, expiresAt: 99_999 },
      { ...request, root: { ...request.root, proposal: n.b } }, { ...request, signature: n.request(1).signature },
      { ...request, extra: true }, { ...request, challenge: 'invalid' }]) expect(() => parseHistoryProvisionRequest(changed, n.context, 10_000)).toThrow();
    expect(() => parseHistoryProvisionRequest(request, n.context, 40_000)).toThrow('expired');
    expect(() => parseHistoryProvisionRequest(request, n.context, 9_999)).toThrow('expired');
    expect(() => parseHistoryProvisionReceipt(receipt, n.request())).toThrow();
    expect(() => parseHistoryProvisionReceipt({ ...receipt, signature: n.memberKeys[1].publicKey.toString() }, request)).toThrow();
    expect(() => createHistoryProvisionReceipt(request, n.memberKeys[1])).toThrow('signer');
  });

  it('creates once, reopens without traffic, preserves appended child records on retry and retains its predecessor', () => {
    const n = fixture(), before = n.stores[0].read(); let role = open(n);
    expect(role.child()).toBeNull(); expect(role.read().phase).toBe('empty');
    expect(() => role.provision(n.request(1))).toThrow('predecessor');
    expect(role.read().phase).toBe('empty');
    const request = n.request(); expect(parseHistoryProvisionReceipt(role.provision(request), request)).toBeTruthy();
    const delta = n.next(n.continuation); role.child()!.append(delta);
    role.close(); role = open(n, false);
    expect(role.child()!.read().envelopes).toEqual([n.continuation, delta]);
    role.provision(n.request()); expect(role.child()!.read().envelopes).toEqual([n.continuation, delta]);
    expect(n.stores[0].read()).toEqual(before);
    const raw = readFileSync(join(n.provisionOptions().directory, HISTORY_PROVISION_FILENAME), 'utf8');
    expect(raw).not.toContain(historyContinuationRootId(n.continuation));
    expect(() => open(n)).toThrow('not empty');
  });

  it('refuses missing or corrupt published state without recreating it', () => {
    const n = fixture(); const role = open(n); role.provision(n.request()); role.close();
    const directory = n.provisionOptions().directory, child = join(directory, `generation-${historyContinuationRootId(n.continuation).slice(7)}`);
    const manifest = join(child, HISTORY_MANIFEST_FILENAME), saved = readFileSync(manifest);
    rmSync(manifest); expect(() => open(n, false)).toThrow(); expect(existsSync(manifest)).toBe(false);
    writeFileSync(manifest, '{}'); expect(() => open(n, false)).toThrow(); expect(readFileSync(manifest, 'utf8')).toBe('{}');
    writeFileSync(manifest, saved); renameSync(child, `${child}.saved`);
    expect(() => open(n, false)).toThrow(); expect(existsSync(child)).toBe(false);
  });

  it('honors the owner storage pause before activating the parent', () => {
    const n = fixture(); const role = openHistoryGenerationProvisioner({ ...n.provisionOptions(), initialize: true, acceptNew: () => false });
    cleanup.push(() => role.close());
    expect(() => role.provision(n.request())).toThrow('paused');
    expect(n.stores[0].activatedContinuation()).toBeNull(); expect(role.read().phase).toBe('empty');
    expect(readdirSync(n.provisionOptions().directory).filter(name => name.startsWith('.creating-'))).toEqual([]);
  });

  it.each(['unknown-file', 'corrupt-root'])('retains and refuses damaged staging contents: %s', damage => {
    const n = fixture(); let role = open(n), calls = 0;
    vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === 10) throw new Error('interrupted root flush'); actualFsync(fd); });
    expect(() => role.provision(n.request())).toThrow('interrupted root');
    vi.mocked(fsyncSync).mockImplementation(actualFsync); role.close();
    const id = historyContinuationRootId(n.continuation).slice(7), staging = join(n.provisionOptions().directory, `.creating-${id}`);
    const path = join(staging, damage === 'unknown-file' ? 'unrecognized-history' : `${id}.block`);
    writeFileSync(path, 'retained suspicious contents');
    role = open(n, false); expect(() => role.provision(n.request())).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('retained suspicious contents');
    expect(existsSync(join(n.provisionOptions().directory, `generation-${id}`))).toBe(false);
  });

  it.each(['missing', 'newer'])('refuses a predecessor with %s history without removing its accepted records', tail => {
    const n = historyProvisionFixture(tail as 'missing' | 'newer'); cleanup.push(() => n.close());
    const original = n.stores[4].read();
    const role = openHistoryGenerationProvisioner({ ...n.provisionOptions(4), initialize: true }); cleanup.push(() => role.close());
    expect(() => role.provision(n.request(4))).toThrow('complete selected');
    expect(n.stores[4].read()).toEqual(original); expect(n.stores[4].activatedContinuation()).toBeNull();
  });

  it.each([1, 3, 7, 10, 13, 16])('recovers exact provisioning after an uncertain fsync at step %i', failure => {
    const n = fixture(); let role = open(n), calls = 0;
    vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === failure) throw new Error('provision disk failure'); actualFsync(fd); });
    expect(() => role.provision(n.request())).toThrow('provision disk failure');
    expect(() => role.child()).toThrow('reopen');
    vi.mocked(fsyncSync).mockImplementation(actualFsync); role.close(); n.reopen(0); role = open(n, false);
    role.provision(n.request()); expect(role.child()!.read().envelopes).toEqual([n.continuation]);
  });

  it('suppresses the receipt when synchronous durability work outlives authorization, then retries safely', () => {
    const n = fixture(); let now = 10_000;
    const role = openHistoryGenerationProvisioner({ ...n.provisionOptions(), initialize: true, now: () => now }); cleanup.push(() => role.close());
    vi.mocked(fsyncSync).mockImplementation(fd => { actualFsync(fd); now = 40_000; });
    expect(() => role.provision(n.request())).toThrow('expired');
    vi.mocked(fsyncSync).mockImplementation(actualFsync);
    expect(role.read().phase).toBe('ready'); expect(role.child()!.read().envelopes).toEqual([n.continuation]);
    const request = n.request(0, now); expect(parseHistoryProvisionReceipt(role.provision(request), request)).toBeTruthy();
  });
});
