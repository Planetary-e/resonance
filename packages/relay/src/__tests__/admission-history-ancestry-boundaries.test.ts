import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { AdmissionPolicyArchiveExecutionContext } from '@resonance/core/admission-policy-archive';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';
import { prepareAdmissionHistoryRestore, openPreparedAdmissionPolicyStore } from '../admission-history-restore.js';
import { openProtectedAdmissionSpendHistory, type AdmissionHistoryProtection } from '../protected-admission-history.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const n = await admissionRestoreFixture(); cleanup.push(n.close); return n; }
function options(n: Awaited<ReturnType<typeof fixture>>, directory: string) {
  return { directory, policy: n.policy, authority: n.context.authority, encryptionKey: n.key, now: () => n.time + 10000,
    protection: { context: n.context, signingKey: n.owner, members: n.members, transport: n.transport, initializeWriter: true } };
}
it('refuses original ancestor retarget during genesis validation before either owner or writer is published', async () => {
  const n = await fixture(), a = join(n.directory, 'a'), b = join(n.directory, 'b'), alias = join(n.directory, 'alias'); mkdirSync(a); mkdirSync(b); symlinkSync(a, alias, 'dir');
  const directory = join(alias, 'owner'), preparation = await prepareAdmissionHistoryRestore(n.restoreOptions(directory)); cleanup.push(() => preparation.close?.());
  let entered!: () => void, release!: () => void, imports = 0;
  const held = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (...args) => {
    if (args[0] === 'spki' && ++imports === n.policy.keys.length + 1) { entered(); await gate; }
    return original(...args);
  });
  const pending = openProtectedAdmissionSpendHistory({ ...options(n, directory), initialize: true,
    protection: { ...options(n, directory).protection, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
  const refusal = expect(pending).rejects.toThrow('destination changed');
  await held; unlinkSync(alias); symlinkSync(b, alias, 'dir'); release(); await refusal;
  expect(existsSync(join(a, 'owner'))).toBe(false); expect(existsSync(join(b, 'owner'))).toBe(false);
});
it.each(['file', 'directory', 'symlink'] as const)('refuses foreign policy-store names of type %s after review', async kind => {
  const n = await fixture(), directory = join(n.directory, `foreign-${kind}`), preparation = await prepareAdmissionHistoryRestore(n.restoreOptions(directory)); cleanup.push(() => preparation.close?.());
  mkdirSync(directory); const path = join(directory, 'admission-community-policy.json');
  if (kind === 'file') writeFileSync(path, 'foreign'); else if (kind === 'directory') mkdirSync(path); else symlinkSync(join(n.directory, 'absent'), path);
  const pending = openProtectedAdmissionSpendHistory({ ...options(n, directory), initialize: true,
    protection: { ...options(n, directory).protection, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
  await expect(pending).rejects.toThrow('empty destination');
  expect(readdirSync(directory)).toEqual(['admission-community-policy.json']);
});
it('accepts the actual newly owned verifier store and rejects a closed owned-store facade', async () => {
  const n = await fixture(), directory = join(n.directory, 'configured'), preparation = await prepareAdmissionHistoryRestore(n.restoreOptions(directory)); cleanup.push(() => preparation.close?.());
  const verifier = await createConfiguredAdmissionVerifier({ ...options(n, directory), initialize: true,
    historyProtection: { ...options(n, directory).protection, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } }); cleanup.push(verifier.close);
  expect(existsSync(join(directory, 'admission-history-writer', 'history-writer.json'))).toBe(true); verifier.close();
  const closedDirectory = join(n.directory, 'closed-store'), closedPreparation = await prepareAdmissionHistoryRestore(n.restoreOptions(closedDirectory)); cleanup.push(() => closedPreparation.close?.());
  const store = await openPreparedAdmissionPolicyStore(closedPreparation, { directory: closedDirectory, encryptionKey: n.key }); store.close();
  await expect(openProtectedAdmissionSpendHistory({ ...options(n, closedDirectory), initialize: true,
    protection: { ...options(n, closedDirectory).protection, restore: { preparation: closedPreparation, approvedDigest: closedPreparation.review.approvalDigest } } })).rejects.toThrow('closed');
  expect(existsSync(join(closedDirectory, 'admission-spends-v2.jsonl'))).toBe(false);
});
it.each(['public-owner', 'inherited-runtime'] as const)('charges synchronous source preflight to the original %s startup deadline and releases its source', async mode => {
  const n = await fixture(), directory = join(n.directory, mode); let now = 0, opened = false, closed = false;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const startup = mode === 'inherited-runtime' ? new AdmissionPolicyArchiveExecutionContext({ execution: { version: 2, purpose: 'offline-startup-reconstruction', timeoutMs: 30000 }, timeoutMs: 30000, deadline: 50 }) : undefined;
  const selection: NonNullable<AdmissionHistoryProtection['ancestrySelection']> = {
    funding: { authorityDirectory: n.directory, authorityId: 'a'.repeat(32) }, binding: 'test-preflight', expectedAncestry: { genesisId: n.replayOptions().genesisId, rootId: n.replayOptions().genesisId },
    check() {}, assertRecoveryDownload() {}, open() { opened = true; now = mode === 'public-owner' ? 30001 : 51; return { blocks: () => n.selected(), close() { closed = true; } }; },
  };
  await expect(openProtectedAdmissionSpendHistory({ ...options(n, directory), protection: { ...options(n, directory).protection, ancestrySelection: selection, ...(mode === 'inherited-runtime' ? { deadline: 50 } : {}) } }, startup)).rejects.toThrow('timed out');
  expect(opened).toBe(true); expect(closed).toBe(true); expect(existsSync(directory)).toBe(false);
});

it('closes the opened policy store when cancellation arrives at the wait final check after its callback returns', async () => {
  const n = await fixture(), directory = join(n.directory, 'cancelled-store');
  const startup = new AdmissionPolicyArchiveExecutionContext({ execution: { version: 2, purpose: 'offline-startup-reconstruction', timeoutMs: 30000 }, timeoutMs: 30000 });
  const check = startup.check.bind(startup); let checks = 0;
  vi.spyOn(startup, 'check').mockImplementation(() => { if (++checks === 3) startup.controller.abort(); check(); });
  await expect(createConfiguredAdmissionVerifier({ ...options(n, directory), initialize: true, historyStartup: startup })).rejects.toThrow('cancelled');
  expect(checks).toBe(3);
  const reopened = await openAdmissionPolicyStore({ path: join(directory, 'admission-community-policy.json'), encryptionKey: n.key, mode: 'open-existing' });
  reopened.close();
  expect(existsSync(join(directory, 'admission-spends-v2.jsonl'))).toBe(false);
});
