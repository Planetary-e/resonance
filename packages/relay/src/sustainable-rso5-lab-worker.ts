import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withAdmissionReplayValues, type SigningKeyPair } from '@resonance/core';
import type { AdmissionWorkMeter } from '@resonance/core/admission-work';
import { admissionPolicyDigest } from '@resonance/core/admission-policy';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadCertificate } from '@resonance/core/admission-policy-freshness';
import { admissionWitnessSetId } from '@resonance/core/admission-witness';
import { openStorageReservationAuthority, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openSustainableRso5Arena, type SustainableRso5Arena } from './sustainable-rso5-arena.js';
import { createSustainableRso5Replica, openSustainableRso5ProtectedArena, type Rso5Transport, type SustainableRso5ProtectedArena } from './sustainable-rso5-protected-arena.js';
import { generateRso5RecipientKey, type Rso5RecipientKeyMaterial } from './sustainable-rso5-opaque.js';
import { openSustainableRecoveryRuntime, prepareSustainableRecoveryBootstrap, type SustainableRecoveryRuntime } from './sustainable-rso5-runtime.js';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver } from './protected-policy-observer.js';
import { openHistoryCheckpointStore } from './history-checkpoint-store.js';
import { createHistoryCheckpointReplica } from './history-checkpoint-exchange.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryJson, sustainableRecoveryWorkUsage, withDiagnosticUnboundedRecoveryWork } from './sustainable-recovery-work.js';
import { callLabWorker, labTrafficCount, labTrafficPage, labTrafficSince, listenLabWorker, type LabEndpoint } from './sustainable-rso5-lab-transport.js';

type KeyPayload = { publicKey: string; secretKey: string };
type ArenaAuthority = ReturnType<typeof openStorageReservationAuthority>;
type Observer = Awaited<ReturnType<typeof openProtectedPolicyObserver>>;

const role = process.env.RSO5_LAB_WORKER ?? '';
const controlSecret = process.env.RSO5_LAB_CONTROL_CREDENTIAL ?? '';
const replicaChannelSecret = process.env.RSO5_LAB_REPLICA_CREDENTIAL ?? '';
const observerChannelSecrets = JSON.parse(process.env.RSO5_LAB_OBSERVER_CREDENTIALS ?? '{}') as Record<string, string>;
const labId = process.env.RSO5_LAB_ID ?? '';
const deniedSecret = Buffer.alloc(32, 7).toString('base64url');
if (!/^[a-z0-9-]+$/.test(role) || !/^[a-z0-9-]+$/.test(labId) || !controlSecret) throw new Error('Invalid laboratory worker identity');

const startedAt = Date.now(), startedCpu = process.cpuUsage(), lifecycle: Array<{ event: string; at: string }> = [{ event: 'started', at: new Date().toISOString() }];
const listeners: Array<{ close(): Promise<void> }> = [];
const cleanups: Array<() => unknown> = [];
const operations: Array<{ label: string; usedBytes: number }> = [];
let totalWorkBytes = 0, operationCount = 0, stopping = false, metricsCheckpoint = 0;
let authority: ArenaAuthority | undefined;
let replica: ReturnType<typeof createSustainableRso5Replica> | undefined;
let replicaArena: SustainableRso5Arena | undefined;
let observer: Observer | undefined;
let runtime: SustainableRecoveryRuntime | undefined;
let storage: SustainableRso5ProtectedArena | undefined;
let runtimeConfig: any;
let runtimeKey: SigningKeyPair | undefined;
let recipientKey: Rso5RecipientKeyMaterial | undefined;
let scope = '', replicaTargets = new Map<string, LabEndpoint & { credential: string }>(), currentHead: any;

