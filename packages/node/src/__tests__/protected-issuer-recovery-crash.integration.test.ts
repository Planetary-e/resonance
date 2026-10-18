import { afterEach, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROTECTED_ISSUER_RECOVERY_FENCE } from '../../../relay/src/protected-issuer-history.js';
import { HISTORY_WRITER_FILENAME } from '../../../relay/src/history-checkpoint-quorum.js';
import { HISTORY_WRITER_ARCHIVE_FILENAME } from '../../../relay/src/history-writer-archive.js';
import { canonicalHistorySetupPath } from '../../../relay/src/admission-history-setup.js';
import { PROTECTED_ISSUER_RECOVERY_FILENAME, openProtectedIssuerRecovery, prepareProtectedIssuerRecovery } from '../admission-issuer-recovery.js';
import { openProtectedAdmissionIssuerLedger } from '../protected-admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
import { protectedIssuerRestoreFixture } from './fixtures/protected-issuer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type Boundary = { name: string; mode: 'start' | 'advance' | 'restore'; prefix: number; nth: number; before?: boolean; target: 'fence' | 'journal' | 'owner' | 'writer' | 'archive' };
const boundaries: Boundary[] = [
  ...['fence', 'workspace'].flatMap(target => [true, false].map(before => ({ name: `${before ? 'before' : 'after'}-${target}`,
    mode: 'start' as const, prefix: 0, nth: 1, before, target: target === 'fence' ? 'fence' as const : 'journal' as const }))),
  ...(['freeze', 'agreement', 'download', 'provision'] as const).flatMap((name, i) => ['intent', 'register'].flatMap(stage => [true, false].map(before => ({
    name: `${before ? 'before' : 'after'}-${name}-${stage}`, mode: 'advance' as const, prefix: [0, 1, 2, 4][i],
    nth: stage === 'intent' ? 1 : 2, before, target: 'journal' as const })))),
  ...(['frozen', 'selected', 'confirmed', 'provisioned'] as const).map((name, i) => ({ name: `after-${name}`,
    mode: 'advance' as const, prefix: [0, 1, 3, 4][i], nth: i === 2 ? 1 : 3, target: 'journal' as const })),
  ...(['owner', 'writer', 'archive'] as const).map(target => ({ name: `after-restored-${target}`, mode: 'restore' as const, prefix: 5, nth: 1, target })),
];

