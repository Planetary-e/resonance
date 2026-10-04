/** Finite recovery model, NOT a wire protocol or an operational restore API.
 * Five fixed replicas; at most one Byzantine replica. A correct owner has signed
 * the cumulative denial states 0, 1 and 2. Signatures/full payloads are abstracted
 * by booleans; an adversary can replay any of these three authentic states.
 * Honest replicas persist before acknowledging and never roll their state back.
 */
const MEMBERS = [0, 1, 2, 3, 4];
const CHALLENGE = 'fresh-read';
const HISTORY = 'pinned-history';

export function memberSets(size: number): number[][] {
  if (!Number.isInteger(size) || size < 1 || size > 5) throw new Error('Invalid quorum size');
  return Array.from({ length: 32 }, (_, mask) => MEMBERS.filter(member => mask & (1 << member)))
    .filter(members => members.length === size);
}

export interface ModelReply {
  member: number; history: string; challenge: string; revision: number;
  authenticated: boolean; ownerAuthenticated: boolean; completePayload: boolean;
}

/** Reject unusable evidence; count distinct pinned members, never old signatures alone. */
export function selectModelCheckpoint(replies: ModelReply[], challenge: string): number | null {
  if (!challenge) return null;
  const excluded = new Set<number>();
  const valid = new Map<number, ModelReply>();
  for (const reply of replies) {
    if (!MEMBERS.includes(reply.member) || !reply.authenticated || !reply.ownerAuthenticated
      || !reply.completePayload || reply.history !== HISTORY || reply.challenge !== challenge
      || !Number.isInteger(reply.revision) || reply.revision < 0 || reply.revision > 2) continue;
    // Exclude an equivocator without letting it veto four other valid replies.
    if (excluded.has(reply.member)) continue;
    const previous = valid.get(reply.member);
    if (previous && previous.revision !== reply.revision) {
      valid.delete(reply.member); excluded.add(reply.member); continue;
    }
    valid.set(reply.member, reply);
  }
  return valid.size >= 4 ? Math.max(...[...valid.values()].map(reply => reply.revision)) : null;
}

function reply(member: number, revision: number, challenge = CHALLENGE): ModelReply {
  return { member, revision, history: HISTORY, challenge, authenticated: true,
    ownerAuthenticated: true, completePayload: true };
}

/** A completed write has its whole payload durably acknowledged by writeSize members. */
export function freshnessIntersections(writeSize: number, readSize: number) {
  let cases = 0, lostCompletedWrites = 0, minimumHonestIntersection = 5;
  let counterexample: null | { byzantine: number; stored: number[]; readers: number[] } = null;
  for (const byzantine of [-1, ...MEMBERS]) {
    for (const stored of memberSets(writeSize)) for (const readers of memberSets(readSize)) {
      cases++;
      const honest = readers.filter(member => member !== byzantine && stored.includes(member));
      minimumHonestIntersection = Math.min(minimumHonestIntersection, honest.length);
      if (!honest.length) {
        lostCompletedWrites++;
        counterexample ??= { byzantine, stored, readers };
      }
    }
  }
  return { writeSize, readSize, cases, minimumHonestIntersection, lostCompletedWrites, counterexample };
}

/** One completed write, any partial newer delivery, a recovery, then another
 * recovery. The owner is quiescent in THIS submodel. Repair writes the selected
 * full payload to four members before the first recovery returns.
 */
export function readRepairReport() {
  const quorums = memberSets(4);
  let selections = 0, lostCompletedWrites = 0, comparisons = 0;
  let regressionsWithoutRepair = 0, regressionsWithRepair = 0;
  let counterexample: null | {
    byzantine: number; stored: number[]; tailRecipients: number[];
    firstReaders: number[]; secondReaders: number[]; first: number; second: number;
  } = null;
  for (const byzantine of [-1, ...MEMBERS]) for (const stored of quorums) {
    for (let tail = 0; tail < 32; tail++) {
      const states = MEMBERS.map(member => tail & (1 << member) ? 2 : stored.includes(member) ? 1 : 0);
      for (const firstReaders of quorums) for (const firstLie of [0, 1, 2]) {
        const first = selectModelCheckpoint(firstReaders.map(member => reply(
          member, member === byzantine ? firstLie : states[member],
        )), CHALLENGE)!;
        selections++;
        if (first < 1) lostCompletedWrites++;
        for (const repairTargets of quorums) {
          const repaired = states.map((state, member) => member !== byzantine && repairTargets.includes(member)
            ? Math.max(state, first) : state);
          for (const secondReaders of quorums) for (const secondLie of [0, 1, 2]) {
            comparisons++;
            // Every member here is already pinned/authenticated and supplies
            // the requested nonce/full valid payload, so max is the selection.
            const second = Math.max(...secondReaders.map(member => member === byzantine ? secondLie : states[member]));
            const afterRepair = Math.max(...secondReaders.map(member => member === byzantine ? secondLie : repaired[member]));
            if (second < first) {
              regressionsWithoutRepair++;
              counterexample ??= { byzantine, stored,
                tailRecipients: MEMBERS.filter(member => tail & (1 << member)),
                firstReaders, secondReaders, first, second };
            }
            if (afterRepair < first) regressionsWithRepair++;
          }
        }
      }
    }
  }
  return { selections, comparisons, lostCompletedWrites, regressionsWithoutRepair, regressionsWithRepair, counterexample };
}

