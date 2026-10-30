import { fork, execFile, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { generateSigningKeyPair, verify, withAdmissionReplayValues, type SigningKeyPair } from '@resonance/core';
import type { AdmissionWorkMeter } from '@resonance/core/admission-work';
import { signAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionWitnessRequest, createAdmissionWitnessVote, admissionWitnessSetId, type AdmissionSpendClaim } from '@resonance/core/admission-witness';
import { createWitnessHandoffActivation, createWitnessHandoffProposal } from '@resonance/core/admission-witness-handoff';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { recoveryDigest, type Rso5Transport } from './sustainable-rso5-protected-arena.js';
import { recoveryNewViewProposal, recoveryHeaderBytes, type RecoveryBusinessCommand, type RecoveryCertificate, type RecoveryTransfer } from './sustainable-rso5-runtime.js';
import { preflightRso5Manifest } from './sustainable-rso5-manifest.js';
import { freezeProtectedWitness, prepareTerminalProtectedWitness } from './protected-witness-handoff.js';
import { callLabWorker, clearLabTrafficForTests, labTrafficSnapshot, type LabEndpoint, type LabTrafficRecord } from './sustainable-rso5-lab-transport.js';
import { chargeSustainableRecoveryWork, sustainableRecoveryBytes, sustainableRecoveryConcat, sustainableRecoveryJson, sustainableRecoveryWorkUsage, withDiagnosticUnboundedRecoveryWork } from './sustainable-recovery-work.js';
import { sustainableLegacyFixture, declareSustainableOriginals, finiteRecoveryManifest } from './__tests__/sustainable-recovery-fixture.js';

const executeFile = promisify(execFile);
const pub = (key: SigningKeyPair) => Buffer.from(key.publicKey).toString('base64url');
const keyPayload = (key: SigningKeyPair) => ({ publicKey: pub(key), secretKey: Buffer.from(key.secretKey).toString('base64url') });
const legacyWork: AdmissionWorkMeter = { charge: (bytes, mechanism) => chargeSustainableRecoveryWork(bytes, 'J', mechanism) };
function legacy<T>(work: () => Promise<T> | T): Promise<T> {
  return withDiagnosticUnboundedRecoveryWork(() => withAdmissionReplayValues({ charge: bytes => chargeSustainableRecoveryWork(bytes, 'J', 'legacy'), check: () => {} }, async () => work()));
}

interface Worker {
  role: string;
  child: ChildProcess;
  target: LabEndpoint;
  directory: string;
  metrics?: any;
  finalMetrics?: any;
  exitCode?: number | null;
  exitSignal?: string | null;
  peakRssBytes: number;
  childProcessIds: Set<number>;
  startupStderr: string;
  metricsError?: string;
  stopped: boolean;
}

export type IndependentLabScenario = 'full-smoke' | 'cold' | 'returning' | 'local-loss' | 'new-view';
export interface IndependentLabSmokeResult {
  runId: string;
  scenario: IndependentLabScenario;
  outcome: 'passed';
  workerCount: number;
  runtimeCount: number;
  replicaCount: number;
  observerCount: number;
  cleanStops: number;
  logicalCopyAudits: number;
  recoveredProofs: number;
  trafficMessages: number;
  trafficFrameBytes: number;
  exactTrafficAccounting: boolean;
  privateLeakageDetected: boolean;
  artifacts: string[];
}

export interface IndependentLabWindow {
  runId: string;
  seed: string;
  kind: 'idle' | 'sustained';
  durationMs: number;
  warmupMs: number;
  cooldownMs: number;
}

export async function runIndependentRso5LabSmoke(options: { runId: string; seed: string; scenario?: IndependentLabScenario; manifestPath?: string; window?: IndependentLabWindow }): Promise<IndependentLabSmokeResult> {
  const { runId, seed, scenario = 'full-smoke', window } = options;
  if (typeof runId !== 'string' || typeof seed !== 'string' || !/^[a-z][a-z0-9-]+$/.test(runId) || !/^0x[0-9A-Fa-f]+$/.test(seed)) throw new Error('Invalid laboratory run identity or seed');
  const manifestPath = options.manifestPath ?? `delivery/results/econ-lab-manifest-${runId}.json`;
  if (!existsSync(manifestPath)) throw new Error(`Frozen laboratory manifest missing: ${manifestPath}`);
  if (window && (scenario !== 'full-smoke' || ![window.durationMs, window.warmupMs, window.cooldownMs].every(value => Number.isSafeInteger(value) && value >= 0))) {
    throw new Error('Baseline window requires full-smoke scenario and nonnegative durations');
  }
  const artifactNames = ['lab-summary', 'process', 'disk', 'network', 'work', 'cleanup', 'authorization', 'owner-assumptions', 'decision', 'power', 'new-view-readiness']
    .map(name => `delivery/results/econ-${name}-${runId}.json`);
  artifactNames.push(`delivery/results/econ-power-${runId}.csv`);
  const existingArtifacts = artifactNames.filter(path => existsSync(path));
  if (existingArtifacts.length) throw new Error(`Laboratory artifacts already exist: ${existingArtifacts.join(', ')}`);
  const windowPhases: Array<{ phase: string; at: string }> = [];
  const markPhase = (phase: string) => windowPhases.push({ phase, at: new Date().toISOString() });
  const sustainedOperations = { reads: 0, retries: 0 };
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  clearLabTrafficForTests();
  const labId = `rso5-lab-${runId}`;
  const labRootSecret = createHmac('sha256', 'rso5-independent-lab-root-v1').update(`${runId}\n${seed}`).digest();
  const credential = (sender: string, recipient: string, channel: string) => createHmac('sha256', labRootSecret)
    .update(`${runId}\n${sender}\n${recipient}\n${channel}`).digest('base64url');
  const controlCredential = (recipient: string) => credential('coordinator', recipient, 'control');
  const root = mkdtempSync(join(tmpdir(), `rso5-independent-lab-${runId}-`)), workers = new Map<string, Worker>();
  const artifacts: string[] = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  const writeJson = (name: string, value: unknown) => {
    const path = join('delivery/results', name); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); artifacts.push(path);
  };
  const call = async <T>(role: string, purpose: string, payload?: unknown, timeoutMs?: number): Promise<T> => {
    const worker = workers.get(role); if (!worker || worker.stopped) throw new Error(`Laboratory worker unavailable: ${role}`);
    try { return await callLabWorker({ sender: 'coordinator', target: worker.target, secret: controlCredential(role), purpose, payload, timeoutMs }); }
    catch (error) {
      const detail = worker.startupStderr.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(-1024);
      throw new Error(`${role} ${purpose}: ${error instanceof Error ? error.message : String(error)} ${detail}`);
    }
  };
  async function readWorkerTraffic(worker: Worker): Promise<LabTrafficRecord[]> {
    const records: LabTrafficRecord[] = [];
    for (let offset = 0; ;) {
      const page = await callLabWorker<{ total: number; records: LabTrafficRecord[] }>({ sender: 'coordinator', target: worker.target,
        secret: controlCredential(worker.role), purpose: 'traffic-page', payload: { offset, limit: 500 } });
      records.push(...page.records); offset = records.length;
      if (offset >= page.total) return records;
    }
  }
  const sample = async () => {
    try {
      const { stdout } = await executeFile('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 5000, maxBuffer: 4 * 1024 ** 2 });
      const rows = new Map<number, { ppid: number; rss: number }>();
      for (const line of stdout.trim().split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line); if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), rss: Number(match[3]) * 1024 });
      }
      for (const worker of workers.values()) {
        const pid = worker.child.pid!, row = rows.get(pid); if (!row) continue;
        const descendants = new Set<number>(), queue = [pid];
        while (queue.length) {
          const parent = queue.shift()!;
          for (const [candidatePid, candidate] of rows) if (candidate.ppid === parent && !descendants.has(candidatePid)) {
            descendants.add(candidatePid); queue.push(candidatePid);
          }
        }
        worker.childProcessIds = descendants;
        const treeRss = row.rss + [...descendants].reduce((sum, childPid) => sum + (rows.get(childPid)?.rss ?? 0), 0);
        worker.peakRssBytes = Math.max(worker.peakRssBytes, treeRss);
      }
    } catch { /* The final artifact records that host sampling was best effort. */ }
  };
  async function startWorker(role: string): Promise<Worker> {
    const directory = join(root, role); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const replicaMatch = /^replica-((?:old|new)-\d+)-\d+$/.exec(role), owningRuntime = replicaMatch ? `runtime-${replicaMatch[1]}` : '';
    const observerCredentials = role.startsWith('observer-') ? Object.fromEntries(['old', 'new'].flatMap(side => Array.from({ length: 4 }, (_, index) => {
      const runtime = `runtime-${side}-${index}`; return [runtime, credential(runtime, role, 'observer:observe')];
    }))) : {};
    const child = fork(join(process.cwd(), 'packages/relay/src/sustainable-rso5-lab-worker.ts'), [], {
      cwd: process.cwd(), execArgv: ['--import', 'tsx'], silent: true,
      env: { ...process.env, RSO5_LAB_WORKER: role, RSO5_LAB_ID: labId,
        RSO5_LAB_CONTROL_CREDENTIAL: controlCredential(role),
        RSO5_LAB_REPLICA_CREDENTIAL: owningRuntime ? credential(owningRuntime, role, 'rso5') : '',
        RSO5_LAB_OBSERVER_CREDENTIALS: JSON.stringify(observerCredentials) },
    });
    const worker: Worker = { role, child, target: { role, endpoint: '' }, directory, peakRssBytes: 0, childProcessIds: new Set(), startupStderr: '', stopped: false };
    workers.set(role, worker);
    child.on('message', (message: any) => {
      if (message?.type === 'final-metrics') worker.finalMetrics = message.metrics;
      if (message?.type === 'fatal') console.error(`Laboratory worker ${role} refused: ${String(message.error).slice(0, 128)}`);
    });
    child.once('exit', (code, signal) => {
      worker.exitCode = code; worker.exitSignal = signal;
      console.error(`Laboratory worker exit ${role}: code=${code} signal=${signal}`);
    });
    child.stderr?.on('data', data => { worker.startupStderr = `${worker.startupStderr}${String(data)}`.slice(-2048); });
    child.stdout?.on('data', () => {});
    const endpoint = await new Promise<string>((resolve, reject) => {
      const onMessage = (message: any) => {
        if (message?.type === 'listening' && message.role === role) { cleanup(); resolve(message.endpoint); }
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onExit = (code: number | null) => {
        const detail = worker.startupStderr.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(-1024);
        cleanup(); reject(new Error(`Laboratory worker exited during start: ${role} (${code}) ${detail}`));
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Laboratory worker start timed out: ${role}`)); }, 30_000);
      const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('error', onError); child.off('exit', onExit); };
      child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit);
    });
    worker.target = { role, endpoint }; await sample(); return worker;
  }
  async function waitForExit(worker: Worker, timeoutMs: number): Promise<boolean> {
    if (worker.exitCode !== undefined && worker.exitCode !== null) return true;
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { worker.child.off('exit', exited); resolve(false); }, timeoutMs);
      const exited = () => { clearTimeout(timer); resolve(true); };
      worker.child.once('exit', exited);
    });
  }
  async function stopWorker(worker: Worker): Promise<void> {
    if (worker.stopped) return;
    if (worker.exitCode === undefined || worker.exitCode === null) {
      try {
        if (!worker.metrics) worker.metrics = await callLabWorker({ sender: 'coordinator', target: worker.target,
          secret: controlCredential(worker.role), purpose: 'metrics', timeoutMs: 10_000 });
        worker.metrics.traffic = await readWorkerTraffic(worker);
        await callLabWorker({ sender: 'coordinator', target: worker.target, secret: controlCredential(worker.role), purpose: 'stop', timeoutMs: 10_000 });
      } catch (error) {
        worker.metricsError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    if (!await waitForExit(worker, 15_000)) {
      worker.child.kill('SIGTERM');
      if (!await waitForExit(worker, 2_000)) {
        worker.child.kill('SIGKILL');
        if (!await waitForExit(worker, 5_000)) throw new Error(`Laboratory worker survived SIGKILL: ${worker.role}`);
      }
    }
    worker.stopped = true;
  }
  async function stopAll(): Promise<number> {
    let clean = 0;
    for (const worker of [...workers.values()].reverse()) {
      if (!worker.stopped) await stopWorker(worker);
      if (worker.exitCode === 0) clean++;
    }
    return clean;
  }
  try {
    sampler = setInterval(() => { void sample(); }, 500);
    const fixture = await sustainableLegacyFixture(8, window ? { keyLifetimeMs: 3_600_000, policyLifetimeMs: 7_200_000 } : undefined);
    return await fixture.run(async () => {
      const manifest = finiteRecoveryManifest(join(fixture.directory, 'rso5-independent-arenas'));
      preflightRso5Manifest(fixture.funding, manifest, 'new');
      const originals = fixture.actors.slice(0, 4), cohort = fixture.actors.slice(4, 8), accepted = fixture.row();
      await originals[0].history.write(accepted);
      const claim: AdmissionSpendClaim = { setId: admissionWitnessSetId(fixture.proposal.oldSet), issuerKey: fixture.policy.activeKey,
        spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: `admreq_${'p'.repeat(86)}` };
      const votes = await Promise.all(originals.map(actor => withDiagnosticUnboundedRecoveryWork(() => createAdmissionWitnessVote(claim, actor.key, legacyWork))));
      const retainedVotes = await Promise.all(votes.map((vote, index) => index === 3
        ? withDiagnosticUnboundedRecoveryWork(() => createAdmissionWitnessVote({ ...claim, requestBinding: `admreq_${'q'.repeat(86)}` }, originals[index].key, legacyWork)) : vote));
      for (let index = 0; index < 4; index++) await originals[index].history.writeRoleDecision({ kind: 'witness-vote', vote: retainedVotes[index] });
      for (const actor of originals) await freezeProtectedWitness(actor.history, fixture.proposal, actor.key, actor.encryptionKey);
      const pins = originals.map(actor => ({ context: actor.context, genesisId: historyCheckpointEnvelopeId(actor.root),
        rootId: historyCheckpointEnvelopeId(actor.history.read().root), generation: 0, nextGeneration: 1, head: { ...actor.history.read().applied! } }));
      const pairs = [];
      for (const actor of originals) pairs.push(await prepareTerminalProtectedWitness(actor.history, fixture.proposal, { mode: 'create-new', nextGeneration: 1 }));
      declareSustainableOriginals(manifest, pairs, fixture.policy, retainedVotes);

      const observerRoles = Array.from({ length: 4 }, (_, index) => `observer-${index}`);
      for (const role of observerRoles) await startWorker(role);
      for (let index = 0; index < observerRoles.length; index++) {
        const role = observerRoles[index], worker = workers.get(role)!;
        await call(role, 'setup', { workerDirectory: worker.directory, observerContext: fixture.observerContext,
          signingKey: keyPayload(fixture.observerKeys[index]), historyKeys: fixture.observerKeys.map(keyPayload),
          historyCredentials: Array.from({ length: 5 }, (_, historyIndex) => credential(role, `${role}-history-${historyIndex}`, 'observer-history')),
          encryptionKey: randomBytes(32).toString('base64url'), policy: fixture.policy });
      }
      const observerEndpoints = observerRoles.map(role => workers.get(role)!.target);

      interface NodeSetup { side: 'old' | 'new'; index: number; actor: (typeof fixture.actors)[number]; owner: string; scope: string; runtimeRole: string; replicaRoles: string[]; replicaPublicKeys: string[] }
      const setups: NodeSetup[] = [];
      for (const [side, actors] of [['old', originals], ['new', cohort]] as const) {
        for (let index = 0; index < 4; index++) {
          const actor = actors[index], ownerIndex = side === 'old' ? index : index + 5, runtimeRole = `runtime-${side}-${index}`;
          setups.push({ side, index, actor, owner: `witness-${ownerIndex}`, scope: recoveryDigest(Buffer.from(`rso5-witness:${pub(actor.key)}`)),
            runtimeRole, replicaRoles: Array.from({ length: 5 }, (_, copy) => `replica-${side}-${index}-${copy + 1}`), replicaPublicKeys: [] });
        }
      }
      for (const role of setups.flatMap(setup => setup.replicaRoles)) await startWorker(role);
      for (const setup of setups) await startWorker(setup.runtimeRole);
      for (const setup of setups) {
        const storageKeys = Array.from({ length: 5 }, generateSigningKeyPair); setup.replicaPublicKeys = storageKeys.map(pub);
        for (let copy = 0; copy < 5; copy++) {
          const role = setup.replicaRoles[copy], worker = workers.get(role)!;
          await call(role, 'setup', { workerDirectory: worker.directory, manifest, owner: setup.owner, copy: copy + 1,
            encryptionKey: randomBytes(32).toString('base64url'), signingKey: keyPayload(storageKeys[copy]), scope: setup.scope, ownerPublicKey: pub(setup.actor.key) });
        }
        const worker = workers.get(setup.runtimeRole)!;
        await call(setup.runtimeRole, 'setup', { workerDirectory: worker.directory, manifest, owner: setup.owner,
          encryptionKey: Buffer.from(setup.actor.encryptionKey).toString('base64url'), actorKey: keyPayload(setup.actor.key), scope: setup.scope,
          replicaPublicKeys: setup.replicaPublicKeys,
          replicaEndpoints: setup.replicaRoles.map((role, index) => ({ ...workers.get(role)!.target, publicKey: setup.replicaPublicKeys[index],
            credential: credential(setup.runtimeRole, role, 'rso5') })),
          observerContext: fixture.observerContext,
          observerEndpoints: observerEndpoints.map(target => ({ ...target, credential: credential(setup.runtimeRole, target.role, 'observer:observe') })),
          originals: pairs, pins, proposal: fixture.proposal,
          genesis: fixture.policy, configuration: sideConfiguration(setup.side, fixture.proposal.oldSet, fixture.proposal.newSet),
          returningConfiguration: fixture.proposal.oldSet });
      }
      const oldRoles = setups.filter(setup => setup.side === 'old').map(setup => setup.runtimeRole);
      const newRoles = setups.filter(setup => setup.side === 'new').map(setup => setup.runtimeRole);
      const forgedTarget = 'replica-old-1-1';
      await assert.rejects(callLabWorker({ sender: 'runtime-old-0', target: workers.get(forgedTarget)!.target,
        secret: credential('runtime-old-0', forgedTarget, 'rso5'), purpose: 'rso5:status', expectRefusal: true,
        payload: { action: 'status', scope: setups[0].scope, challenge: randomBytes(32).toString('base64url') } }), /refused|closed/i);
      await assert.rejects(call(forgedTarget, 'runtime:read'), /refused|unauthorized/i);
      writeJson(`econ-authorization-${runId}.json`, { schema_version: 1, run_id: runId,
        forged_cross_runtime_role_refused: true, privileged_replica_runtime_read_refused: true,
        credentials: 'per-run/per-sender/per-recipient/per-channel', method_authorization: 'explicit' });
      const newViewReadiness: Array<{ view: number; readiness: Array<{ role: string; sequence: number; digest: string }> }> = [];
      let recoveredProofs = 0;
      if (window?.kind === 'idle') {
        markPhase('warmup'); await wait(window.warmupMs);
        markPhase('baseline'); await wait(window.durationMs);
        markPhase('cooldown'); await wait(window.cooldownMs);
      } else {
      if (window) markPhase('warmup');
      for (const role of oldRoles) await call(role, 'runtime:bootstrap', undefined, 240_000);

      async function read(role: string) { return call<any>(role, 'runtime:read'); }
      async function execute(roles: string[], command: RecoveryBusinessCommand) {
        const actorSetups = roles === oldRoles ? setups.filter(setup => setup.side === 'old') : setups.filter(setup => setup.side === 'new');
        const journal = await read(roles[0]), members = journal.configuration.members;
        const leader = roles.find((role, index) => members[journal.view % 5].publicKey === pub(actorSetups[index].actor.key));
        assert(leader, 'Laboratory deterministic leader missing');
        const proposal = await call<any>(leader, 'runtime:propose', command);
        const prepares = await Promise.all(roles.map(role => call<any>(role, 'runtime:prepare', proposal)));
        const prepared: RecoveryCertificate = { phase: 'prepare', header: proposal.header, signatures: prepares };
        const commits = await Promise.all(roles.map(role => call<any>(role, 'runtime:commit', prepared)));
        const committed: RecoveryCertificate = { phase: 'commit', header: proposal.header, signatures: commits };
        const done = await Promise.all(roles.map(role => call<any>(role, 'runtime:execute', committed)));
        const cut = command.kind === 'cut' ? { phase: 'cut' as const, header: proposal.header, signatures: done } : undefined;
        await Promise.all(roles.map(role => call(role, 'runtime:finish', cut))); return cut;
      }
      async function newView(roles: string[], view: number) {
        const records = await Promise.all(roles.map(role => call<any>(role, 'runtime:viewChange', view)));
        const cut = (await read(roles[0])).stable, proposal = withDiagnosticUnboundedRecoveryWork(() => recoveryNewViewProposal(records, cut)), snapshots: RecoveryTransfer[] = [];
        for (const role of roles) {
          const enrollment = await call<any>(role, 'runtime:recipientEnrollment', cut);
          snapshots.push(await call<RecoveryTransfer>(roles[0], 'runtime:transfer', { proposal, enrollment }));
        }
        await Promise.all(roles.map((role, index) => call(role, 'runtime:newView', { records, transfer: snapshots[index] })));
        const readiness: Array<{ role: string; sequence: number; digest: string }> = [];
        for (const role of roles) readiness.push({ role, ...(await call<any>(role, 'runtime:startup', undefined, 120_000)) });
        newViewReadiness.push({ view, readiness });
      }
      async function setHead(head: any) {
        await Promise.all([...oldRoles, ...newRoles].filter(role => !workers.get(role)!.stopped).map(role => call(role, 'runtime:set-head', head)));
      }
      async function transfer(from: string[], to: string[], proposal: any, current: SignedAdmissionPolicy, revision: number) {
        const cut = (await read(from[0])).stable, snapshots: RecoveryTransfer[] = [];
        for (const role of to) {
          const enrollment = await call<any>(role, 'runtime:recipientEnrollment', cut);
          snapshots.push(await call<RecoveryTransfer>(from[0], 'runtime:transfer', { proposal, enrollment }));
        }
        await assert.rejects(call(from[0], 'runtime:freeze', []), /refused|reservations/i);
        const reservations = await Promise.all(to.map((role, index) => call<any>(role, 'runtime:reserveInstall', { transfer: snapshots[index], proposal }, 240_000)));
        const freezes = await Promise.all(from.map(role => call<any>(role, 'runtime:freeze', reservations)));
        const cutId = recoveryDigest(recoveryHeaderBytes(snapshots[0].cut.header));
        const seal = { version: 1 as const, proposal, manifest: cutId, freezes, activation: null };
        const drained = await Promise.all(observerRoles.map(role => call<any>(role, 'observer:drain', seal)));
        const ready = await Promise.all(to.map((role, index) => call<any>(role, 'runtime:prepareInstall', { transfer: snapshots[index], proposal, drained })));
        const activation = await legacy(() => createWitnessHandoffActivation({ proposal, manifest: cutId, freezes, drained, ready }, fixture.authorityKey, legacyWork));
        const { authority, signature, ...body } = current;
        const policy = await legacy(() => signAdmissionPolicy({ ...body, revision,
          keys: body.keys.map(key => ({ ...key, witnesses: proposal.newSet, witnessHandoff: activation })) }, authority, fixture.authorityKey.secretKey, legacyWork));
        const advance = await legacy(() => createAdmissionPolicyAdvance(current, policy, fixture.observerContext, fixture.authorityKey, proposal.previous, legacyWork));
        await Promise.all(observerRoles.map(role => call(role, 'observer:advance', advance))); await setHead(advance.commitment.next);
        await Promise.all(to.map((role, index) => call(role, 'runtime:install', { transfer: snapshots[index], activation, policy }, 240_000)));
        for (const role of to) await call(role, 'runtime:startup', undefined, 120_000);
        return { policy, advance };
      }

      await execute(oldRoles, { kind: 'cut' }); for (const role of oldRoles) await call(role, 'runtime:startup');
      const request = await legacy(() => createAdmissionWitnessRequest({ ...claim, spend: accepted.spend, action: 'search', requestBinding: accepted.binding }, fixture.coordinator, legacyWork));
      let sustainedRetry: any, sustainedResolved: any;
      assert.deepEqual(await call(oldRoles[0], 'runtime:retry', request), { owner: pub(originals[0].key), ...accepted });
      if (['full-smoke', 'local-loss', 'new-view'].includes(scenario)) await newView(oldRoles, 1);
      if (scenario !== 'new-view') {
        await execute(oldRoles, { kind: 'reconfigure', proposal: fixture.proposal }); await execute(oldRoles, { kind: 'cut' });
        const first = await transfer(oldRoles, newRoles, fixture.proposal, fixture.policy, 2);
        if (scenario !== 'cold') {
          const retryNew = await legacy(() => createAdmissionWitnessRequest({ ...request, setId: admissionWitnessSetId(fixture.proposal.newSet) }, fixture.coordinator, legacyWork));
          const predecessorAccepted = (await read(oldRoles[0])).state.evidence.accepted[0];
          assert.deepEqual(await call(newRoles[0], 'runtime:retry', retryNew), predecessorAccepted);
          const unresolved = await legacy(() => createAdmissionWitnessRequest({ ...claim, setId: admissionWitnessSetId(fixture.proposal.newSet) }, fixture.coordinator, legacyWork));
          await assert.rejects(call(newRoles[0], 'runtime:retry', unresolved), /refused|uncertainty/i);
          await execute(newRoles, { kind: 'certificate', certificate: { version: 1, votes } });
          assert.equal(await call(newRoles[0], 'runtime:retry', unresolved), undefined);
          const returning = await legacy(() => createWitnessHandoffProposal({ ...fixture.proposal, id: randomBytes(32).toString('base64url'),
            previous: first.advance.commitment.next, oldSet: fixture.proposal.newSet,
            newSet: { ...fixture.proposal.oldSet, epoch: randomBytes(32).toString('base64url') } }, fixture.authorityKey, legacyWork));
          await execute(newRoles, { kind: 'reconfigure', proposal: returning }); await execute(newRoles, { kind: 'cut' });
          if (['full-smoke', 'local-loss'].includes(scenario)) await newView(newRoles, 1);
          await transfer(newRoles, oldRoles, returning, first.policy, 3);
          const retryReturned = await legacy(() => createAdmissionWitnessRequest({ ...request, setId: admissionWitnessSetId(returning.newSet) }, fixture.coordinator, legacyWork));
          assert.deepEqual(await call(oldRoles[0], 'runtime:retry', retryReturned), { owner: pub(originals[0].key), ...accepted });
          const denialRequest = await legacy(() => createAdmissionWitnessRequest({ ...claim, setId: admissionWitnessSetId(returning.newSet),
            requestBinding: `admreq_${'q'.repeat(86)}` }, fixture.coordinator, legacyWork));
          await assert.rejects(call(oldRoles[0], 'runtime:retry', denialRequest), /refused|denial/i);
          const conflictRequest = await legacy(() => createAdmissionWitnessRequest({ ...retryReturned, requestBinding: `admreq_${'z'.repeat(86)}` }, fixture.coordinator, legacyWork));
          await assert.rejects(call(oldRoles[0], 'runtime:retry', conflictRequest), /refused|conflict/i);
          sustainedRetry = retryReturned;
          sustainedResolved = await legacy(() => createAdmissionWitnessRequest({ ...unresolved, setId: admissionWitnessSetId(returning.newSet) }, fixture.coordinator, legacyWork));
          assert.equal(await call(oldRoles[0], 'runtime:retry', sustainedResolved), undefined);
        }
      }

      recoveredProofs = 0;
      if (['full-smoke', 'local-loss'].includes(scenario)) {
        for (const role of newRoles) {
          const setup = setups.find(candidate => candidate.runtimeRole === role)!;
          await stopWorker(workers.get(role)!);
          for (const replicaRole of setup.replicaRoles) await stopWorker(workers.get(replicaRole)!);
        }
        for (const role of oldRoles) {
          const result = await call<any>(role, 'runtime:local-recovery', undefined, 240_000); recoveredProofs += result.recoveredProofs;
        }
      }
      if (window?.kind === 'sustained') {
        markPhase('baseline');
        const deadline = performance.now() + window.durationMs;
        while (performance.now() < deadline) {
          for (const role of oldRoles) {
            await call(role, 'runtime:read'); sustainedOperations.reads++;
            await call(role, 'runtime:retry', sustainedRetry); sustainedOperations.retries++;
            await call(role, 'runtime:retry', sustainedResolved); sustainedOperations.retries++;
          }
          await wait(100);
        }
        markPhase('cooldown'); await wait(window.cooldownMs);
      }
      }
      let logicalCopyAudits = 0;
      const auditSide = window?.kind === 'idle' ? '' : scenario === 'cold' ? 'new' : 'old';
      for (const setup of setups.filter(candidate => candidate.side === auditSide)) {
        const { references } = await call<any>(setup.runtimeRole, 'runtime:read-references');
        for (const identity of references) {
          const matching = await Promise.all(setup.replicaRoles.map(async (replicaRole, replicaIndex) => {
            const request = { action: 'status', scope: setup.scope, challenge: randomBytes(32).toString('base64url'), identity };
            const reply = await callLabWorker<any>({ sender: 'coordinator', target: workers.get(replicaRole)!.target,
              secret: controlCredential(replicaRole), purpose: 'rso5:status-audit', payload: request });
            verifyRso5AuditReply(reply, request, setup.replicaPublicKeys[replicaIndex]); return reply;
          }));
          assert(matching.filter(reply => reply.digest === identity.frameDigest && reply.bytes === identity.frameBytes).length >= 4,
            'Four logical process-held RSO5 copies unavailable during laboratory audit');
          logicalCopyAudits++;
        }
      }
      for (const worker of workers.values()) if (!worker.stopped) {
        worker.metrics = await call(worker.role, 'metrics'); worker.metrics.traffic = await readWorkerTraffic(worker);
      }
      const hostTools = await reconcileHostTools([...workers.values()].filter(worker => !worker.stopped));
      const cleanStops = await stopAll(); if (sampler) clearInterval(sampler);
      assert.equal(cleanStops, workers.size, 'Laboratory workers did not stop cleanly');
      const preTraffic = new Map([...workers.values()].map(worker => [worker.role, worker.metrics?.traffic ?? []]));
      const finalTraffic = [...labTrafficSnapshot()];
      for (const worker of workers.values()) finalTraffic.push(...(preTraffic.get(worker.role) ?? []), ...(worker.finalMetrics?.traffic ?? []));
      for (const worker of workers.values()) if (worker.finalMetrics) worker.metrics = worker.finalMetrics;
      const network = networkEvidence(mergeLabTraffic(finalTraffic));
      if (!network.reconciliation.exact) {
        writeJson(`econ-network-reconciliation-failure-${Date.now()}.json`, { run_id: runId, status: 'invalid', ...network,
          worker_traffic_counts: [...workers.values()].map(worker => ({ role: worker.role,
            pre_stop: preTraffic.get(worker.role)?.length ?? null, final: worker.finalMetrics?.traffic?.length ?? null,
            metrics_error: worker.metricsError ?? null })) });
        throw new Error(`Laboratory WebSocket accounting differs: sent=${network.reconciliation.sent_messages} received=${network.reconciliation.received_messages} missing=${network.reconciliation.missing_received.length} unexpected=${network.reconciliation.unexpected_received.length}`);
      }

      const processArtifact = {
        schema_version: 1, run_id: runId, authorization_id: 'DEC-008', status: 'complete', transport: 'independent-node-processes',
        window: window ? { ...window, phases: windowPhases, sustained_operations: sustainedOperations } : null,
        worker_count: workers.size, runtime_count: 8, replica_count: 40, observer_count: 4,
        roles: [...workers.values()].map(worker => ({ role: worker.role, pid: worker.child.pid, peak_tree_rss_bytes: worker.peakRssBytes,
          cpu: worker.metrics?.cpu, memory: worker.metrics?.memory, elapsed_ms: worker.metrics?.elapsedMs,
          lifecycle: [...(worker.metrics?.lifecycle ?? []), { event: 'exit', code: worker.exitCode }],
          child_processes: [...worker.childProcessIds], process_tree_observation: 'recursive ps parent-link enumeration' })),
        clean_stops: cleanStops, isolation_limitations: ['Same physical host; no whole-host isolation', 'Loopback IPC only', 'Peak RSS sampled with ps; shared-memory attribution unavailable'],
      };
      writeJson(`econ-process-${runId}.json`, processArtifact);
      writeJson(`econ-disk-${runId}.json`, {
        schema_version: 1, run_id: runId, status: 'partial',
        process_disk_counters: { status: 'unavailable', reason: 'Node.js/macOS per-process physical read/write counters are not exposed by this harness' },
        logical_arena_files: [...workers.values()].map(worker => ({ role: worker.role, usage: worker.metrics?.arena ?? null })),
        fsync_behavior: 'Existing RSO5/history fsync paths preserved; physical fsync latency not exposed',
        iostat: hostTools.iostat,
        limitations: ['Logical arena bytes are not physical disk I/O', 'iostat is whole-host and cannot be attributed to workers'],
      });
      writeJson(`econ-network-${runId}.json`, {
        schema_version: 1, run_id: runId, status: 'complete', scope: 'authenticated-websocket-loopback',
        internet_evidence: false, wifi_evidence: false, last_mile_evidence: false,
        ...network, nettop: hostTools.nettop,
        limitations: ['Application WebSocket payload/frame bytes only; handshake/control frames and TCP/IP bytes excluded', 'nettop is a separate host view and is not added to application counters', 'No external traffic'],
      });
      writeJson(`econ-power-${runId}.json`, { schema_version: 1, run_id: runId, status: 'blocked',
        reason: 'powermetrics requires superuser; no calibrated external AC meter authorized', samples: [], energy_joules: null, energy_kwh: null,
        limitations: ['No power samples collected', 'CPU/work bytes cannot be converted to energy'] });
      const csvPath = join('delivery/results', `econ-power-${runId}.csv`);
      writeFileSync(csvPath, 'status,reason\nblocked,"powermetrics requires superuser; no calibrated external AC meter authorized"\n', { mode: 0o600, flag: 'wx' }); artifacts.push(csvPath);
      writeJson(`econ-owner-assumptions-${runId}.json`, { schema_version: 1, run_id: runId, status: 'pending', currency: null, accounting_period: null,
        electricity_prices: null, network_prices: null, labor_prices: null, hardware_lifetime: null,
        recovery_arrival_rates: null, maximum_envelope_margin: null, budget: null, value: null, affordability_verdict: 'pending' });
      writeJson(`econ-decision-${runId}.json`, { schema_version: 1, run_id: runId, scenario,
        run_status: window ? 'baseline_window_complete' : scenario === 'full-smoke' ? 'diagnostic_reproduction_complete' : 'matrix_run_complete',
        E1: 'complete_for_local_planning_only',
        E2: 'blocked', E2_reasons: ['Aggregate matrix/window evidence incomplete', 'Physical power blocked'],
        E3: 'pending_separate_owner_authorization', D4: 'prototype-only', economic_affordability: 'pending', acceptance_evaluation: 'not_run' });

      const workBytes = [...workers.values()].reduce((sum, worker) => sum + (worker.metrics?.work?.usedBytes ?? 0), 0);
      writeJson(`econ-work-${runId}.json`, { schema_version: 1, run_id: runId, scenario,
        roles: [...workers.values()].map(worker => ({ role: worker.role, used_bytes: worker.metrics?.work?.usedBytes ?? 0,
          operation_count: worker.metrics?.work?.operationCount ?? 0, operations: worker.metrics?.work?.operations ?? [] })),
        total_work_bytes: workBytes, recompute_rule: 'sum roles.used_bytes; operations are retained per role for independent review' });
      if (newViewReadiness.length) writeJson(`econ-new-view-readiness-${runId}.json`, { schema_version: 1, run_id: runId,
        status: 'complete', post_new_view_startup_complete: true, durable_serving_readiness: true, groups: newViewReadiness });
      const artifactText = artifacts.filter(path => path.endsWith('.json')).map(path => readFileSync(path, 'utf8')).join('\n');
      const privateMarkers = [labRootSecret.toString('base64url'), ...setups.flatMap(setup => [pub(setup.actor.key), Buffer.from(setup.actor.key.secretKey).toString('base64url')]),
        accepted.spend, accepted.binding, claim.requestBinding];
      const privateLeakageDetected = privateMarkers.some(marker => marker.length > 8 && artifactText.includes(marker));
      assert.equal(privateLeakageDetected, false, 'Private marker reached laboratory artifacts');
      writeJson(`econ-lab-summary-${runId}.json`, { schema_version: 1, run_id: runId, scenario, outcome: 'passed', diagnostic_only: true,
        source_manifest: manifestPath, workers: workers.size, clean_stops: cleanStops,
        window: window ? { ...window, phases: windowPhases, sustained_operations: sustainedOperations } : null,
        predecessor_runtime_and_replicas_stopped_before_recovery: ['full-smoke', 'local-loss'].includes(scenario), recovered_proofs: recoveredProofs,
        post_new_view_startup_groups: newViewReadiness.length,
        post_new_view_durable_readiness: window?.kind === 'idle' ? null
          : newViewReadiness.every(group => group.readiness.every(result => Number.isSafeInteger(result.sequence) && typeof result.digest === 'string')),
        logical_process_held_copy_audits: logicalCopyAudits,
        copy_model: 'logical process-held copies; not physical devices or crash-durability proof',
        exact_traffic_accounting: network.reconciliation.exact,
        private_leakage_detected: privateLeakageDetected, work_bytes_separate_metric: workBytes,
        energy: 'blocked', network_scope: 'loopback_only', E2: 'blocked', acceptance_evaluation: 'not_run' });
      rmSync(root, { recursive: true, force: true });
      return { runId, scenario, outcome: 'passed', workerCount: workers.size, runtimeCount: 8, replicaCount: 40, observerCount: 4,
        cleanStops, logicalCopyAudits, recoveredProofs, trafficMessages: network.message_count,
        trafficFrameBytes: network.total_frame_bytes, exactTrafficAccounting: network.reconciliation.exact,
        privateLeakageDetected, artifacts };
    });
  } finally {
    if (sampler) clearInterval(sampler);
    for (const worker of [...workers.values()].reverse()) if (!worker.stopped) {
      try { await stopWorker(worker); }
      catch {
        worker.child.kill('SIGKILL');
        if (!await waitForExit(worker, 5_000)) throw new Error(`Laboratory worker survived final SIGKILL: ${worker.role}`);
        worker.stopped = true;
      }
    }
    const sweep = await sweepLabWorkerProcesses();
    writeJson(`econ-cleanup-${runId}.json`, { schema_version: 1, run_id: runId,
      graceful_or_escalated_stops: [...workers.values()].map(worker => ({ role: worker.role, exit_code: worker.exitCode })),
      exact_path_sweep: sweep, remaining_live_workers: sweep.remainingLivePids.length, acceptance_evaluation: 'not_run' });
    if (sweep.remainingLivePids.length) throw new Error('Laboratory exact-path sweep found surviving workers');
    rmSync(root, { recursive: true, force: true });
  }
}

export async function driveIndependentRso5Matrix(options: {
  manifestPath?: string;
  execute: boolean;
  independentReviewApproved?: boolean;
  executionAttempt?: number;
  startIndex?: number;
  identityPrefix?: string;
  onRunComplete?: (run: { runId: string; executionRunId: string; scenario: IndependentLabScenario; seed: string; orderIndex: number; executionManifestPath: string }) => void | Promise<void>;
}): Promise<Array<{ runId: string; scenario: IndependentLabScenario; seed: string; orderIndex: number; manifestPath: string; executionRunId: string; executionManifestPath: string; readiness: 'post-newView-startup' | 'installed'; status: 'selected' | 'completed' }>> {
  const manifestPath = options.manifestPath ?? 'delivery/results/econ-lab-manifest.json';
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const executionAttempt = options.executionAttempt ?? 0;
  if (!Number.isSafeInteger(executionAttempt) || executionAttempt < 0) throw new Error('Invalid matrix execution attempt');
  const startIndex = options.startIndex ?? 0;
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > 19) throw new Error('Invalid matrix start index');
  const identityPrefix = options.identityPrefix ?? 'matrix';
  if (!/^[a-z][a-z0-9-]+$/.test(identityPrefix)) throw new Error('Invalid matrix identity prefix');
  if (manifest.randomness?.source !== 'node:crypto.randomBytes' || manifest.randomness?.deterministic !== false
    || manifest.randomness?.exact_business_replay !== false || manifest.randomness?.discard_draws_forbidden !== true
    || manifest.analysis_freeze?.post_result_changes_forbidden !== true) throw new Error('Matrix randomness/analysis preregistration missing');
  const ordered = [...manifest.runs].sort((a: any, b: any) => a.order_index - b.order_index);
  if (ordered.length !== 20 || new Set(ordered.map((run: any) => run.run_id)).size !== 20
    || new Set(ordered.map((run: any) => run.seed)).size !== 20) throw new Error('Matrix identity/order inventory differs');
  const selected = ordered.slice(startIndex).map((run: any, offset: number) => {
    const index = startIndex + offset;
    const scenario = run.scenario === 'returning' ? 'returning' : run.scenario === 'cold' ? 'cold'
      : run.scenario === 'new-view' ? 'new-view' : run.scenario === 'local-loss' ? 'local-loss' : undefined;
    if (!scenario || run.order_index !== index) throw new Error(`Invalid matrix scenario/order at ${run.run_id}`);
    const orderDigest = `sha256:${createHash('sha256').update(`${manifest.order_seed}:${run.run_id}`).digest('hex')}`;
    if (orderDigest !== run.order_digest) throw new Error(`Matrix order digest differs at ${run.run_id}`);
    const executionRunId = `${identityPrefix}-${run.run_id}${executionAttempt > 0 ? `-retry-${executionAttempt}` : ''}`;
    return { runId: run.run_id as string, scenario: scenario as IndependentLabScenario, seed: run.seed as string,
      orderIndex: index, manifestPath: `delivery/results/econ-lab-manifest-${run.run_id}.json`,
      executionRunId, executionManifestPath: `delivery/results/econ-lab-manifest-${executionRunId}.json`,
      readiness: scenario === 'new-view' ? 'post-newView-startup' as const : 'installed' as const, status: 'selected' as const };
  });
  if (!options.execute) return selected;
  if (!options.independentReviewApproved) throw new Error('Matrix execution requires independent review approval');
  const completed = [];
  for (const run of selected) {
    if (existsSync(run.executionManifestPath)) throw new Error(`Matrix run manifest already exists: ${run.executionManifestPath}`);
    const perRunManifest = { ...manifest, execution_scope: { ...manifest.execution_scope, active_run_id: run.executionRunId,
      preregistered_run_id: run.runId, active_scenario: run.scenario, active_seed: run.seed, matrix_execution: true,
      execution_attempt: executionAttempt, identity_prefix: identityPrefix, retry_of: executionAttempt > 0 ? `matrix-${run.runId}` : null } };
    writeFileSync(run.executionManifestPath, `${JSON.stringify(perRunManifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await runIndependentRso5LabSmoke({ runId: run.executionRunId, seed: run.seed, scenario: run.scenario, manifestPath: run.executionManifestPath });
    completed.push({ ...run, status: 'completed' as const });
    await options.onRunComplete?.(run);
  }
  return completed;
}

function sideConfiguration(side: 'old' | 'new', oldSet: any, newSet: any): any {
  return side === 'old' ? oldSet : newSet;
}

function verifyRso5AuditReply(reply: any, request: any, replica: string): void {
  withDiagnosticUnboundedRecoveryWork(() => {
    if (reply.replica !== replica || reply.scope !== request.scope || reply.challenge !== request.challenge) throw new Error('RSO5 audit identity differs');
    const bytes = sustainableRecoveryConcat([sustainableRecoveryBytes('resonance:rso5:reply:v1\n', 'utf8', 'V'),
      sustainableRecoveryJson([reply.scope, reply.challenge, reply.replica, reply.digest ?? null, reply.bytes ?? null,
        reply.payload ?? null, reply.record ?? null, reply.checkpointHead ?? null, reply.checkpointSequence ?? null], 'V')], 'V');
    if (!verify(bytes, sustainableRecoveryBytes(reply.signature, 'base64url', 'V'), sustainableRecoveryBytes(replica, 'base64url', 'V'))) {
      throw new Error('Unauthenticated RSO5 audit reply');
    }
  });
}

function mergeLabTraffic(records: LabTrafficRecord[]): LabTrafficRecord[] {
  const unique = new Map<string, LabTrafficRecord>();
  for (const record of records) unique.set(`${record.messageId}\n${record.outcome}\n${record.direction}\n${record.source}\n${record.destination}\n${record.purpose}`, record);
  return [...unique.values()];
}

export function networkEvidence(records: LabTrafficRecord[]) {
  const requests = new Map<string, LabTrafficRecord>(), responses = new Map<string, LabTrafficRecord>(), refused = new Set<string>(), edges = new Map<string, any>();
  for (const record of records) {
    if (record.outcome === 'sent' && !record.responseTo) requests.set(record.messageId, record);
    if (record.outcome === 'received' && record.responseTo) responses.set(record.responseTo, record);
    if (record.outcome === 'received-refused') refused.add(record.messageId);
    if (record.outcome !== 'sent') continue;
    const key = `${record.source}\n${record.destination}\n${record.purpose}`;
    const edge = edges.get(key) ?? { source: record.source, destination: record.destination, direction: 'outbound', purpose: record.purpose,
      transport: record.transport, messages: 0, payload_bytes: 0, websocket_frame_bytes: 0 };
    edge.messages++; edge.payload_bytes += record.payloadBytes; edge.websocket_frame_bytes += record.frameBytes; edges.set(key, edge);
  }
  const missingReceived = [...requests.keys()].filter(id => !responses.has(id) && !refused.has(id));
  const unexpectedReceived = [...responses.keys()].filter(id => !requests.has(id));
  const mismatched = [...responses].flatMap(([id, response]) => {
    const request = requests.get(id);
    return request && (response.source !== request.destination || response.destination !== request.source || response.purpose !== request.purpose) ? [id] : [];
  });
  const edgeRows = [...edges.values()].sort((a, b) => `${a.source}${a.destination}${a.purpose}`.localeCompare(`${b.source}${b.destination}${b.purpose}`));
  const messageCount = requests.size + responses.size;
  const payloadBytes = edgeRows.reduce((sum, edge) => sum + edge.payload_bytes, 0);
  const frameBytes = edgeRows.reduce((sum, edge) => sum + edge.websocket_frame_bytes, 0);
  const edgeMessages = edgeRows.reduce((sum, edge) => sum + edge.messages, 0);
  return { message_count: messageCount, total_payload_bytes: payloadBytes,
    total_frame_bytes: frameBytes, edges: edgeRows,
    envelope_semantics: 'request+response envelopes; refused messages are separate and have no response envelope',
    reconciliation: { basis: 'authenticated client request/response linkage with recorded authentication refusals; server snapshots supplemental',
      exact: missingReceived.length === 0 && unexpectedReceived.length === 0 && mismatched.length === 0
        && edgeMessages === messageCount && payloadBytes === edgeRows.reduce((sum, edge) => sum + edge.payload_bytes, 0)
        && frameBytes === edgeRows.reduce((sum, edge) => sum + edge.websocket_frame_bytes, 0),
      edge_envelopes_match: edgeMessages === messageCount,
      sent_messages: requests.size, received_messages: responses.size,
      refused_messages: refused.size, missing_received: missingReceived,
      unexpected_received: unexpectedReceived, mismatched,
      server_snapshot_records: records.filter(record => record.outcome === 'received' && !record.responseTo).length,
      missing_received_details: missingReceived.map(id => requests.get(id)),
      unexpected_received_details: unexpectedReceived.map(id => responses.get(id)) } };
}

async function reconcileHostTools(activeWorkers: Worker[]) {
  const result: { nettop: any; iostat: any } = {
    nettop: { status: 'unavailable', reason: 'not run' }, iostat: { status: 'unavailable', reason: 'not run' },
  };
  try {
    const { stdout } = await executeFile('nettop', ['-P', '-n', '-x', '-L', '1'], { timeout: 20_000, maxBuffer: 32 * 1024 ** 2 });
    const activePids = new Set(activeWorkers.map(worker => worker.child.pid));
    const lines = stdout.split('\n').filter(line => activePids.has(Number(line.split(',')[1])));
    result.nettop = { status: 'observed', matching_process_rows: lines.length,
      sample_sha256: `sha256:${createHash('sha256').update(stdout).digest('hex')}`,
      reconciliation: 'Separate whole-process host view; no byte total inferred or added to WebSocket accounting' };
  } catch (error) { result.nettop = { status: 'unsupported', reason: error instanceof Error ? error.message.slice(0, 256) : String(error) }; }
  try {
    const { stdout } = await executeFile('iostat', ['-d', '-c', '1'], { timeout: 20_000, maxBuffer: 4 * 1024 ** 2 });
    result.iostat = { status: 'observed', sample_sha256: `sha256:${createHash('sha256').update(stdout).digest('hex')}`,
      reconciliation: 'Whole-host sample only; per-process attribution unavailable' };
  } catch (error) { result.iostat = { status: 'unsupported', reason: error instanceof Error ? error.message.slice(0, 256) : String(error) }; }
  return result;
}

async function sweepLabWorkerProcesses(): Promise<{ matchedBefore: number; terminated: number[]; remainingLivePids: number[] }> {
  const workerPath = join(process.cwd(), 'packages/relay/src/sustainable-rso5-lab-worker.ts');
  const matching = async () => {
    const { stdout } = await executeFile('ps', ['-axo', 'pid=,stat=,args='], { timeout: 5000, maxBuffer: 8 * 1024 ** 2 });
    return stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return match && match[3].endsWith(workerPath) && !match[2].startsWith('Z') ? [Number(match[1])] : [];
    });
  };
  const before = await matching(), terminated: number[] = [];
  const { execFile: exec } = await import('node:child_process');
  for (const pid of before) {
    try { process.kill(pid, 'SIGTERM'); terminated.push(pid); } catch { /* Already exited. */ }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && (await matching()).length) await new Promise(resolve => setTimeout(resolve, 50));
  for (const pid of await matching()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline && (await matching()).length) await new Promise(resolve => setTimeout(resolve, 50));
  return { matchedBefore: before.length, terminated, remainingLivePids: await matching() };
}
