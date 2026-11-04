import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyCheckpointContextId, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { readHistoryEnrollmentFile, runAdmissionHistoryCommand } from '../admission-history-command.js';
import { prepareAdmissionHistoryRestore } from '../admission-history-restore.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

it('enrolls allocation-authority volunteers only through the explicit generic replica allowlist', async () => {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'allocation-enrollment-'));
  let running: Awaited<ReturnType<typeof runAdmissionHistoryCommand>> | undefined;
  try {
    const context = { ...h.context, role: 'admission-allocation-authority' as const };
    const root = sealHistoryCheckpoint({ context, signingKey: h.owner, encryptionKey: h.key, plaintext: Buffer.from('{"authority":"private"}'),
      header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null } });
    const enrollment = join(directory, 'enrollment.json'), member = join(directory, 'member.json'), localKey = join(directory, 'storage.hex'), config = join(directory, 'config.json');
    writeFileSync(enrollment, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context, root }));
    writeFileSync(member, JSON.stringify({ publicKey: context.members[0], secretKey: Buffer.from(h.memberKeys[0].secretKey).toString('base64url') }), { mode: 0o600 });
    writeFileSync(localKey, h.localKey.toString('hex'), { mode: 0o600 });
    writeFileSync(config, JSON.stringify({ version: 1, context, ownerKeyFile: 'unused-owner.json', members: context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${46001 + i}/history-checkpoint` })) }));
    expect(() => readHistoryEnrollmentFile(enrollment)).toThrow('own history role');
    expect(readHistoryEnrollmentFile(enrollment, ['admission-allocation-authority']).root).toEqual(root);
    const args = [enrollment, member, localKey, join(directory, 'volunteer')];
    const planned = await runAdmissionHistoryCommand('replica-plan', args);
    await expect(runAdmissionHistoryCommand('replica-enroll', ['--approve', 'wrong', ...args])).rejects.toThrow('approval');
    expect((await runAdmissionHistoryCommand('replica-enroll', ['--approve', String(planned.result.approvalDigest), ...args])).result.result).toBe('enrolled');
    running = await runAdmissionHistoryCommand('replica-serve', [...args, '0']);
    expect(running.result.event).toBe('history_volunteer_listening'); await running.stop!(); running = undefined;
    for (const [command, tail] of [['replica-pool-plan', '2'], ['replica-generations-plan', 'unused.json'], ['replica-prefix-plan', 'unused-root'], ['replica-resume-plan', '']] as const) {
      await expect(runAdmissionHistoryCommand(command, tail ? [...args, tail] : args)).rejects.toThrow('own history role');
    }
    // The new generic enrollment role does not opt this owner into spend restoration or compaction.
    await expect(prepareAdmissionHistoryRestore({ context, directory: join(directory, 'restore') } as never)).rejects.toThrow('own history role');
    await expect(runAdmissionHistoryCommand('owner-checkpoint-plan', [config, 'unused-policy', localKey, 'unused-owner'])).rejects.toThrow('own history role');
    await expect(runAdmissionHistoryCommand('owner-prefix-plan', [config, 'unused-policy', localKey, 'unused-owner'])).rejects.toThrow('own history role');
  } finally { await running?.stop?.(); h.owner.secretKey.fill(0); h.memberKeys.forEach(key => key.secretKey.fill(0)); h.key.fill(0); h.localKey.fill(0); rmSync(directory, { recursive: true, force: true }); }
});
it('separates allocation-authority context IDs and signed roots from each existing history role', () => {
  const h = historyCheckpointFixture(), context = { ...h.context, role: 'admission-allocation-authority' as const };
  try {
    expect(parseHistoryCheckpointContext(context)).toEqual(context);
    const root = sealHistoryCheckpoint({ context, signingKey: h.owner, encryptionKey: h.key, plaintext: Buffer.from('{}'), header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null } });
    for (const role of ['admission-issuer', 'policy-observer', 'relay-admission-spends'] as const) {
      const other = { ...context, role }; expect(historyCheckpointContextId(other)).not.toBe(historyCheckpointContextId(context));
      expect(() => parseHistoryCheckpointEnvelope(root, other)).toThrow();
    }
  } finally { h.owner.secretKey.fill(0); h.memberKeys.forEach(key => key.secretKey.fill(0)); h.key.fill(0); h.localKey.fill(0); }
});
