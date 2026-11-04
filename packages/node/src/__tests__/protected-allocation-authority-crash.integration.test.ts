import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { HISTORY_WRITER_FILENAME } from '../../../relay/src/history-checkpoint-quorum.js';
import { protectedAllocationAuthorityFixture } from './fixtures/protected-allocation-authority-fixture.js';
type Cleanup = Array<() => void | Promise<void>>;
const boundaries = [
  { name: 'before-intent', target: 'owner', nth: 1, before: true },
  { name: 'after-intent', target: 'owner', nth: 1 },
  { name: 'after-quorum', target: 'writer', nth: 2 },
  { name: 'before-apply', target: 'owner', nth: 2, before: true },
  { name: 'after-apply-before-reply', target: 'owner', nth: 2 },
];
it.each((['plan', 'assignment'] as const).flatMap(operation => boundaries.map(boundary => ({ operation, ...boundary }))))(
  'preserves the exact $operation at $name SIGKILL', async boundary => {
    const operation = boundary.operation, local: Cleanup = [], n = await protectedAllocationAuthorityFixture(close => local.push(close));
    try {
      await n.journal.ready(); const base = n.plan(), reviewed = await n.journal.review(base), manifest = await n.journal.sign(base, reviewed.approvalDigest);
      const firstRequest = n.request(), firstReview = await n.journal.reviewAssignment(firstRequest), firstAssignment = await n.journal.assignClaim(firstRequest, firstReview.approvalDigest);
      const nextPlan = n.plan('period-two'), nextRequest = n.request();
      const expected = operation === 'plan' ? await signAdmissionIssuanceAllocation(nextPlan, n.authority, n.authorityKey.secretKey)
        : await signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority: n.authority,
          allocationDigest: admissionIssuanceAllocationDigest(manifest), ...nextRequest }, manifest, n.authority, n.authorityKey.secretKey);
      n.journal.close();
      const child = fork(new URL('./fixtures/protected-allocation-authority-crash.ts', import.meta.url), [],
        { execArgv: ['--no-addons', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' });
      const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', message => messages.push(message));
      local.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
      expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before ready'); })]))[0]).toBe('ready');
      const { now: _, ...options } = n.options, marker = join(n.directory, 'crash-marker');
      child.send({ options, value: operation === 'plan' ? nextPlan : nextRequest, boundary: boundary.name, marker,
        ...boundary, target: boundary.target === 'owner' ? n.options.path : join(n.options.protection.writerDirectory, HISTORY_WRITER_FILENAME) });
      await exited; expect(messages).toEqual(['ready']); expect(readFileSync(marker, 'utf8')).toBe(boundary.name);
      if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL'); else expect(child.exitCode).not.toBe(0);
      const journal = await n.reopen(); expect(journal.status().protection.ready).toBe(false);
      expect(journal.current('public', 'period-one')).toEqual(manifest);
      expect(journal.currentAssignment('public', 'period-one', firstRequest.claimHandle)).toEqual(firstAssignment);
      const pendingVisible = operation === 'plan' ? journal.current('public', 'period-two') : journal.currentAssignment('public', 'period-one', nextRequest.claimHandle);
      expect(pendingVisible).toEqual(boundary.name === 'after-apply-before-reply' ? expected : undefined);
      await journal.ready();
      if (operation === 'plan') { const review = await journal.review(nextPlan); expect(await journal.sign(nextPlan, review.approvalDigest)).toEqual(expected); }
      else { const review = await journal.reviewAssignment(nextRequest); expect(await journal.assignClaim(nextRequest, review.approvalDigest)).toEqual(expected); }
      expect(journal.status().protection.applied?.sequence).toBe(3);
      const conflict = operation === 'plan' ? { ...nextPlan, totalTokenBudget: 5 } : { ...nextRequest, issuerKeyFingerprint: n.request(nextRequest.claimHandle, 1).issuerKeyFingerprint };
      if (operation === 'plan') { const review = await journal.review(conflict); await expect(journal.sign(conflict, review.approvalDigest)).rejects.toThrow('Conflicting'); }
      else { const review = await journal.reviewAssignment(conflict); await expect(journal.assignClaim(conflict, review.approvalDigest)).rejects.toThrow('different issuer'); }
      expect(journal.status().protection.applied?.sequence).toBe(3);
      n.clock(300); const reopened = await n.reopen(); n.online(0);
      expect(operation === 'plan' ? reopened.current('public', 'period-two') : reopened.currentAssignment('public', 'period-one', nextRequest.claimHandle)).toEqual(expected);
    } finally { for (const close of local.reverse()) await close(); }
}, 30000);
