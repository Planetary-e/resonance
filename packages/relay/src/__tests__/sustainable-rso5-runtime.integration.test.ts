import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { generateSigningKeyPair, withAdmissionReplayValues, type SigningKeyPair } from '@resonance/core';
import type { AdmissionWorkMeter } from '@resonance/core/admission-work';
import { signAdmissionPolicy, admissionPolicyDigest, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadCertificate } from '@resonance/core/admission-policy-freshness';
import { createAdmissionWitnessRequest, createAdmissionWitnessVote, admissionWitnessSetId, type AdmissionSpendClaim } from '@resonance/core/admission-witness';
import { createWitnessHandoffProposal, createWitnessHandoffActivation } from '@resonance/core/admission-witness-handoff';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openSustainableRso5Arena } from '../sustainable-rso5-arena.js';
import { createSustainableRso5Replica, openSustainableRso5ProtectedArena, recoveryDigest, type Rso5Transport, type SustainableRso5ProtectedArena } from '../sustainable-rso5-protected-arena.js';
import { generateRso5RecipientKey, type Rso5FrameIdentity, type Rso5RecipientKeyMaterial } from '../sustainable-rso5-opaque.js';
import { prepareSustainableRecoveryBootstrap, openSustainableRecoveryRuntime, recoveryNewViewProposal, type SustainableRecoveryRuntime, type RecoveryBusinessCommand, type RecoveryCertificate, type RecoveryTransfer } from '../sustainable-rso5-runtime.js';
import { preflightRso5Manifest } from '../sustainable-rso5-manifest.js';
import { freezeProtectedWitness, prepareTerminalProtectedWitness } from '../protected-witness-handoff.js';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { createHistoryCheckpointReplica } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { sustainableLegacyFixture, declareSustainableOriginals, finiteRecoveryManifest } from './sustainable-recovery-fixture.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryJson, sustainableRecoveryWorkUsage, withDiagnosticUnboundedRecoveryWork, type RecoveryWorkUsage } from '../sustainable-recovery-work.js';

