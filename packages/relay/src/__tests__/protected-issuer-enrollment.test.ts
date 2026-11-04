import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { readHistoryEnrollmentFile, runAdmissionHistoryCommand } from '../admission-history-command.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

it('admits issuer enrollment only through explicit generic replica planning, enrollment and serving', async () => {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'issuer-enrollment-'));
  let running: Awaited<ReturnType<typeof runAdmissionHistoryCommand>> | undefined;
  try {
    const context = { ...h.context, role: 'admission-issuer' as const };
    const root = sealHistoryCheckpoint({ context, signingKey: h.owner, encryptionKey: h.key, plaintext: Buffer.from('{"issuer":"private"}'),
      header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null } });
    const enrollment = join(directory, 'enrollment.json'), member = join(directory, 'member.json'), localKey = join(directory, 'storage.hex');
    writeFileSync(enrollment, JSON.stringify({ version: 1, kind: 'admission-history-enrollment', context, root }));
    writeFileSync(member, JSON.stringify({ publicKey: context.members[0], secretKey: Buffer.from(h.memberKeys[0].secretKey).toString('base64url') }), { mode: 0o600 });
    writeFileSync(localKey, h.localKey.toString('hex'), { mode: 0o600 });
    expect(() => readHistoryEnrollmentFile(enrollment)).toThrow('own history role');
    expect(readHistoryEnrollmentFile(enrollment, ['admission-issuer']).root).toEqual(root);
    const args = [enrollment, member, localKey, join(directory, 'volunteer')];
    const planned = await runAdmissionHistoryCommand('replica-plan', args);
    await expect(runAdmissionHistoryCommand('replica-enroll', ['--approve', 'wrong', ...args])).rejects.toThrow('approval');
    const enrolled = await runAdmissionHistoryCommand('replica-enroll', ['--approve', String(planned.result.approvalDigest), ...args]);
    expect(enrolled.result.result).toBe('enrolled');
    running = await runAdmissionHistoryCommand('replica-serve', [...args, '0']);
    expect(running.result.event).toBe('history_volunteer_listening'); await running.stop!(); running = undefined;
    for (const [command, tail] of [['replica-pool-plan', '2'], ['replica-generations-plan', 'unused.json'], ['replica-prefix-plan', 'unused-root'], ['replica-resume-plan', '']] as const) {
      const commandArgs = tail ? [...args, tail] : args;
      await expect(runAdmissionHistoryCommand(command, commandArgs)).rejects.toThrow('own history role');
    }
  } finally { await running?.stop?.(); rmSync(directory, { recursive: true, force: true }); }
});