const legacyWork: AdmissionWorkMeter = { charge: (bytes, mechanism) => chargeSustainableRecoveryWork(bytes, 'J', mechanism) };
function legacy<T>(work: () => Promise<T> | T): Promise<T> {
  return withAdmissionReplayValues({ charge: bytes => chargeSustainableRecoveryWork(bytes, 'J', 'legacy'), check: () => {} }, async () => work());
}
async function diagnostic<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  return withDiagnosticUnboundedRecoveryWork(async () => {
    try {
      const result = await work(), usage = sustainableRecoveryWorkUsage()!;
      totalWorkBytes += usage.usedBytes; operationCount++;
      if (label.startsWith('runtime:') || label.startsWith('observer:')) operations.push({ label, usedBytes: usage.usedBytes });
      return result;
    } catch (error) {
      const usage = sustainableRecoveryWorkUsage()!; totalWorkBytes += usage.usedBytes; operationCount++;
      operations.push({ label: `${label}:failed`, usedBytes: usage.usedBytes });
      throw error;
    }
  });
}
function key(value: KeyPayload): SigningKeyPair {
  return { publicKey: Buffer.from(value.publicKey, 'base64url'), secretKey: Buffer.from(value.secretKey, 'base64url') };
}
function bytes(value: string): Buffer { return Buffer.from(value, 'base64url'); }
function publicKey(value: SigningKeyPair): string { return Buffer.from(value.publicKey).toString('base64url'); }
function privateFields(value: unknown, path = ''): void {
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) {
    if (['plaintext', 'privateKey', 'secretKey', 'scopeKey', 'dek', 'recipientKey'].includes(name)) throw new Error(`Private replica field refused at ${path}${name}`);
    privateFields(child, `${path}${name}.`);
  }
}
function openAuthority(directory: string): ArenaAuthority {
  if (!authority) {
    authority = openStorageReservationAuthority({ directory, mode: 'create-new', limitBytes: 2 * 1024 ** 3 });
    cleanups.push(() => authority?.close());
  }
  return authority;
}
function transportFor(targets: Map<string, LabEndpoint & { credential: string }>): Rso5Transport {
  return async (replicaId, request) => {
    const target = targets.get(replicaId);
    if (!target) throw new Error('Unknown laboratory RSO5 replica');
    return callLabWorker({ sender: role, target, secret: target.credential, purpose: `rso5:${request.action}`, payload: request });
  };
}
function freshPolicy(policy: any, deadline: number): Promise<void> {
  return legacy(async () => {
    const request = createAdmissionPolicyHeadRequest(runtimeConfig.observerContext, Date.now(), 3000, legacyWork);
    const votes = await Promise.all((runtimeConfig.observerEndpoints as Array<LabEndpoint & { credential: string }>).map(target =>
      callLabWorker<any>({ sender: role, target, secret: target.credential, purpose: 'observer:observe', payload: request })));
    const certificate = parseAdmissionPolicyHeadCertificate({ version: 1, kind: 'admission-policy-head-certificate', votes }, request,
      runtimeConfig.observerContext, currentHead, Date.now(), legacyWork);
    if (certificate.votes[0].head.digest !== admissionPolicyDigest(policy, legacyWork)) throw new Error('Laboratory fresh policy differs');
    if (performance.now() > deadline) throw new Error('Laboratory live policy deadline exceeded');
  });
}
function openRuntime() {
  if (!storage || !runtimeKey) throw new Error('Laboratory runtime storage unavailable');
  runtime = openSustainableRecoveryRuntime({ storage, key: runtimeKey, manifest: runtimeConfig.manifest,
    originalGenesis: runtimeConfig.genesis, configuration: runtimeConfig.configuration, freshPolicy });
}
async function setupRuntime(config: any) {
  runtimeConfig = config; runtimeKey = key(config.actorKey); scope = config.scope;
  replicaTargets = new Map(config.replicaEndpoints.map((endpoint: LabEndpoint & { publicKey: string; credential: string }) => [endpoint.publicKey,
    { role: endpoint.role, endpoint: endpoint.endpoint, credential: endpoint.credential }]));
  currentHead = config.observerContext.genesis;
  const workerAuthority = openAuthority(join(config.workerDirectory, 'funding'));
  const arena = withStorageReservationAuthority(workerAuthority, () => openSustainableRso5Arena({ authority: workerAuthority,
    manifest: config.manifest, owner: config.owner, copy: 0, key: bytes(config.encryptionKey), mode: 'new' }));
  cleanups.push(() => arena.close());
  recipientKey = await generateRso5RecipientKey();
  storage = openSustainableRso5ProtectedArena({ arena, scope, signingKey: runtimeKey, recipientKey,
    replicas: config.replicaPublicKeys, transport: transportFor(replicaTargets) });
  openRuntime(); lifecycle.push({ event: 'runtime-ready', at: new Date().toISOString() });
  return { role, owner: config.owner };
}
async function setupReplica(config: any) {
  const signingKey = key(config.signingKey), workerAuthority = openAuthority(join(config.workerDirectory, 'funding'));
  replicaArena = withStorageReservationAuthority(workerAuthority, () => openSustainableRso5Arena({ authority: workerAuthority,
    manifest: config.manifest, owner: config.owner, copy: config.copy, key: bytes(config.encryptionKey), mode: 'new' }));
  replica = createSustainableRso5Replica({ arena: replicaArena, scope: config.scope, owner: config.ownerPublicKey, signingKey });
  cleanups.push(() => replicaArena?.close());
  lifecycle.push({ event: 'replica-ready', at: new Date().toISOString() });
  return { role, replica: replica.replica };
}
async function setupObserver(config: any) {
  const workerAuthority = openAuthority(join(config.workerDirectory, 'funding'));
  return withStorageReservationAuthority(workerAuthority, () => setupObserverWithAuthority(config));
}
async function setupObserverWithAuthority(config: any) {
  console.error(`Laboratory observer setup begin ${role}`);
  const signingKey = key(config.signingKey), encryptionKey = bytes(config.encryptionKey);
  const enrolled = await diagnostic('observer:root', () => legacy(() => createPolicyObserverHistoryRoot({ context: config.observerContext,
    signingKey, encryptionKey, policy: config.policy, writerStateBytes: 3 * 4 * 1024 ** 2 + 65536 })));
  console.error(`Laboratory observer root ready ${role}`);
  const targets: Array<LabEndpoint & { credential: string }> = [];
  for (let index = 0; index < enrolled.context.members.length; index++) {
    const member = enrolled.context.members[index], store = openHistoryCheckpointStore({ directory: join(config.workerDirectory, `history-replica-${index}`),
      context: enrolled.context, replica: member, localKey: randomBytes(32), rootId: historyCheckpointEnvelopeId(enrolled.root), generation: 0,
      initialize: enrolled.root, maxBytes: 6 * 1024 ** 2 });
    cleanups.push(() => store.close());
    const historyKey = config.historyKeys.find((candidate: KeyPayload) => candidate.publicKey === member);
    if (!historyKey) throw new Error('Laboratory observer history key unavailable');
    const historyRole = createHistoryCheckpointReplica({ context: enrolled.context, store, signingKey: key(historyKey) });
    cleanups.push(() => historyRole.close());
    const credential = config.historyCredentials[index];
    const endpoint = await listenLabWorker({ role: `${role}-history-${index}`, secret: credential, handler: async (purpose, frame, sender) => {
      if (sender !== role || !purpose.startsWith('observer-history:')) throw new Error('Unauthorized observer history method');
      return diagnostic(`observer:history:${index}`, () => legacy(() => historyRole.exchange(frame)));
    } });
    listeners.push(endpoint); targets.push({ role: endpoint.role, endpoint: endpoint.endpoint, credential });
    console.error(`Laboratory observer history listener ${role} ${index}`);
  }
  const targetByMember = new Map(enrolled.context.members.map((member, index) => [member, targets[index]]));
  observer = await diagnostic('observer:open', () => openProtectedPolicyObserver({ directory: join(config.workerDirectory, 'observer'),
    encryptionKey, context: config.observerContext, signingKey, historyContext: enrolled.context, root: enrolled.root,
    members: enrolled.context.members.map((publicKeyValue, index) => ({ publicKey: publicKeyValue, endpoint: targets[index].endpoint })), work: legacyWork,
    transport: async (member, frame) => {
      const target = targetByMember.get(member.publicKey);
      if (!target) throw new Error('Unknown laboratory history member');
      console.error(`Laboratory observer history call ${role} ${target.role} ${frame.request.action}`);
      const requestBytes = sustainableRecoveryJson(frame, 'J'); chargeSustainableRecoveryWork(requestBytes.length, 'J', 'disk-write');
      let reply: unknown;
      try { reply = await callLabWorker({ sender: role, target, secret: target.credential, purpose: `observer-history:${frame.request.action}`, payload: frame }); }
      catch (error) {
        console.error(`Laboratory observer history failed ${role} ${target.role}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      const replyBytes = sustainableRecoveryJson(reply, 'J'); chargeSustainableRecoveryWork(replyBytes.length, 'J', 'disk-read'); return reply;
    }, mode: 'create-new', maxArchiveBytes: 4 * 1024 ** 2 }));
  cleanups.push(() => observer?.close());
  console.error(`Laboratory observer opened ${role}`);
  console.error(`Laboratory observer readiness begin ${role}`);
  await diagnostic('observer:ready', () => observer!.ready());
  console.error(`Laboratory observer ready ${role}`);
  lifecycle.push({ event: 'observer-ready', at: new Date().toISOString() });
  return { role };
}
async function localRecovery() {
  if (!runtime || !storage || !runtimeConfig || !runtimeKey || !recipientKey) throw new Error('Laboratory local recovery unavailable');
  const journal = runtime.read(), identities = new Map(storage.references(journal.state.proofs).map(identity => [identity.proofId, identity]));
  const previousArena = storage.arena, owner = previousArena.ownerName, path = previousArena.path;
  runtime.close(); runtime = undefined; storage = undefined;
  rmSync(path, { recursive: true, force: true }); mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, 'frames.bin'), Buffer.alloc(0)); writeFileSync(join(path, 'checkpoints.bin'), Buffer.alloc(0));
  const workerAuthority = authority!;
  const reopened = withStorageReservationAuthority(workerAuthority, () => openSustainableRso5Arena({ authority: workerAuthority,
    manifest: runtimeConfig.manifest, owner, copy: 0, key: bytes(runtimeConfig.encryptionKey), mode: 'existing' }));
  cleanups.push(() => reopened.close());
  storage = openSustainableRso5ProtectedArena({ arena: reopened, scope, signingKey: runtimeKey, recipientKey,
    replicas: runtimeConfig.replicaPublicKeys, transport: transportFor(replicaTargets) });
  storage.configureOriginal({ genesis: journal.state.originalGenesis, configuration: admissionWitnessSetId(journal.configuration),
    context: journal.state.context });
  runtimeConfig.configuration = journal.configuration;
  openRuntime();
  await diagnostic('runtime:local-C-recovery', async () => { await storage!.startup(false); await storage!.recoverSelected(journal.state.proofs, identities); });
  await diagnostic('runtime:local-C-recovery-startup', () => runtime!.startup());
  return { role, recoveredProofs: journal.state.proofs.length };
}
function metrics(final = false) {
  const cpu = process.cpuUsage(startedCpu);
  let arena: unknown = null;
  try { arena = withDiagnosticUnboundedRecoveryWork(() => replicaArena?.usage() ?? storage?.arena.usage()); } catch { arena = { status: 'closed' }; }
  return { role, labId, pid: process.pid, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt,
    cpu: { userMicros: cpu.user, systemMicros: cpu.system }, memory: process.memoryUsage(), lifecycle,
    work: { usedBytes: totalWorkBytes, operationCount, operations }, traffic: final ? labTrafficSince(metricsCheckpoint) : [],
    trafficCheckpoint: metricsCheckpoint, arena, stopping };
}
function authorize(sender: string, purpose: string, payload: any): void {
  if (sender === 'coordinator') {
    if (['setup', 'metrics', 'traffic-page', 'stop', 'arena-usage'].includes(purpose)) return;
    if (role.startsWith('runtime-') && purpose.startsWith('runtime:')) return;
    if (role.startsWith('observer-') && ['observer:drain', 'observer:advance'].includes(purpose)) return;
    if (role.startsWith('replica-') && purpose.startsWith('rso5:') && payload?.action === 'status') return;
    throw new Error(`Unauthorized coordinator method for ${role}: ${purpose}`);
  }
  if (role.startsWith('replica-')) {
    const match = /^replica-((?:old|new)-\d+)-\d+$/.exec(role), expected = match ? `runtime-${match[1]}` : '';
    const actions = ['preflight', 'put-frame', 'put-delegation', 'prepare-checkpoint', 'commit-checkpoint', 'status',
      'read-frame', 'read-delegation', 'read-checkpoint', 'list-delegations', 'list-checkpoints', 'state', 'head'];
    if (sender === expected && purpose === `rso5:${payload?.action}` && actions.includes(payload?.action)) return;
    throw new Error('Unauthorized replica sender or privileged method');
  }
  if (role.startsWith('observer-') && /^runtime-(old|new)-\d+$/.test(sender) && purpose === 'observer:observe') return;
  throw new Error(`Unauthorized sender/method for ${role}: ${sender} ${purpose}`);
}
async function invoke(purpose: string, payload: any, sender: string): Promise<unknown> {
  authorize(sender, purpose, payload);
  if (purpose === 'setup') {
    if (role.startsWith('runtime-')) return setupRuntime(payload);
    if (role.startsWith('replica-')) return setupReplica(payload);
    if (role.startsWith('observer-')) return setupObserver(payload);
    throw new Error('Unknown laboratory worker kind');
  }
  if (purpose === 'metrics') { metricsCheckpoint = labTrafficCount(); return metrics(); }
  if (purpose === 'traffic-page') {
    const offset = payload?.offset ?? 0, limit = payload?.limit ?? 500;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset < 0 || limit < 1 || limit > 1000) throw new Error('Invalid traffic page');
    return { offset, limit, ...labTrafficPage(offset, limit) };
  }
  if (purpose === 'stop') {
    stopping = true; lifecycle.push({ event: 'stop-requested', at: new Date().toISOString() });
    setTimeout(() => { void shutdown(); }, 500);
    return { role, stopping: true };
  }
  if (purpose.startsWith('rso5:')) {
    if (!replica) throw new Error('Laboratory replica not ready');
    privateFields(payload); return diagnostic(`replica:${payload.action}`, () => replica!.exchange(payload));
  }
  if (purpose === 'arena-usage') return replicaArena?.usage() ?? storage?.arena.usage();
  if (purpose === 'observer:observe') return withStorageReservationAuthority(authority!, () => diagnostic('observer:observe', () => legacy(() => observer!.observe(payload))));
  if (purpose === 'observer:drain') return withStorageReservationAuthority(authority!, () => diagnostic('observer:drain', () => legacy(() => observer!.drainWitnessHandoff(payload))));
  if (purpose === 'observer:advance') return withStorageReservationAuthority(authority!, () => diagnostic('observer:advance', () => legacy(() => observer!.advance(payload))));
  if (purpose === 'runtime:set-head') { currentHead = payload; return { role }; }
  if (purpose === 'runtime:bootstrap') {
    const capability = await diagnostic('runtime:legacy-prepare', () => prepareSustainableRecoveryBootstrap({ manifest: runtimeConfig.manifest,
      proposal: runtimeConfig.proposal, originals: runtimeConfig.originals, pins: runtimeConfig.pins, genesis: runtimeConfig.genesis }));
    await diagnostic('runtime:bootstrap', () => runtime!.bootstrap(capability)); return { role };
  }
  if (purpose === 'runtime:local-recovery') return localRecovery();
  if (purpose === 'runtime:read-references') {
    const journal = runtime!.read(); return { journal, references: storage!.references(journal.state.proofs) };
  }
  if (!runtime) throw new Error('Laboratory runtime not ready');
  if (purpose === 'runtime:read') return diagnostic('runtime:read', () => runtime!.read());
  if (purpose === 'runtime:startup') return diagnostic('runtime:startup', () => runtime!.startup());
  if (purpose === 'runtime:propose') return diagnostic('runtime:propose', () => runtime!.propose(payload));
  if (purpose === 'runtime:prepare') return diagnostic('runtime:prepare', () => runtime!.prepare(payload));
  if (purpose === 'runtime:commit') return diagnostic('runtime:commit', () => runtime!.commit(payload));
  if (purpose === 'runtime:execute') return diagnostic('runtime:execute', () => runtime!.execute(payload));
  if (purpose === 'runtime:finish') return diagnostic('runtime:finish', () => runtime!.finish(payload ?? undefined));
  if (purpose === 'runtime:retry') return diagnostic('runtime:retry', () => runtime!.retry(payload));
  if (purpose === 'runtime:viewChange') return diagnostic('runtime:viewChange', () => runtime!.viewChange(payload));
  if (purpose === 'runtime:newView') return diagnostic('runtime:newView', () => runtime!.newView(payload.records, payload.transfer));
  if (purpose === 'runtime:recipientEnrollment') return runtime!.recipientEnrollment(payload);
  if (purpose === 'runtime:transfer') return diagnostic('runtime:transfer', () => runtime!.transfer(payload.proposal, payload.enrollment));
  if (purpose === 'runtime:reserveInstall') return diagnostic('runtime:reserveInstall', () => runtime!.reserveInstall(payload.transfer, payload.proposal));
  if (purpose === 'runtime:prepareInstall') return diagnostic('runtime:prepareInstall', () => runtime!.prepareInstall(payload.transfer, payload.proposal, payload.drained));
  if (purpose === 'runtime:install') return diagnostic('runtime:install', () => runtime!.install(payload.transfer, payload.activation, payload.policy));
  if (purpose === 'runtime:freeze') return diagnostic('runtime:freeze', () => runtime!.freeze(payload));
  throw new Error(`Unknown laboratory purpose: ${purpose}`);
}
async function shutdown() {
  lifecycle.push({ event: 'stopped', at: new Date().toISOString() });
  const finalMetrics = metrics(true);
  const finish = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch { /* Continue stopping every laboratory role. */ }
    }
    for (const listener of listeners.splice(0).reverse()) await listener.close();
    process.exit(0);
  };
  if (process.send) process.send({ type: 'final-metrics', metrics: finalMetrics }, () => { void finish(); });
  else await finish();
}
const control = await listenLabWorker({ role, secret: (sender, purpose) => {
  if (sender === 'coordinator') return controlSecret;
  if (role.startsWith('replica-')) {
    const match = /^replica-((?:old|new)-\d+)-\d+$/.exec(role);
    if (match && sender === `runtime-${match[1]}` && purpose.startsWith('rso5:')) return replicaChannelSecret;
  }
  if (role.startsWith('observer-') && purpose === 'observer:observe') return observerChannelSecrets[sender] ?? deniedSecret;
  return deniedSecret;
}, handler: invoke });
listeners.push(control);
process.send?.({ type: 'listening', role, endpoint: control.endpoint });
process.on('uncaughtException', error => {
  console.error(`Laboratory uncaught exception ${role}: ${error.message.slice(0, 256)}`);
  process.send?.({ type: 'fatal', role, error: error.message.slice(0, 256) });
  void shutdown();
});
process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`Laboratory unhandled rejection ${role}: ${message.slice(0, 256)}`);
  process.send?.({ type: 'fatal', role, error: message.slice(0, 256) });
  void shutdown();
});
process.on('SIGTERM', () => console.error(`Laboratory SIGTERM ${role}`));
process.on('exit', code => console.error(`Laboratory exit ${role} ${code}`));
