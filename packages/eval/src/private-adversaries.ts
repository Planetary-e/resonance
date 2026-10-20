/** Local cryptographic/selection counterexamples, not a deployed-network estimate. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  generateIdentity, generateSearchKeyMaterialV2, createSearchRequestV2, createSearchRequestFrameV2,
  serializeSearchRequestFrameV2, parseSearchRequestFrameV2, generateRelayTransportKeyV1,
  createPrivateRequestV1, openPrivateEntryRequestV1, openPrivateDestinationRequestV1, PrivateRequestReplayCacheV1,
  createRelayDescriptorV1, selectPrivateRouteV1, type PrivateRouteCandidateV1,
} from '@resonance/core';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const now = Date.now(), identities = [generateIdentity(), generateIdentity()];
const entry = await generateRelayTransportKeyV1(identities[0], now), destination = await generateRelayTransportKeyV1(identities[1], now);
const entryReplay = new PrivateRequestReplayCacheV1(), destinationReplay = new PrivateRequestReplayCacheV1();
const entries: Array<{ source: number; requestId: string }> = [], destinations: Array<{ searchId: string; requestId: string }> = [];
const truth = new Map<string, number>(); let exposedSearchIdsAtEntry = 0;
try {
  for (let i = 0; i < 32; i++) {
    const keys = generateSearchKeyMaterialV2();
    try {
      const request = createSearchRequestV2({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
        fingerprint: new Uint8Array(64).fill(i), itemType: 'need', k: 5, threshold: 0.8, createdAt: now, expiresAt: now + 30000 }, keys);
      const raw = serializeSearchRequestFrameV2(createSearchRequestFrameV2(request));
      const encrypted = await createPrivateRequestV1(new TextEncoder().encode(raw), entry.attestation, destination.attestation, now + 1);
      const inner = await openPrivateEntryRequestV1(encrypted.request, entry, entryReplay, now + 2);
      if (JSON.stringify([encrypted.request, inner]).includes(request.searchId)) exposedSearchIdsAtEntry++;
      const opened = await openPrivateDestinationRequestV1(inner, destination, destinationReplay, now + 3);
      const decoded = parseSearchRequestFrameV2(new TextDecoder('utf8', { fatal: true }).decode(opened.data));
      // Source labels model addresses observed by an entry operator. They never
      // enter the encrypted request or destination payload.
      const source = i % 8; truth.set(request.searchId, source);
      entries.push({ source, requestId: encrypted.request.requestId });
      destinations.unshift({ searchId: decoded.request.searchId, requestId: inner.requestId });
    } finally { keys.signingKeyPair.secretKey.fill(0); }
  }
} finally { identities.forEach(identity => identity.secretKey.fill(0)); }
const join = new Map(entries.map(row => [row.requestId, row.source]));
const linked = destinations.filter(row => join.get(row.requestId) === truth.get(row.searchId)).length;
assert.equal(exposedSearchIdsAtEntry, 0); assert.equal(linked, 32);

function candidate(index: number): PrivateRouteCandidateV1 {
  const identity = generateIdentity(), endpoint = `wss://relay-${index}.example.invalid/`;
  try {
    return { descriptor: createRelayDescriptorV1({ sequence: 1, endpoints: [endpoint], reachability: 'direct',
      capabilities: { storesPublications: true, storesMailboxes: true, answersQueries: true, forwardsQueries: true, replicaExchange: true },
      supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 900000 }, issuedAt: now, expiresAt: now + 60000 }, identity),
      endpoint, remoteAddress: `2001:db8:${index + 1}::1` };
  } finally { identity.secretKey.fill(0); }
}
const fixedDestination = candidate(8), pool = Array.from({ length: 8 }, (_, i) => candidate(i));
let eligible = 0;
for (const member of pool) { selectPrivateRouteV1([member, fixedDestination], now + 1); eligible++; }
assert.equal(eligible, 8);
assert.throws(() => selectPrivateRouteV1([fixedDestination, fixedDestination], now + 1));
assert.throws(() => selectPrivateRouteV1([{ ...pool[0], remoteAddress: fixedDestination.remoteAddress }, fixedDestination], now + 1));

/** Exact enumeration of the client's uniformly selected starting entry followed
 * by cyclic fallback. Honest availability is an explicit independent Bernoulli
 * assumption; attacker entries are online. A malicious fixed destination is
 * assumed, so capture is conditional on that destination already being chosen. */
