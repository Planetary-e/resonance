/** Exhaustive finite quorum model. These are protocol assumptions/counterexamples,
 * not network measurements or proof of an implemented durable observer service. */
import { expect, it } from 'vitest';
const population = [0, 1, 2, 3, 4];
const subsets = Array.from({ length: 32 }, (_, mask) => population.filter(member => (mask & (1 << member)) !== 0));
const quorums = (size: number) => subsets.filter(set => set.length >= size);
const intersection = (a: number[], b: number[]) => a.filter(member => b.includes(member));

it('every four/five activation and later observation overlap in honest retained state with at most one faulty member', () => {
  let checked = 0;
  for (const faulty of [-1, ...population]) for (const activated of quorums(4)) for (const read of quorums(4)) {
    const honestInstalled = activated.filter(member => member !== faulty);
    expect(intersection(honestInstalled, read).length).toBeGreaterThan(0);
    const canAnswerOld = read.every(member => member === faulty || !honestInstalled.includes(member));
    expect(canAnswerOld).toBe(false); checked++;
  }
  expect(checked).toBe(216);
});
it('two conflicting policies at one revision cannot each get four approvals if honest observers never approve both', () => {
  for (const faulty of [-1, ...population]) for (const a of quorums(4)) for (const b of quorums(4)) {
    expect(intersection(a, b).some(member => member !== faulty)).toBe(true);
  }
});
it('exposes unsafe three/three quorums, lost local history, uncommitted updates and replayed observations', () => {
  const faulty = 0, a = [0, 1, 2], b = [0, 3, 4];
  expect(intersection(a, b).every(member => member === faulty)).toBe(true);
  // A single observer seeing a new signed policy does not activate it globally.
  expect(intersection([1], [0, 2, 3, 4])).toEqual([]);
  // Honest members 1 and 2 losing their retained updates make an old four-vote read possible.
  const installed = [0, 1, 2, 3], lost = [1, 2], read = [0, 1, 2, 4];
  expect(read.every(member => member === faulty || !installed.includes(member) || lost.includes(member))).toBe(true);
  // Even a valid pre-update observation can be replayed unless bound to a new
  // challenge and bounded operation lifetime; it is not a permanent freshness fact.
  const old = { challenge: 'before-update', head: 1 }, request = { challenge: 'after-update' };
  expect(old.challenge === request.challenge).toBe(false);
});
it('only six reachability subsets can supply four responses even before a faulty member withholds its vote', () => {
  const available = subsets.filter(reachable => reachable.length >= 4);
  expect(available).toHaveLength(6);
  expect(subsets.filter(reachable => reachable.length < 4)).toHaveLength(26);
});
