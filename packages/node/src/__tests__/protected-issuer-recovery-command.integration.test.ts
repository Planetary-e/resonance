import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProtectedAdmissionIssuerLedger } from '../protected-admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
import { protectedIssuerRestoreFixture } from './fixtures/protected-issuer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('runs reviewed recovery commands across two generations, preserving permits after the restored owner disappears', async () => {
  const n = await protectedIssuerRestoreFixture(close => cleanup.push(close), { writerSibling: true }); await n.ledger.ready();
  const assignment = await n.assign(), permit = await n.ledger.grantForAssignment(assignment, n.proof());
  const batch = await createAdmissionIssuanceBatch(n.profile, 1), response = await n.ledger.approve(permit, batch.request, n.proof());
  n.ledger.close();
  const file = (name: string) => join(n.directory, name);
  const json = (name: string, value: unknown) => { writeFileSync(file(name), JSON.stringify(value), { mode: 0o600 }); return file(name); };
  const signer = n.options.protection.signingKey;
  const owner = json('owner.json', { publicKey: Buffer.from(signer.publicKey).toString('base64url'), secretKey: Buffer.from(signer.secretKey).toString('base64url') });
  const config = json('config.json', { version: 1, context: n.context, members: n.members, ownerKeyFile: owner });
  const profile = json('profile.json', n.profile), enrollment = json('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.genesis });
  writeFileSync(file('authority.pub'), n.authority);
  writeFileSync(file('private.pem'), n.issuerPrivateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const main = fileURLToPath(new URL('../../../../scripts/protected-admission-issuer.ts', import.meta.url));
  const env = { ...process.env }; delete env.RESONANCE_RELAY_STORAGE_SELECTION_FILE; delete env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE;
  const run = async (command: string, args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    ['--no-addons', '--import', import.meta.resolve('tsx'), main, command, ...args], { cwd: n.directory, env, timeout: 45000 })).stdout);
  let source = n.options.path;
  for (const generation of [1, 2]) {
    const common = [config, profile, file('private.pem'), source, file('authority.pub')], workspace = file(`recovery-${generation}`);
    const base = [...common, enrollment, workspace], availability = generation === 1 ? 'available' : 'unavailable';
    if (generation === 2) {
      rmSync(source); rmSync(`${source}.history`, { recursive: true });
      // Missing files never silently select an unavailable source.
      await expect(run('recovery-plan', [...base, 'available', '1'])).rejects.toThrow();
    }
    const review = await run('recovery-plan', [...base, availability, '1']);
    await expect(run('recovery-start', ['--approve', `sha256:${'0'.repeat(64)}`, ...base, availability, '1'])).rejects.toThrow('reviewed');
    await run('recovery-start', ['--approve', review.approvalDigest, ...base, availability, '1']);
    n.online(0); expect(await run('recovery-status', base)).toMatchObject({ complete: false, phase: 'freeze' }); n.online(5);
    let status = await run('recovery-status', base);
    for (let step = 0; step < 12 && !status.complete; step++) status = await run('recovery-step', base);
    expect(status).toMatchObject({ complete: true, phase: 'review', generation: generation - 1 });
    const destination = file(`restored-${generation}.json`), restoreReview = await run('recovery-review', [...base, destination]);
    expect(restoreReview).toMatchObject({ generation, allocatedPermits: 1, boundPermits: 1, completedPermits: 1 });
    expect(await run('recovery-restore', ['--approve', restoreReview.approvalDigest, ...base, destination]))
      .toMatchObject({ readiness: 'unverified', startsService: false, status: { protection: { ready: false } } });
    await expect(run('recovery-restore', ['--approve', restoreReview.approvalDigest, ...base, destination])).rejects.toThrow();
    const resumeReview = await run('recovery-resume-plan', [...base, destination]);
    expect(await run('recovery-resume', ['--approve', resumeReview.approvalDigest, ...base, destination])).toMatchObject({ readiness: 'unverified' });
    const destinationCommon = [config, profile, file('private.pem'), destination, file('authority.pub')];
    n.online(0); expect(await run('status', destinationCommon)).toMatchObject({ completedPermits: 1, protection: { ready: false } });
    n.online(3); await expect(run('ready', destinationCommon)).rejects.toThrow(); n.online(5); await run('ready', destinationCommon);
    const restored = await openProtectedAdmissionIssuerLedger({ ...n.options, path: destination,
      protection: { ...n.options.protection, writerDirectory: `${destination}.history` } });
    try {
      await restored.ready(); expect(await restored.grantForAssignment(assignment, n.proofFor(restored))).toEqual(permit);
      expect(await restored.approve(permit, batch.request, n.proofFor(restored))).toEqual(response);
      expect(restored.status()).toMatchObject({ allocatedPermits: 1, remainingPermits: 3 });
    } finally { restored.close(); }
    if (generation === 1) await expect(run('ready', common)).rejects.toThrow('fenced');
    source = destination;
  }
}, 180000);