/** One old-generation write racing one durable generation freeze. For every
 * shared member, enumerate whether the write or freeze arrives first. This is
 * a per-member ordering model, not a proof of arbitrary concurrent recovery.
 * Freeze replies include the payload atomically retained at the freeze point.
 */
export function generationFreezeReport() {
  let cases = 0, completedOldWrites = 0, preservedCompletedWrites = 0, blockedOldWrites = 0;
  let maximumLateOldAcknowledgements = 0;
  for (const byzantine of [-1, ...MEMBERS]) {
    for (const writers of memberSets(4)) for (const freezers of memberSets(4)) {
      const shared = writers.filter(member => freezers.includes(member));
      for (let ordering = 0; ordering < 2 ** shared.length; ordering++) {
        cases++;
        const writeBeforeFreeze = (member: number) => !!(ordering & (1 << shared.indexOf(member)));
        const acknowledged = writers.filter(member => member === byzantine
          || !freezers.includes(member) || writeBeforeFreeze(member));
        const observed = freezers.some(member => member !== byzantine
          && writers.includes(member) && writeBeforeFreeze(member));
        if (acknowledged.length === 4) {
          completedOldWrites++;
          if (observed) preservedCompletedWrites++;
        } else blockedOldWrites++;
      }
      maximumLateOldAcknowledgements = Math.max(maximumLateOldAcknowledgements,
        MEMBERS.filter(member => member === byzantine || !freezers.includes(member)).length);
    }
  }
  return { cases, completedOldWrites, preservedCompletedWrites, blockedOldWrites,
    maximumLateOldAcknowledgements };
}

export function recoveryCounterexamples() {
  // A real accepted denial at revision 1, replicated to every honest member.
  const oldResponses = memberSets(4)[0].map(member => reply(member, 0, 'old-read'));
  const staleWriter = { read: [] as string[], current: [] as string[] };
  staleWriter.current = ['spent-token']; // Accepted after the recovery's read.
  const overwritten = [...staleWriter.read]; // Higher generation alone loses it.
  return {
    authenticBackup: { latestRevision: 1, restoredRevision: 0, acceptedDenialLost: true },
    replayedResponses: {
      withoutNonceCheck: Math.max(...oldResponses.map(value => value.revision)),
      withNonceCheck: selectModelCheckpoint(oldResponses, CHALLENGE), latestRevision: 1,
    },
    acknowledgeBeforeReplication: { acknowledgedLocally: 1, durableRemoteRevision: 0, recoverableRevision: 0 },
    staleWriterWithoutFreeze: {
      steps: ['Recovery reads empty state', 'Old writer commits spent-token to four replicas',
        'Recovery overwrites with its older state under a higher generation'],
      lost: staleWriter.current.filter(fact => !overwritten.includes(fact)),
    },
    digestOnly: { readableDigests: 4, availablePayloads: 0, canReconstruct: false },
  };
}

export function snapshotPayloadBudget(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 8 * 1024 * 1024) throw new Error('Invalid snapshot bytes');
  return { bytes, minimumWriteUpload: 4 * bytes, fiveReplicaWriteUpload: 5 * bytes,
    minimumRecoveryTransfer: 8 * bytes, fiveReplicaStoredPayload: 5 * bytes };
}

export function historyCheckpointReport() {
  return {
    model: 'finite cumulative-denial recovery and one generation handoff; no production restore',
    assumptions: {
      members: 5, maximumByzantine: 1, durableWriteAcknowledgements: 4, freshReadReplies: 4,
      correctOwner: true, authenticCumulativeRevisions: [0, 1, 2], fullPayloadAvailable: true,
      pinnedHistoryAndMembership: true, honestDurableStateNeverReset: true,
      cryptographyAndStorageAbstracted: true, concurrentRecoverers: false,
    },
    intersections: [freshnessIntersections(3, 3), freshnessIntersections(4, 3), freshnessIntersections(4, 4)],
    readRepair: readRepairReport(), generationFreeze: generationFreezeReport(),
    counterexamples: recoveryCounterexamples(),
    payloadBudgets: [64 * 1024, 1024 * 1024, 8 * 1024 * 1024].map(snapshotPayloadBudget),
  };
}