const cleanup: Array<() => unknown | Promise<unknown>> = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pub = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
interface Operation { label: string; outcome: string; usage?: RecoveryWorkUsage; cumulativeUsedBytes?: number; forecastBytes?: number; differenceFromForecastBytes?: number; error?: string; stack?: string }
const operations: Operation[] = [];
function forecastBytes(label: string) {
  if (label.startsWith('legacy-prepare:')) return 1706557;
  if (label.startsWith('bootstrap:')) return 4249359;
  if (/:(propose|prepare:\d+|commit:\d+|execute:\d+|finish:\d+)$/.test(label)) return 1344330;
  if (label.startsWith('reserveInstall:2:')) return 4278375;
  if (label.startsWith('reserveInstall:3:')) return 1728233;
  if (/^transfer:[23]:/.test(label)) return 450795;
  if (/^(freeze|readiness):[23]:/.test(label)) return 592948;
  if (/^install:[23]:/.test(label)) return 1061050;
  if (label.startsWith('local-C-recovery:')) return 4278375;
  if (/^startup(?::|$)/.test(label)) return 592948;
  if (label.startsWith('retry:')) return 942144;
  return undefined;
}
const legacyWork: AdmissionWorkMeter = { charge: (bytes, mechanism) => chargeSustainableRecoveryWork(bytes, 'J', mechanism) };
function legacy<T>(work: () => Promise<T>) { return withAdmissionReplayValues({ charge: bytes => chargeSustainableRecoveryWork(bytes, 'J', 'legacy'), check: () => {} }, work); }
function diagnostic<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  return withDiagnosticUnboundedRecoveryWork(async () => {
    try { const result = await work(); operations.push({ label, outcome: 'passed', usage: sustainableRecoveryWorkUsage() }); return result; }
    catch (error) { operations.push({ label, outcome: 'failed', usage: sustainableRecoveryWorkUsage(), error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }); throw error; }
  });
}
function operation<T>(_node: SustainableRecoveryRuntime, label: string, work: () => T | Promise<T>): Promise<T> {
  return diagnostic(label, work);
}
function evidencePath() {
  let usedBytes = 0, firstCumulativeCrossing: Operation | null = null;
  const usages = operations.map(operation => operation.usage).filter((usage): usage is RecoveryWorkUsage => !!usage);
  for (const operation of operations) {
    usedBytes += operation.usage?.usedBytes ?? 0; operation.cumulativeUsedBytes = usedBytes;
    const forecast = forecastBytes(operation.label); if (forecast !== undefined && operation.usage) { operation.forecastBytes = forecast; operation.differenceFromForecastBytes = operation.usage.usedBytes - forecast; }
    if (!firstCumulativeCrossing && usedBytes > 268435456) firstCumulativeCrossing = operation;
  }
  const firstOperationCrossing = operations.find(operation => (operation.usage?.usedBytes ?? 0) > 4718592) ?? null;
  return { usedBytes, firstOperationCrossing, operationCrossingCount: operations.filter(operation => (operation.usage?.usedBytes ?? 0) > 4718592).length, firstCumulativeCrossing, maximum: usages.reduce((max, usage) => Math.max(max, usage.usedBytes), 0), operations };
}
function saveEvidence(result: { outcome: 'failed' | 'blocked' | 'passed'; error?: string; durationMs: number; preparationWork: unknown[] }) {
  const evidence = evidencePath(), actual = {
    legacyPreparations: operations.filter(operation => operation.label.startsWith('legacy-prepare:')).length,
    runtimePhaseCalls: operations.filter(operation => /:(propose|prepare:\d+|commit:\d+|execute:\d+|finish:\d+)$/.test(operation.label)).length,
    leaderProposals: operations.filter(operation => operation.label.endsWith(':propose')).length,
    retries: operations.filter(operation => operation.label.startsWith('retry:')).length,
    viewChangeGroups: new Set(operations.flatMap(operation => /^viewChange:([^:]+):(\d+):\d+$/.exec(operation.label)?.slice(1, 2) ?? [])).size,
    newViewCalls: operations.filter(operation => operation.label.startsWith('newView:')).length,
    completeLocalCLossRecoveries: operations.filter(operation => operation.label.startsWith('local-C-recovery-startup:') && operation.outcome === 'passed').length,
  };
  const inventory = { complete: actual.legacyPreparations === 4 && actual.runtimePhaseCalls === 102 && actual.leaderProposals === 6 && actual.retries === 7 && actual.viewChangeGroups === 2 && actual.newViewCalls === 8 && actual.completeLocalCLossRecoveries === 4,
    expected: { legacyPreparations: 4, runtimePhaseCalls: 102, leaderProposals: 6, otherPhaseCalls: 96, retries: 7, viewChangeGroups: 2, newViewCalls: 8, completeLocalCLossRecoveries: 4 }, actual,
    forecast: { runtimePhaseCalls: 120, viewChangeGroups: 2, note: 'Forecast counted four proposals per command; runtime permits only the deterministic leader. Forecast new-view groups are not member call counts.' } };
  const outcome = result.outcome === 'blocked' || !inventory.complete ? 'blocked' : evidence.usedBytes > 268435456 ? 'failed' : result.outcome;
  const forecastComparison = { totalForecastBytes: 270132258, differenceFromForecastBytes: evidence.usedBytes - 270132258, forecastExcessBytes: 1696802, actualExcessBytes: Math.max(0, evidence.usedBytes - 268435456), unreachableClasses: inventory.complete ? [] : ['complete required inventory'] };
  const run = { outcome, diagnosticUnbounded: true, acceptanceEvaluation: 'not_run', acceptanceComparison: { operationMaximumBytes: 4718592, cumulativeMaximumBytes: 268435456 }, candidateMaximumBytes: 4718592, cumulativeMaximumBytes: 268435456, durationMs: result.durationMs, preparationWork: result.preparationWork, ...evidence, inventory, forecastComparison, error: result.error ?? (inventory.complete ? undefined : 'Required diagnostic inventory incomplete') };
  writeFileSync('delivery/results/rso5-operation-work.json', JSON.stringify(run, null, 2));
  writeFileSync('delivery/results/RUN-RSO5-001.json', JSON.stringify(run, null, 2));
  return run;
}

