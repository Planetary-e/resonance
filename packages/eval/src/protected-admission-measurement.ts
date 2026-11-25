import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createAdmissionRequestBindingV2,
  presentBlindAdmissionTokenV2,
} from '@resonance/core';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import {
  createAdmissionPolicyHeadVote,
  parseAdmissionPolicyObservers,
} from '@resonance/core/admission-policy-freshness';
import { createConfiguredAdmissionVerifier } from '../../relay/src/configured-admission-verifier.js';
import type { AdmissionDecisionQueueEvent } from '../../relay/src/admission-decision-queue.js';
import { witnessFixture } from '../../relay/src/__tests__/fixtures/admission-witness-fixture.js';
import { protectedRoleFixture } from '../../relay/src/__tests__/fixtures/protected-role-fixture.js';

const outputRoot = mkdtempSync(join(tmpdir(), 'resonance-protected-admission-measurement-'));
const deadlineMs = 3000;
const sourceFiles = [
  'packages/eval/src/protected-admission-measurement.ts',
  'packages/relay/src/admission-decision-queue.ts',
  'packages/relay/src/configured-admission-verifier.ts',
  'packages/relay/src/blind-admission-verifier.ts',
  'packages/relay/src/protected-admission-history.ts',
  'packages/relay/src/admission-witness.ts',
  'packages/relay/src/protected-admission-roles.ts',
  'packages/relay/src/__tests__/fixtures/admission-witness-fixture.ts',
  'packages/relay/src/__tests__/fixtures/protected-role-fixture.ts',
];
const source = sourceFiles.map(path => ({
  path,
  sha256: createHash('sha256').update(readFileSync(resolve(path))).digest('hex'),
}));
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
};
const summary = (values: number[]) => ({
  count: values.length,
  p50Ms: percentile(values, 0.50),
  p95Ms: percentile(values, 0.95),
  p99Ms: percentile(values, 0.99),
  maximumMs: values.length ? Math.max(...values) : null,
});