function capture(attackerSlots: readonly number[], honestAvailability: number) {
  const attackers = new Set(attackerSlots), honest = pool.map((_, i) => i).filter(i => !attackers.has(i));
  let routeProbability = 0, capturedProbability = 0;
  for (let mask = 0; mask < 2 ** honest.length; mask++) {
    const online = new Set(attackers); let probability = 1;
    honest.forEach((slot, bit) => { const up = !!(mask & (1 << bit)); probability *= up ? honestAvailability : 1 - honestAvailability; if (up) online.add(slot); });
    if (!online.size) continue;
    for (let start = 0; start < pool.length; start++) {
      const selected = Array.from({ length: pool.length }, (_, offset) => (start + offset) % pool.length).find(slot => online.has(slot))!;
      routeProbability += probability / pool.length;
      if (attackers.has(selected)) capturedProbability += probability / pool.length;
    }
  }
  const rounded = (n: number) => Number(n.toFixed(8));
  return { routeProbability: rounded(routeProbability), capturedProbability: rounded(capturedProbability),
    captureAmongAvailableRoutes: routeProbability ? rounded(capturedProbability / routeProbability) : null };
}
const cases = [];
for (const attackers of [0, 1, 2, 4, 6, 8]) {
  const arrangements = { clustered: Array.from({ length: attackers }, (_, i) => i),
    spread: Array.from({ length: attackers }, (_, i) => Math.floor(i * 8 / attackers)) };
  for (const [arrangement, slots] of Object.entries(arrangements)) for (const availability of [1, 0.75, 0.5, 0.25]) {
    const result = capture(slots, availability);
    if (availability === 1) assert.equal(result.capturedProbability, attackers / 8);
    if (attackers === 8) assert.equal(result.captureAmongAvailableRoutes, 1);
    if (attackers === 0) assert.equal(result.captureAmongAvailableRoutes, 0);
    cases.push({ poolSize: 8, attackers, arrangement, honestAvailability: availability, ...result });
  }
}
const report = { measuredAt: new Date().toISOString(), node: process.version,
  cryptographicExercise: { requests: 32, modeledSources: 8, entryExposedSearchIds: exposedSearchIdsAtEntry,
    colludingSourceOperationLinks: linked, colludingLinkAccuracy: linked / destinations.length, attack: 'Exact shared request-ID join, ignoring message order' },
  selectionBoundary: { candidates: 8, acceptedDistinctKeysAndDomains: eligible, sameKeyRejected: true, sameDomainRejected: true,
    operatorOwnershipChecked: false, connectionAuthenticationSimulated: true },
  conditionalCaptureCases: cases,
  limitations: [
    'Real signed search frames and HPKE encryption/decryption, but in one process with modeled source labels, no sockets or TLS traffic.',
    'Generated signed descriptors and documentation IPv6 domains exercise production eligibility checks; endpoint authentication is assumed, not performed.',
    'Entry selection/fallback availability is an exact synthetic model, not a measurement of volunteer uptime, independent operators or actual network capture.',
    'Probabilities are conditional on an already selected malicious destination. The current client does not choose both hops uniformly from one population.',
    'The eight configured entries are assumed to include the stated attacker slots; this is not a discovery-injection or key-forgery exploit.',
    'Shuffling, padding and removing this shared identifier do not defeat colluding entry/exit operators that retain their forwarded ciphertext mappings.',
  ] };
if (values.out) writeFileSync(resolve(values.out), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ colludingLinkAccuracy: report.cryptographicExercise.colludingLinkAccuracy, eligibleSybilKeys: eligible, modeledCases: cases.length }));
