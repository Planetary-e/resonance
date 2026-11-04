import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProtectedAdmissionAllocationAuthority } from '../protected-admission-allocation-authority.js';
import { protectedAllocationAuthorityFixture } from './fixtures/protected-allocation-authority-fixture.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('operates and recovers a volunteer-protected allocation authority through actual CLI processes and two owner losses', async () => {
  const n = await protectedAllocationAuthorityFixture(close => cleanup.push(close), { writerSibling: true }); await n.journal.ready();
  const historicalPlan = n.plan(), historicalReview = await n.journal.review(historicalPlan);
  const historicalManifest = await n.journal.sign(historicalPlan, historicalReview.approvalDigest);
  const historicalRequest = n.request(), assignmentReview = await n.journal.reviewAssignment(historicalRequest);
  const historicalAssignment = await n.journal.assignClaim(historicalRequest, assignmentReview.approvalDigest); n.journal.close();
  const file = (name: string) => join(n.directory, name);
  const json = (name: string, value: unknown) => { writeFileSync(file(name), JSON.stringify(value), { mode: 0o600 }); return file(name); };
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const keyJson = (key: typeof n.authorityKey) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), secretKey: Buffer.from(key.secretKey).toString('base64url') });
  const ownerKey = json('owner-private.json', keyJson(n.options.protection.signingKey));
  const authorityKey = json('authority-private.json', keyJson(n.authorityKey)); writeFileSync(file('authority.pub'), n.authority);
  const config = json('config.json', { version: 1, context: n.context, members: n.members, ownerKeyFile: ownerKey,
    recovery: { timeoutMs: 10000, maxReplayBlocks: 10001, maxReplayBytes: 256 * 1024 * 1024, replayTimeoutMs: 30000 } });
  const enrollment = json('original-enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: n.context, root: n.genesis });
  const requestFile = json('historical-request.json', historicalRequest);
  const main = fileURLToPath(new URL('../../../../scripts/protected-admission-allocation-authority.ts', import.meta.url));
  const env = { ...process.env }; delete env.RESONANCE_RELAY_STORAGE_SELECTION_FILE; delete env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE;
  const run = async (command: string, args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    ['--no-addons', '--import', import.meta.resolve('tsx'), main, command, ...args], { cwd: n.directory, env, timeout: 45000 })).stdout);
  const commonFor = (path: string) => [config, file('authority.pub'), authorityKey, path];
  let source = n.options.path, common = commonFor(source);
  n.online(0);
  await run('reexport', [...common, 'period-one', file('offline-original-plan.json')]); expect(read(file('offline-original-plan.json'))).toEqual(historicalManifest);
  await run('assignment-reexport', [...common, requestFile, file('offline-original-assignment.json')]); expect(read(file('offline-original-assignment.json'))).toEqual(historicalAssignment);
  await expect(run('reexport', [...common, 'period-one', file('offline-original-plan.json')])).rejects.toThrow();
  n.online(5);
  const members = json('members.json', n.members), generatedConfig = file('generated-config.json');
  await run('config', ['--approve', ownerKey, file('authority.pub'), members, generatedConfig]);
  expect(read(generatedConfig)).toMatchObject({ version: 1, context: { role: 'admission-allocation-authority', authority: n.authority } });
  const pristine = [generatedConfig, file('authority.pub'), authorityKey, file('new-owner.json')];
  await run('init', ['--approve', ...pristine, file('new-owner-enrollment.json')]);
  expect(await run('status', pristine)).toMatchObject({ manifestCount: 0, assignmentCount: 0, protection: { ready: false } });
  await run('enrollment', [...pristine, file('new-owner-enrollment-copy.json')]);
  expect(read(file('new-owner-enrollment-copy.json'))).toEqual(read(file('new-owner-enrollment.json')));
  const now = Date.now(), livePlan = { ...n.plan('live-period'), notBefore: now - 1000, issueUntil: now + 600000 };
  const planFile = json('live-plan.json', livePlan), review = await run('review', [...common, planFile]);
  await expect(run('sign', ['--approve', 'wrong', ...common, planFile, file('wrong-sign.json')])).rejects.toThrow();
  await run('sign', ['--approve', review.approvalDigest, ...common, planFile, file('live-signed.json')]);
  const signed = read(file('live-signed.json')), liveRequest = n.request(undefined, 0, 'live-period'), liveRequestFile = json('live-request.json', liveRequest);
  const claimReview = await run('assignment-review', [...common, liveRequestFile]); expect(JSON.stringify(claimReview)).not.toContain(liveRequest.claimHandle);
  await run('assign', ['--approve', claimReview.approvalDigest, ...common, liveRequestFile, file('live-assignment.json')]);
  const assignment = read(file('live-assignment.json'));
  if (process.platform !== 'win32') {
    expect(statSync(file('live-assignment.json')).mode & 0o777).toBe(0o600);
    chmodSync(liveRequestFile, 0o644); await expect(run('assignment-review', [...common, liveRequestFile])).rejects.toThrow(); chmodSync(liveRequestFile, 0o600);
  }
  for (const generation of [1, 2]) {
    common = commonFor(source); const workspace = file(`recovery-${generation}`), base = [...common, enrollment, workspace];
    const availability = generation === 1 ? 'available' : 'unavailable';
    if (generation === 2) { rmSync(source); rmSync(`${source}.history`, { recursive: true });
      await expect(run('recovery-plan', [...base, 'available', '1'])).rejects.toThrow(); }
    const recoveryReview = await run('recovery-plan', [...base, availability, '1']);
    await expect(run('recovery-start', ['--approve', `sha256:${'0'.repeat(64)}`, ...base, availability, '1'])).rejects.toThrow();
    await run('recovery-start', ['--approve', recoveryReview.approvalDigest, ...base, availability, '1']);
    n.online(0); expect(await run('recovery-status', base)).toMatchObject({ complete: false, phase: 'freeze' }); n.online(5);
    let status = await run('recovery-status', base);
    for (let step = 0; step < 12 && !status.complete; step++) status = await run('recovery-step', base);
    expect(status).toMatchObject({ complete: true, phase: 'review', generation: generation - 1 });
    const destination = file(`restored-${generation}.json`), restoreReview = await run('recovery-review', [...base, destination]);
    expect(restoreReview).toMatchObject({ generation, manifests: 2, assignments: 2 });
    expect(await run('recovery-restore', ['--approve', restoreReview.approvalDigest, ...base, destination]))
      .toMatchObject({ readiness: 'unverified', startsService: false, status: { protection: { ready: false } } });
    await expect(run('recovery-restore', ['--approve', restoreReview.approvalDigest, ...base, destination])).rejects.toThrow();
    const resumeReview = await run('recovery-resume-plan', [...base, destination]);
    expect(await run('recovery-resume', ['--approve', resumeReview.approvalDigest, ...base, destination])).toMatchObject({ readiness: 'unverified' });
    const restoredCommon = commonFor(destination);
    n.online(0); expect(await run('status', restoredCommon)).toMatchObject({ manifestCount: 2, assignmentCount: 2, protection: { ready: false } });
    await run('reexport', [...restoredCommon, 'period-one', file(`expired-plan-${generation}.json`)]);
    await run('assignment-reexport', [...restoredCommon, requestFile, file(`expired-assignment-${generation}.json`)]);
    expect(read(file(`expired-plan-${generation}.json`))).toEqual(historicalManifest);
    expect(read(file(`expired-assignment-${generation}.json`))).toEqual(historicalAssignment);
    n.online(3); await expect(run('ready', restoredCommon)).rejects.toThrow(); n.online(5); await run('ready', restoredCommon);
    await run('reexport', [...restoredCommon, 'live-period', file(`live-plan-${generation}.json`)]);
    await run('assignment-reexport', [...restoredCommon, liveRequestFile, file(`live-assignment-${generation}.json`)]);
    expect(read(file(`live-plan-${generation}.json`))).toEqual(signed); expect(read(file(`live-assignment-${generation}.json`))).toEqual(assignment);
    const conflict = json(`conflict-${generation}.json`, { ...liveRequest, issuerKeyFingerprint: n.request(liveRequest.claimHandle, 1, 'live-period').issuerKeyFingerprint });
    const conflictReview = await run('assignment-review', [...restoredCommon, conflict]);
    await expect(run('assign', ['--approve', conflictReview.approvalDigest, ...restoredCommon, conflict, file(`conflict-output-${generation}.json`)])).rejects.toThrow('different issuer');
    const expiredFile = json(`expired-new-${generation}.json`, n.plan(`expired-new-${generation}`));
    const expired = await run('review', [...restoredCommon, expiredFile]);
    await expect(run('sign', ['--approve', expired.approvalDigest, ...restoredCommon, expiredFile, file(`expired-new-output-${generation}.json`)])).rejects.toThrow();
    if (generation === 1) await expect(run('ready', common)).rejects.toThrow('fenced');
    source = destination;
  }
  const final = await openProtectedAdmissionAllocationAuthority({ ...n.options, path: source,
    protection: { ...n.options.protection, writerDirectory: `${source}.history` } });
  try { expect(final.current('public', 'period-one')).toEqual(historicalManifest);
    expect(final.currentAssignment('public', 'period-one', historicalRequest.claimHandle)).toEqual(historicalAssignment);
    expect(final.current('public', 'live-period')).toEqual(signed); expect(final.currentAssignment('public', 'live-period', liveRequest.claimHandle)).toEqual(assignment);
  } finally { final.close(); }
}, 180000);
