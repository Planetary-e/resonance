/** Exhaustive certificate-intersection model, not a dynamic protocol proof.
 * At most one fixed Byzantine identity across all compared configurations.
 * Honest identities retain every vote; newcomers have no transferred history.
 */
function validate(members: string[]) {
  if (members.length !== 5 || new Set(members).size !== 5 || members.some(member => !member)) {
    throw new Error('Exactly five distinct witness identities required');
  }
}

export function fourOfFiveQuorums(members: string[]): string[][] {
  validate(members);
  return members.map((_, omitted) => members.filter((_, i) => i !== omitted));
}

export function compareMemberships(oldMembers: string[], newMembers: string[]) {
  const pairs = fourOfFiveQuorums(oldMembers).flatMap(oldQuorum => fourOfFiveQuorums(newMembers).map(newQuorum => {
    const intersection = oldQuorum.filter(member => newQuorum.includes(member));
    return { oldQuorum, newQuorum, intersection, permitsConflictingCertificates: intersection.length <= 1 };
  }));
  return {
    oldMembers, newMembers, comparedPairs: pairs.length,
    minimumIntersection: Math.min(...pairs.map(pair => pair.intersection.length)),
    unsafePairs: pairs.filter(pair => pair.permitsConflictingCertificates).length,
    counterexample: pairs.find(pair => pair.permitsConflictingCertificates) ?? null,
  };
}

export function membershipReport() {
  const original = ['A', 'B', 'C', 'D', 'E'];
  const replacements = Array.from({ length: 6 }, (_, replaced) => ({ replaced,
    ...compareMemberships(original, [...original.slice(0, 5 - replaced), ...['F', 'G', 'H', 'I', 'J'].slice(0, replaced)]),
  }));
  const intermediate = ['A', 'B', 'C', 'D', 'F'], final = ['A', 'B', 'C', 'F', 'G'];
  return {
    assumptions: { witnessesPerSet: 5, quorum: 4, maxByzantineAcrossUnion: 1, honestVotesNeverReset: true,
      stateTransfer: false, retiredConfigurationsFenced: false, model: 'certificate intersections only' },
    replacements,
    successiveReplacements: {
      first: compareMemberships(original, intermediate), second: compareMemberships(intermediate, final),
      oldestVersusNewest: compareMemberships(original, final),
      trace: { oldMembers: original, intermediateMembers: intermediate, finalMembers: final,
        oldCertificate: ['A', 'B', 'D', 'E'], newCertificate: ['A', 'C', 'F', 'G'], equivocator: 'A',
        explanation: 'A signs both bindings. B,D,E sign only the old binding; C,F,G sign only the new binding. The intermediate set need not certify either.' },
    },
  };
}