it.each(boundaries)('preserves issuer obligations across SIGKILL at $name', async boundary => {
  const n = await protectedIssuerRestoreFixture(close => cleanup.push(close)); await n.ledger.ready();
  if (n.genesis.kind !== 'checkpoint') throw new Error('Expected independent original genesis');
  const assignment = await n.assign(), batch = await createAdmissionIssuanceBatch(n.profile, 1);
  // Populate the crash fixture independently of host crypto/fsync speed. This
  // setup is not observation-latency qualification; recovery below uses the real
  // monotonic clock and the production three-second observation deadline.
  const setupTime = performance.now(), setupClock = vi.spyOn(performance, 'now').mockReturnValue(setupTime);
  const baseline = await (async () => {
    try {
      const permit = await n.ledger.grantForAssignment(assignment, n.proof());
      const response = await n.ledger.approve(permit, batch.request, n.proof());
      await expect(n.ledger.grantForAssignment(assignment, n.proof(n.advance.commitment.next))).rejects.toThrow('newer');
      return { permit, response };
    } finally { setupClock.mockRestore(); }
  })();
  const { permit, response } = baseline;
  const recoveryOptions = { directory: join(n.directory, 'recovery'), context: n.context, genesis: n.genesis, profile: n.profile,
    authority: n.authority, signingKey: n.options.protection.signingKey, encryptionKey: n.key, members: n.members, timeoutMs: 10000 };
  const destination = { path: join(n.directory, 'restored.json'), writerDirectory: join(n.directory, 'restored.json.history') };
  if (boundary.mode !== 'start') {
    const review = await prepareProtectedIssuerRecovery({ ...recoveryOptions, source: await n.ledger.reviewRecoverySource() });
    const recovery = await openProtectedIssuerRecovery({ ...recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } });
    try { for (let step = 0; step < boundary.prefix; step++) await recovery.advance({ maxBlocks: 10001 }); }
    finally { recovery.close(); }
  }
  n.ledger.close();
  const targets = { fence: join(n.options.protection.writerDirectory, PROTECTED_ISSUER_RECOVERY_FENCE),
    journal: join(recoveryOptions.directory, PROTECTED_ISSUER_RECOVERY_FILENAME), owner: destination.path,
    writer: join(destination.writerDirectory, HISTORY_WRITER_FILENAME), archive: join(destination.writerDirectory, 'payloads', HISTORY_WRITER_ARCHIVE_FILENAME) };
  const child = fork(new URL('./fixtures/protected-issuer-recovery-crash.ts', import.meta.url), [],
    { execArgv: ['--no-addons', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' });
  const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', message => messages.push(message));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before ready'); })]))[0]).toBe('ready');
  const { privateKey: _, now: __, ...issuerOptions } = n.options;
  const marker = join(n.directory, 'crash-marker');
  child.send({ ...boundary, boundary: boundary.name, target: canonicalHistorySetupPath(targets[boundary.target]), marker, issuerOptions, recoveryOptions, destination,
    privateKeyBytes: n.issuerPrivateKey.export({ type: 'pkcs8', format: 'der' }), now: n.now }); await exited;
  expect(messages).toEqual(['ready']); expect(readFileSync(marker, 'utf8')).toBe(boundary.name);
  if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL'); else expect(child.exitCode).not.toBe(0);
  const source = await openProtectedAdmissionIssuerLedger(n.options); cleanup.push(source.close);
  expect(source.status()).toMatchObject({ allocatedPermits: 1, boundPermits: 1, completedPermits: 1, policyFreshness: { observedRevision: 2 },
    protection: { fenced: boundary.name !== 'before-fence' } });
  const published = existsSync(targets.journal), leftovers = existsSync(recoveryOptions.directory) ? readdirSync(recoveryOptions.directory) : [];
  const options = !published && leftovers.length ? { ...recoveryOptions, directory: join(n.directory, 'separate-workspace') } : recoveryOptions;
  const review = published ? undefined : await prepareProtectedIssuerRecovery({ ...options, source: await source.reviewRecoverySource() });
  const resumed = await openProtectedIssuerRecovery({ ...options, ...(review ? { initialize: { review, approvedDigest: review.approvalDigest } } : {}) }); cleanup.push(resumed.close);
  for (let step = 0; step < 12 && !resumed.status().complete; step++) await resumed.advance({ maxBlocks: 10001 });
  expect(resumed.status().complete).toBe(true); expect(source.status().protection.fenced).toBe(true);
  if (boundary.mode === 'restore') {
    const resumption = await resumed.reviewResumption(destination, { privateKey: n.privateKey });
    try { const result = await resumption.apply(resumption.review().approvalDigest); expect(result.readiness).toBe('unverified'); }
    finally { resumption.close(); }
  } else {
    const { preparation } = await resumed.reviewRestore(destination);
    const created = await openProtectedAdmissionIssuerLedger({ ...n.options, path: destination.path,
      protection: { ...n.options.protection, writerDirectory: destination.writerDirectory, initializeWriter: true, initializeArchive: true },
      restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); created.close();
  }
  const restored = await openProtectedAdmissionIssuerLedger({ ...n.options, path: destination.path,
    protection: { ...n.options.protection, writerDirectory: destination.writerDirectory } }); cleanup.push(restored.close);
  expect(restored.status()).toMatchObject({ allocatedPermits: 1, completedPermits: 1, policyFreshness: { observedRevision: 2 }, protection: { ready: false } });
  await restored.ready(); await restored.installPolicy(n.second, n.authority, { advance: n.advance });
  expect(await restored.grantForAssignment(assignment, n.proofFor(restored, n.advance.commitment.next))).toEqual(permit);
  expect(await restored.approve(permit, batch.request, n.proofFor(restored, n.advance.commitment.next))).toEqual(response);
  if (!published && leftovers.length) expect(readdirSync(recoveryOptions.directory)).toEqual(leftovers);
}, 60000);
