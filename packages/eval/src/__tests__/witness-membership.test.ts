import { expect, it } from 'vitest';
import { compareMemberships, fourOfFiveQuorums, membershipReport } from '../witness-membership.js';

it('enumerates every certificate pair for zero through five replacements', () => {
  const report = membershipReport();
  expect(report.replacements.map(row => row.comparedPairs)).toEqual([25, 25, 25, 25, 25, 25]);
  expect(report.replacements.map(row => row.minimumIntersection)).toEqual([3, 2, 1, 0, 0, 0]);
  expect(report.replacements.slice(0, 2).every(row => row.unsafePairs === 0)).toBe(true);
  expect(report.replacements.slice(2).every(row => row.unsafePairs > 0)).toBe(true);
});

it('shows why adjacent safe intersections do not establish safety across successive replacements', () => {
  const { successiveReplacements: chain } = membershipReport();
  expect(chain.first.unsafePairs).toBe(0);
  expect(chain.second.unsafePairs).toBe(0);
  expect(chain.oldestVersusNewest.unsafePairs).toBeGreaterThan(0);
  expect(chain.trace.oldCertificate.filter(member => chain.trace.newCertificate.includes(member))).toEqual([chain.trace.equivocator]);
  expect(fourOfFiveQuorums(chain.trace.oldMembers)).toContainEqual(chain.trace.oldCertificate);
  expect(fourOfFiveQuorums(chain.trace.finalMembers)).toContainEqual(chain.trace.newCertificate);
});

it('is invariant under member order and never treats missing or duplicated identities as membership', () => {
  const old = ['A', 'B', 'C', 'D', 'E'], next = ['A', 'B', 'C', 'F', 'G'];
  const forward = compareMemberships(old, next), reverse = compareMemberships([...next].reverse(), [...old].reverse());
  expect(forward.minimumIntersection).toBe(reverse.minimumIntersection);
  expect(forward.unsafePairs).toBe(reverse.unsafePairs);
  expect(() => fourOfFiveQuorums(['A', 'A', 'B', 'C', 'D'])).toThrow();
  expect(() => fourOfFiveQuorums(['A', 'B', 'C', 'D'])).toThrow();
});