const f = await witnessFixture();
const n = await protectedRoleFixture(f);
let verifier: Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>> | undefined;
const events: AdmissionDecisionQueueEvent[] = [];
try {
  const capture = await n.capture();
  try { await capture.apply((await capture.review()).approvalDigest); } finally { capture.close(); }
  const observers = parseAdmissionPolicyObservers({
    version: 1,
    kind: 'admission-policy-observers',
    authority: f.authority,
    genesis: admissionPolicyHead(f.policy),
    quorum: 4,
    members: f.body.keys[0].witnesses!.members,
  });
  const before = {
    sequence: n.history.read().applied!.sequence,
    spendCount: n.history.read().image.state.spends.length,
    certificateCount: n.history.roleState().coordinator!.certificates.length,
  };
  n.history.close();
  verifier = await createConfiguredAdmissionVerifier({
    ...n.options,
    historyProtection: n.options.protection,
    initialize: true,
    initializeSpendHistory: false,
    policyObservers: observers,
    coordinatorKey: f.coordinators[0],
    decisionObserver: event => { events.push(event); },
    policyObservationTransport: async (member, frame) => (
      createAdmissionPolicyHeadVote(frame.request, observers.genesis, observers,
        f.witnesses.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!, f.time)
    ),
    witnessTransport: async (member, value) => {
      const index = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
      if (!index) throw new Error('self offline');
      return n.witnesses[index].vote(value);
    },
  });
  const firstToken = await f.token();
  const secondToken = await f.token();
  const request = async (token: Awaited<ReturnType<typeof f.token>>, query: string) => {
    const binding = createAdmissionRequestBindingV2('search', { query });
    return {
      binding,
      capability: presentBlindAdmissionTokenV2(token, f.scope, 'search', binding),
      context: { action: 'search' as const, requestBinding: binding, now: f.time },
    };
  };
  const first = await request(firstToken, 'bounded-admission-a');
  const replay = await request(firstToken, 'bounded-admission-a');
  const second = await request(secondToken, 'bounded-admission-b');
  const secondReplay = await request(secondToken, 'bounded-admission-b');
  const conflict = await request(firstToken, 'bounded-admission-conflict');
  const invalid = await request(firstToken, 'bounded-admission-invalid');
  const specifications = [
    { name: 'new-spend-a', input: first, expected: 'accepted' },
    { name: 'exact-replay-a', input: replay, expected: 'replay' },
    { name: 'new-spend-b', input: second, expected: 'accepted' },
    { name: 'exact-replay-b', input: secondReplay, expected: 'replay' },
    { name: 'conflicting-spend-a', input: conflict, expected: 'rejected', reason: 'double_spend' },
    { name: 'invalid-token-a', input: { ...invalid, capability: { ...invalid.capability, token: 'invalid' } }, expected: 'rejected', reason: 'invalid_token' },
  ] as const;
  const outcomes = await Promise.all(specifications.map(async specification => {
    try {
      const outcome = await verifier!.verifyAndSpend(specification.input.capability, specification.input.context);
      return { specification, outcome };
    } catch (error) {
      return { specification, outcome: { status: 'error', error: String(error) } };
    }
  }));
  const evidence = outcomes.map(({ specification, outcome }) => {
    const binding = specification.input.binding;
    const settled = events.find(event => event.phase === 'settled'
      && (event.metadata as any)?.requestBinding === binding
      && (event.outcome as any)?.status === specification.expected);
    const phases = settled ? events.filter(event => event.decisionId === settled.decisionId) : [];
    const queued = phases.find(event => event.phase === 'queued');
    const preparationStarted = phases.find(event => event.phase === 'preparation_started');
    const preparationReady = phases.find(event => event.phase === 'preparation_ready');
    const exclusiveStarted = phases.find(event => event.phase === 'exclusive_started');
    const drained = phases.find(event => event.phase === 'drained');
    const durationMs = queued && settled ? settled.atMs - queued.atMs : null;
    return {
      name: specification.name,
      requestBinding: binding,
      expected: specification.expected,
      outcome,
      decisionId: settled?.decisionId ?? null,
      durationMs,
      queueToExclusiveMs: queued && exclusiveStarted ? exclusiveStarted.atMs - queued.atMs : null,
      preparationMs: preparationStarted && preparationReady ? preparationReady.atMs - preparationStarted.atMs : null,
      exclusiveToSettlementMs: exclusiveStarted && settled ? settled.atMs - exclusiveStarted.atMs : null,
      settlementToDrainMs: settled && drained ? drained.atMs - settled.atMs : null,
      withinDeadline: durationMs !== null && durationMs <= deadlineMs,
      phases,
    };
  });
  verifier.close();
  await verifier.drainPolicyObservations();
  await n.reopen();
  await n.history.ready();
  const after = {
    sequence: n.history.read().applied!.sequence,
    spendCount: n.history.read().image.state.spends.length,
    certificateCount: n.history.roleState().coordinator!.certificates.length,
  };
  const measured = evidence.filter(item => item.decisionId !== null);
  const duplicatePairs = [[outcomes[0], outcomes[1]], [outcomes[2], outcomes[3]]];
  const duplicateDispositionsPass = duplicatePairs.every(pair => (
    pair.map(({ outcome }) => (outcome as any).status).sort().join(',') === 'accepted,replay'
  ));
  const otherOutcomesPass = [outcomes[4], outcomes[5]].every(({ specification, outcome }) => (
    (outcome as any).status === specification.expected && (outcome as any).reason === (specification as any).reason
  ));
  const expectedOutcomes = duplicateDispositionsPass && otherOutcomesPass;
  const deadlinePass = measured.every(item => item.withinDeadline);
  const historyPass = after.sequence === before.sequence + 2
    && after.spendCount === before.spendCount + 2
    && after.certificateCount === before.certificateCount + 2;
  const artifact = {
    schema_version: 1,
    qualification: 'bounded-real-protected-admission-not-qualification',
    command: ['node', '--import', 'tsx', 'packages/eval/src/protected-admission-measurement.ts', ...process.argv.slice(2)],
    source,
    policy: {
      authority: f.authority,
      scope: f.scope,
      sha256: createHash('sha256').update(JSON.stringify(f.policy)).digest('hex'),
      quorum: '4-of-5 witness votes with coordinator certificate',
    },
    spanDefinition: 'performance.now() at AdmissionDecisionQueue queued through operation settlement. Includes preparation-lane waits, exclusive-lane waits, policy/history reads, witness votes, coordinator certificate work, and durable authorized-spend commitment. Drained is reported separately and is not substituted for settlement.',
    deadlineMs,
    outcomes: evidence,
    summary: {
      submitted: outcomes.length,
      measuredDecisions: measured.length,
      expectedOutcomes,
      deadlinePass,
      historyPass,
      accepted: outcomes.filter(({ outcome }) => (outcome as any).status === 'accepted').length,
      replay: outcomes.filter(({ outcome }) => (outcome as any).status === 'replay').length,
      rejected: outcomes.filter(({ outcome }) => (outcome as any).status === 'rejected').length,
      errors: outcomes.filter(({ outcome }) => (outcome as any).status === 'error').length,
      duration: summary(measured.map(item => item.durationMs!)),
    },
    historyEvidence: { before, after },
    pass: expectedOutcomes && deadlinePass && historyPass && measured.length === 5,
    processTreeRssPass: false,
    productionAcceptance: false,
    krAcceptance: false,
    limitations: [
      'One bounded concurrent batch on one host, not a three-run campaign or K1/K4 qualification.',
      'Real signed policy, blind tokens, freshness preparation, witness quorum, and durable protected stores; fixture transports are in-process rather than independent-host or impaired-network paths.',
      'Invalid-token evidence is separate: no protected decision is entered, so it has no queue duration and is not included in the five timed decisions.',
      'Concurrent exact duplicates are evaluated as accepted-plus-replay pairs because caller order does not determine which submission receives the accepted disposition.',
      'The existing processTreeRssPass failure and allocator/RSS variability remain unchanged and unresolved.',
    ],
  };
  const path = join(outputRoot, 'protected-admission-measurement.json');
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ path, pass: artifact.pass, summary: artifact.summary }, null, 2));
} finally {
  if (verifier) {
    verifier.close();
    await verifier.drainPolicyObservations();
  }
  await n.close();
}
