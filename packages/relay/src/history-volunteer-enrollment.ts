/** Reviewed reopening of an interrupted enrollment. Never initializes missing accepted history. */
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import type { SigningKeyPair } from '@resonance/core';
import type { HistoryCheckpointContext, HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { canonicalHistorySetupPath } from './admission-history-setup.js';
import { inspectPristineHistoryGenesis } from './history-checkpoint-store.js';
import { openHistoryVolunteerService } from './history-volunteer-service.js';

export function openHistoryVolunteerEnrollmentResume(options: {
  directory: string; localKey: Uint8Array; signingKey: SigningKeyPair; context: HistoryCheckpointContext; genesis: HistoryCheckpointEnvelope;
}, signal?: AbortSignal) {
  const run = captureStorageReservationOperation();
  signal?.throwIfAborted(); const directory = canonicalHistorySetupPath(options.directory), context = parseHistoryCheckpointContext(options.context);
  const genesis = parseHistoryCheckpointEnvelope(options.genesis, context), genesisId = historyCheckpointEnvelopeId(genesis);
  const member = Buffer.from(options.signingKey.publicKey).toString('base64url');
  if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, 'genesis')).isDirectory()
    || !lstatSync(join(directory, 'genesis', 'history-manifest.json')).isFile()) throw new Error('Enrollment manifest is missing; preserve the directory for recovery');
  const signingKey = copyAdmissionSigningKey(options.signingKey), localKey = Buffer.from(options.localKey);
  let service: ReturnType<typeof openHistoryVolunteerService> | undefined, pristine: ReturnType<typeof inspectPristineHistoryGenesis> | undefined;
  let closed = false, applied = false;
  function close() { if (!closed) { closed = true; try { service?.close(); pristine?.close(); } finally { signingKey.secretKey.fill(0); localKey.fill(0); } } }
  try {
    const serviceOptions = { directory, context, signingKey, localKey, genesisId };
    try { service = openHistoryVolunteerService(serviceOptions); }
    catch (cause) {
      // A normal retained chain must reopen through its full validator. The only
      // alternative is a pinned, authenticated manifest with zero indexed blocks.
      if (readdirSync(directory).some(name => name !== 'genesis')) throw cause;
      pristine = inspectPristineHistoryGenesis({ directory: join(directory, 'genesis'), context, genesis, localKey, replica: member });
    }
    const retainedDigest = service?.reviewDigest() ?? pristine!.reviewDigest();
    const details = { kind: 'history-volunteer-resumption' as const, directory, contextId: historyCheckpointContextId(context), genesisId,
      member, owner: context.owner, authority: context.authority,
      phase: pristine ? 'genesis-pending' as const : 'retained' as const,
      retainedBlocks: service?.health().retainedBlocks ?? 0, retainedDigest, readiness: 'unverified' as const, startsService: false as const };
    const approvalDigest = historyDigest(`resonance:volunteer-enrollment-resume:v1\n${JSON.stringify([details, historyDigest(localKey)])}`);
    return { review: { ...details, approvalDigest }, apply(approved: string) { return run(() => {
      signal?.throwIfAborted();
      if (closed || applied || approved !== approvalDigest || canonicalHistorySetupPath(options.directory) !== directory) throw new Error('Enrollment resumption approval changed; review again');
      try {
        if (pristine) {
          pristine.complete(retainedDigest); pristine.close(); pristine = undefined; signal?.throwIfAborted();
          service = openHistoryVolunteerService(serviceOptions);
        } else if (service!.reviewDigest() !== retainedDigest) throw new Error('Retained enrollment changed; review again');
        applied = true;
        return { ...details, result: 'enrollment-resumed' as const, retainedBlocks: service!.health().retainedBlocks };
      } catch (error) { close(); throw error; }
    }); }, close };
  } catch (error) { close(); throw error; }
}