it('RSO5 measures the complete four-node two-transition inventory', async () => {
  const started = performance.now(), preparationWork: unknown[] = []; operations.length = 0;
  try { await main(preparationWork); saveEvidence({ outcome: 'passed', durationMs: performance.now() - started, preparationWork }); }
  catch (error) { const evidence = saveEvidence({ outcome: 'blocked', durationMs: performance.now() - started, preparationWork, error: error instanceof Error ? error.message : String(error) }); throw new Error(`RSO5 inventory blocked: ${evidence.error}; cumulative=${evidence.usedBytes}`); }
}, 240000);

async function main(preparationWork: unknown[]) {
  const f = await sustainableLegacyFixture(); await f.run(async () => {
    const manifest = finiteRecoveryManifest(join(f.directory, 'rso5-arenas')); preflightRso5Manifest(f.funding, manifest, 'new');
    const originals = f.actors.slice(0, 4), cohort = f.actors.slice(4, 8), accepted = f.row(); await originals[0].history.write(accepted);
    const claim: AdmissionSpendClaim = { setId: admissionWitnessSetId(f.proposal.oldSet), issuerKey: f.policy.activeKey, spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${'p'.repeat(86)}` };
    const votes = await Promise.all(originals.map((actor, index) => diagnostic(`vote:create:${index}`, () => createAdmissionWitnessVote(claim, actor.key, legacyWork))));
    const retainedVotes = await Promise.all(votes.map((vote, index) => index === 3 ? diagnostic('vote:create-alternate', () => createAdmissionWitnessVote({ ...claim, requestBinding: `admreq_${'q'.repeat(86)}` }, originals[index].key, legacyWork)) : vote));
    for (let index = 0; index < 4; index++) await originals[index].history.writeRoleDecision({ kind: 'witness-vote', vote: retainedVotes[index] });
    for (const actor of originals) await freezeProtectedWitness(actor.history, f.proposal, actor.key, actor.encryptionKey);
    const pins = originals.map(actor => ({ context: actor.context, genesisId: historyCheckpointEnvelopeId(actor.root), rootId: historyCheckpointEnvelopeId(actor.history.read().root), generation: 0, nextGeneration: 1, head: { ...actor.history.read().applied! } }));
    const pairs: Awaited<ReturnType<typeof prepareTerminalProtectedWitness>>[] = []; for (const actor of originals) pairs.push(await prepareTerminalProtectedWitness(actor.history, f.proposal, { mode: 'create-new', nextGeneration: 1 }));
    declareSustainableOriginals(manifest, pairs, f.policy, retainedVotes);
    const observers: Array<Awaited<ReturnType<typeof openProtectedPolicyObserver>>> = []; let currentHead = f.observerContext.genesis;
    for (let index = 0; index < 4; index++) {
      const encryptionKey = randomBytes(32), enrolled = await diagnostic(`observer-root:${index}`, () => legacy(() => createPolicyObserverHistoryRoot({ context: f.observerContext, signingKey: f.observerKeys[index], encryptionKey, policy: f.policy, writerStateBytes: 3 * 4 * 1024 ** 2 + 65536 })));
      const stores = enrolled.context.members.map((replica, j) => openHistoryCheckpointStore({ directory: join(f.directory, `rso5-observer-${index}-replica-${j}`), context: enrolled.context, replica, localKey: randomBytes(32), rootId: historyCheckpointEnvelopeId(enrolled.root), generation: 0, initialize: enrolled.root, maxBytes: 6 * 1024 ** 2 })); stores.forEach(store => cleanup.push(store.close));
      const roles = stores.map((store, j) => createHistoryCheckpointReplica({ context: enrolled.context, store, signingKey: f.observerKeys.find(key => pub(key) === enrolled.context.members[j])! })); roles.forEach(role => cleanup.push(role.close));
      const observer = await diagnostic(`observer-open:${index}`, () => openProtectedPolicyObserver({ directory: join(f.directory, `rso5-observer-${index}`), encryptionKey, context: f.observerContext, signingKey: f.observerKeys[index], historyContext: enrolled.context, root: enrolled.root, members: enrolled.context.members.map((publicKey, j) => ({ publicKey, endpoint: `ws://127.0.0.1:${49000 + j}/` })), work: legacyWork, transport: async (member, frame) => {
        const requestBytes = sustainableRecoveryJson(frame, 'J'); chargeSustainableRecoveryWork(requestBytes.length, 'J', 'disk-write');
        const reply = await legacy(async () => roles[enrolled.context.members.indexOf(member.publicKey)].exchange(frame)), replyBytes = sustainableRecoveryJson(reply, 'J'); chargeSustainableRecoveryWork(replyBytes.length, 'J', 'disk-read'); return reply;
      }, mode: 'create-new', maxArchiveBytes: 4 * 1024 ** 2 })); cleanup.push(observer.close); await diagnostic(`observer-ready:${index}`, () => observer.ready()); observers.push(observer);
    }
    const fresh = async (policy: SignedAdmissionPolicy, deadline: number) => legacy(async () => { const request = createAdmissionPolicyHeadRequest(f.observerContext, Date.now(), 3000, legacyWork); const cert = parseAdmissionPolicyHeadCertificate({ version: 1, kind: 'admission-policy-head-certificate', votes: await Promise.all(observers.map(observer => observer.observe(request))) }, request, f.observerContext, currentHead, Date.now(), legacyWork); expect(cert.votes[0].head.digest).toBe(admissionPolicyDigest(policy, legacyWork)); if (performance.now() > deadline) throw new Error('Live policy deadline exceeded'); });
    interface NodeInfo { actor: (typeof f.actors)[number]; scope: string; recipientKey: Rso5RecipientKeyMaterial; replicas: string[]; transport: Rso5Transport; storage: SustainableRso5ProtectedArena }
    const nodeInfo = new Map<SustainableRecoveryRuntime, NodeInfo>();
    async function node(actor: (typeof f.actors)[number], index: number) {
      const arena = openSustainableRso5Arena({ authority: f.funding, manifest, owner: `witness-${index}`, copy: 0, key: actor.encryptionKey, mode: 'new' });
      const storageKeys = Array.from({ length: 5 }, generateSigningKeyPair), replicaArenas = storageKeys.map((_, j) => openSustainableRso5Arena({ authority: f.funding, manifest, owner: `witness-${index}`, copy: j + 1, key: randomBytes(32), mode: 'new' })); replicaArenas.forEach(arena => cleanup.push(arena.close));
      const scope = recoveryDigest(Buffer.from(`rso5-witness:${pub(actor.key)}`)), replicas = storageKeys.map((key, j) => createSustainableRso5Replica({ arena: replicaArenas[j], scope, owner: pub(actor.key), signingKey: key })), recipientKey = await generateRso5RecipientKey();
      const transport: Rso5Transport = async (key, request) => replicas.find(replica => replica.replica === key)!.exchange(request);
      const storage = openSustainableRso5ProtectedArena({ arena, scope, signingKey: actor.key, recipientKey, replicas: replicas.map(replica => replica.replica), transport });
      const runtime = openSustainableRecoveryRuntime({ storage, key: actor.key, manifest, originalGenesis: f.policy, configuration: f.proposal.oldSet, freshPolicy: fresh });
      nodeInfo.set(runtime, { actor, scope, recipientKey, replicas: replicas.map(replica => replica.replica), transport, storage }); return runtime;
    }
    const oldNodes: SustainableRecoveryRuntime[] = [], newNodes: SustainableRecoveryRuntime[] = [];
    for (let index = 0; index < 4; index++) { const runtime = await node(originals[index], index); cleanup.push(runtime.close); const capability = await withDiagnosticUnboundedRecoveryWork(() => prepareSustainableRecoveryBootstrap({ manifest, proposal: f.proposal, originals: pairs, pins, genesis: f.policy }), usage => { preparationWork.push(usage); operations.push({ label: `legacy-prepare:${index}`, outcome: 'passed', usage }); }); await operation(runtime, `bootstrap:${index}`, () => runtime.bootstrap(capability)); oldNodes.push(runtime); }
    for (let index = 0; index < 4; index++) { const runtime = await node(cohort[index], index + 5); cleanup.push(runtime.close); newNodes.push(runtime); }
    const funded = f.funding.status(); f.funding.reserve({ path: join(f.directory, 'all-remaining'), component: 'test', scope: 'file', maximumBytes: funded.availableBytes }); expect(f.funding.status().availableBytes).toBe(0);
    async function execute(nodes: SustainableRecoveryRuntime[], command: RecoveryBusinessCommand) {
      const journal = await operation(nodes[0], `${command.kind}:read-leader`, () => nodes[0].read()), members = journal.configuration.members, leader = nodes.find((node, index) => members[journal.view % 5].publicKey === pub((nodes === oldNodes ? originals : cohort)[index].key));
      if (!leader) throw new Error('RSO5 fixture lacks deterministic leader');
      const proposal = await operation(leader, `${command.kind}:propose`, () => leader.propose(command));
      const prepares = await Promise.all(nodes.map((node, index) => operation(node, `${command.kind}:prepare:${index}`, () => node.prepare(proposal))));
      const prepared: RecoveryCertificate = { phase: 'prepare', header: proposal.header, signatures: prepares }, commits = await Promise.all(nodes.map((node, index) => operation(node, `${command.kind}:commit:${index}`, () => node.commit(prepared))));
      const committed: RecoveryCertificate = { phase: 'commit', header: proposal.header, signatures: commits }, done = await Promise.all(nodes.map((node, index) => operation(node, `${command.kind}:execute:${index}`, () => node.execute(committed))));
      const cut = command.kind === 'cut' ? { phase: 'cut' as const, header: proposal.header, signatures: done } : undefined;
      await Promise.all(nodes.map((node, index) => operation(node, `${command.kind}:finish:${index}`, () => node.finish(cut)))); return cut;
    }
    await execute(oldNodes, { kind: 'cut' }); for (const node of oldNodes) await operation(node, 'startup', () => node.startup());
    const request = await diagnostic('retry-request:initial', () => createAdmissionWitnessRequest({ ...claim, spend: accepted.spend, action: 'search', requestBinding: accepted.binding }, f.coordinator, legacyWork));
    expect(await operation(oldNodes[0], 'retry:initial', () => oldNodes[0].retry(request))).toMatchObject({ owner: pub(originals[0].key), ...accepted });
    async function newView(nodes: SustainableRecoveryRuntime[], view: number, group: string) {
      const records = await Promise.all(nodes.map((node, index) => operation(node, `viewChange:${group}:${view}:${index}`, () => node.viewChange(view)))), cut = await operation(nodes[0], `read-stable:${view}`, () => nodes[0].read().stable), proposal = await operation(nodes[0], `new-view-proposal:${view}`, () => recoveryNewViewProposal(records, cut!));
      const snapshots: RecoveryTransfer[] = []; for (let index = 0; index < nodes.length; index++) snapshots.push(await operation(nodes[0], `view-transfer:${view}:${index}`, () => nodes[0].transfer(proposal, nodes[index].recipientEnrollment(cut!))));
      await Promise.all(nodes.map((node, index) => operation(node, `newView:${view}:${index}`, () => node.newView(records, snapshots[index]))));
    }
    await newView(oldNodes, 1, 'initial');
    await execute(oldNodes, { kind: 'reconfigure', proposal: f.proposal }); await execute(oldNodes, { kind: 'cut' });
    async function transfer(from: SustainableRecoveryRuntime[], to: SustainableRecoveryRuntime[], proposal: typeof f.proposal, current: SignedAdmissionPolicy, revision: number) {
      const cut = await operation(from[0], `read-stable:${revision}`, () => from[0].read().stable), snapshots: RecoveryTransfer[] = []; for (let index = 0; index < to.length; index++) snapshots.push(await operation(from[0], `transfer:${revision}:${index}`, () => from[0].transfer(proposal, to[index].recipientEnrollment(cut!))));
      await expect(operation(from[0], `freeze-refusal:${revision}`, () => from[0].freeze([]))).rejects.toThrow('reservations');
      const reservations = await Promise.all(to.map((node, index) => operation(node, `reserveInstall:${revision}:${index}`, () => node.reserveInstall(snapshots[index], proposal))));
      const freezes = await Promise.all(from.map((node, index) => operation(node, `freeze:${revision}:${index}`, () => node.freeze(reservations)))), cutId = recoveryDigest(await operation(from[0], `cut-id:${revision}`, async () => (await import('../sustainable-rso5-runtime.js')).recoveryHeaderBytes(snapshots[0].cut.header)));
      const seal = { version: 1 as const, proposal, manifest: cutId, freezes, activation: null }, started = performance.now(), drained = await Promise.all(observers.map((observer, index) => operation(from[0], `observer-drain:${revision}:${index}`, () => legacy(() => observer.drainWitnessHandoff(seal))))); expect(performance.now() - started).toBeGreaterThanOrEqual(3000);
      const ready = await Promise.all(to.map((node, index) => operation(node, `readiness:${revision}:${index}`, () => node.prepareInstall(snapshots[index], proposal, drained))));
      const activation = await operation(from[0], `activation:${revision}`, () => legacy(async () => createWitnessHandoffActivation({ proposal, manifest: cutId, freezes, drained, ready }, f.authorityKey, legacyWork)));
      const { authority, signature, ...body } = current, policy = await operation(from[0], `policy-sign:${revision}`, () => legacy(() => signAdmissionPolicy({ ...body, revision, keys: body.keys.map(key => ({ ...key, witnesses: proposal.newSet, witnessHandoff: activation })) }, authority, f.authorityKey.secretKey, legacyWork)));
      const advance = await operation(from[0], `policy-advance:${revision}`, () => legacy(() => createAdmissionPolicyAdvance(current, policy, f.observerContext, f.authorityKey, proposal.previous, legacyWork))); await Promise.all(observers.map((observer, index) => operation(from[0], `observer-advance:${revision}:${index}`, () => legacy(() => observer.advance(advance))))); currentHead = advance.commitment.next;
      await Promise.all(to.map((node, index) => operation(node, `install:${revision}:${index}`, () => node.install(snapshots[index], activation, policy))));
      for (const node of to) await operation(node, `startup:${revision}`, () => node.startup()); return { policy, advance };
    }
    const first = await transfer(oldNodes, newNodes, f.proposal, f.policy, 2);
    const retryNew = await diagnostic('retry-request:successor', () => createAdmissionWitnessRequest({ ...request, setId: admissionWitnessSetId(f.proposal.newSet) }, f.coordinator, legacyWork)), predecessorAccepted = await operation(oldNodes[0], 'read-predecessor-evidence', () => oldNodes[0].read().state.evidence.accepted[0]); expect(await operation(newNodes[0], 'retry:successor', () => newNodes[0].retry(retryNew))).toEqual(predecessorAccepted);
    const unresolved = await diagnostic('retry-request:uncertainty', () => createAdmissionWitnessRequest({ ...claim, setId: admissionWitnessSetId(f.proposal.newSet) }, f.coordinator, legacyWork));
    await expect(operation(newNodes[0], 'retry:uncertainty', () => newNodes[0].retry(unresolved))).rejects.toThrow('uncertainty');
    await execute(newNodes, { kind: 'certificate', certificate: { version: 1, votes } });
    expect(await operation(newNodes[0], 'retry:resolved', () => newNodes[0].retry(unresolved))).toBeUndefined();
    const returning = await diagnostic('returning-proposal', () => legacy(async () => createWitnessHandoffProposal({ ...f.proposal, id: randomBytes(32).toString('base64url'), previous: first.advance.commitment.next, oldSet: f.proposal.newSet, newSet: { ...f.proposal.oldSet, epoch: randomBytes(32).toString('base64url') } }, f.authorityKey, legacyWork)));
    await execute(newNodes, { kind: 'reconfigure', proposal: returning }); await execute(newNodes, { kind: 'cut' }); await newView(newNodes, 1, 'returning'); await transfer(newNodes, oldNodes, returning, first.policy, 3);
    const retryReturned = await diagnostic('retry-request:returned', () => createAdmissionWitnessRequest({ ...request, setId: admissionWitnessSetId(returning.newSet) }, f.coordinator, legacyWork)); expect(await operation(oldNodes[0], 'retry:returned', () => oldNodes[0].retry(retryReturned))).toMatchObject({ owner: pub(originals[0].key), ...accepted });
    const denialRequest = await diagnostic('retry-request:denial', () => createAdmissionWitnessRequest({ ...claim, setId: admissionWitnessSetId(returning.newSet), requestBinding: `admreq_${'q'.repeat(86)}` }, f.coordinator, legacyWork));
    await expect(operation(oldNodes[0], 'retry:denial', () => oldNodes[0].retry(denialRequest))).rejects.toThrow('Retained denial');
    const conflictRequest = await diagnostic('retry-request:conflict', () => createAdmissionWitnessRequest({ ...retryReturned, requestBinding: `admreq_${'z'.repeat(86)}` }, f.coordinator, legacyWork));
    await expect(operation(oldNodes[0], 'retry:conflict', () => oldNodes[0].retry(conflictRequest))).rejects.toThrow('Conflicting');
    for (const predecessor of newNodes) predecessor.close();
    for (let index = 0; index < oldNodes.length; index++) {
      const node = oldNodes[index], info = nodeInfo.get(node)!, journal = await operation(node, `local-C-read:${index}`, () => node.read());
      const references = await operation(node, `local-C-references:${index}`, () => info.storage.references(journal.state.proofs)), identities = new Map<string, Rso5FrameIdentity>(references.map(reference => [reference.proofId, reference]));
      const arena = info.storage.arena; node.close();
      const fs = await import('node:fs'); fs.rmSync(arena.path, { recursive: true, force: true }); fs.mkdirSync(arena.path, { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(arena.path, 'frames.bin'), Buffer.alloc(0)); fs.writeFileSync(join(arena.path, 'checkpoints.bin'), Buffer.alloc(0));
      const reopened = openSustainableRso5Arena({ authority: f.funding, manifest, owner: arena.ownerName, copy: 0, key: info.actor.encryptionKey, mode: 'existing' });
      const storage = openSustainableRso5ProtectedArena({ arena: reopened, scope: info.scope, signingKey: info.actor.key, recipientKey: info.recipientKey, replicas: info.replicas, transport: info.transport });
      storage.configureOriginal({ genesis: journal.state.originalGenesis, configuration: admissionWitnessSetId(journal.configuration), context: journal.state.context });
      const runtime = openSustainableRecoveryRuntime({ storage, key: info.actor.key, manifest, originalGenesis: f.policy, configuration: returning.newSet, freshPolicy: fresh });
      await operation(runtime, `local-C-recovery:${index}`, async () => { await storage.startup(false); await storage.recoverSelected(journal.state.proofs, identities); });
      await operation(runtime, `local-C-recovery-startup:${index}`, () => runtime.startup()); oldNodes[index] = runtime; cleanup.push(runtime.close);
    }
    expect(f.funding.status().availableBytes).toBe(0);
  });
}
