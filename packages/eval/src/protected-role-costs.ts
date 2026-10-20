/** Local cost experiment, never opens real user state. Fixture seeding is not
 * measured admission throughput; volunteers can run in separate child processes. */
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, platform, arch } from 'node:os';
import { parseArgs } from 'node:util';
import { HISTORY_CHECKPOINT_MAX_PAYLOAD, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createAdmissionWitnessRequest, createAdmissionWitnessVote } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { createProtectedAdmissionRoles } from '../../relay/src/protected-admission-roles.js';
import { parseAdmissionRoleHistories, type AdmissionRoleHistories, type AdmissionWitnessHistoryState, type AdmissionCoordinatorHistoryState } from '../../relay/src/admission-role-history.js';
import { protectedRoleFixture } from '../../relay/src/__tests__/fixtures/protected-role-fixture.js';
import { witnessFixture } from '../../relay/src/__tests__/fixtures/admission-witness-fixture.js';
import type { RoleCostWorkerInput } from './fixtures/protected-role-cost-worker.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' }, counts: { type: 'string', default: '1,100,1000,near' }, trials: { type: 'string', default: '2' },
  'separate-volunteers': { type: 'boolean', default: false }, 'cold-restart': { type: 'boolean', default: false },
  'history-timeout-ms': { type: 'string', default: '10000' } } });
const counts = values.counts!.split(','), trials = Number(values.trials);
const historyTimeoutMs = Number(values['history-timeout-ms']);
if (!Number.isSafeInteger(historyTimeoutMs) || historyTimeoutMs < 50 || historyTimeoutMs > 30000) throw new Error('History timeout must be 50–30000 ms');
if (!counts.length || counts.length > 8 || counts.some(value => value !== 'near' && (!/^[1-9][0-9]*$/.test(value) || Number(value) > 9998))
  || !Number.isSafeInteger(trials) || trials < 1 || trials > 10) throw new Error('Use 1–8 counts (1–9998 or near) and 1–10 trials');
const output = resolve(root, values.out ?? `docs/evals/protected-role-costs-${new Date().toISOString().replaceAll(':', '-')}.json`);
const f = await witnessFixture(), results: object[] = [];
const sources = ['packages/core/src/crypto.ts', 'packages/eval/src/protected-role-costs.ts', 'packages/eval/src/fixtures/protected-role-cost-worker.ts', 'packages/relay/src/protected-admission-roles.ts', 'packages/relay/src/admission-role-history.ts', 'packages/relay/src/admission-role-verification.ts', 'packages/relay/src/protected-admission-history.ts', 'packages/relay/src/admission-history-records.ts'];
const report = {
  generatedAt: new Date().toISOString(), sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  scope: `Five real loopback history sockets in ${values['separate-volunteers'] ? 'five separate volunteer processes' : 'the owner process'}; four local durable witness peers; no independent operators, Internet, TLS or energy measurement.`,
  accounting: 'JSON application request/reply bytes across all history members, excluding witness transport, WebSocket/TCP/TLS framing. CPU is process-wide. Peak RSS is process lifetime, not per-operation allocation. Reopen retains this process signature cache and is not a cold process restart.',
  seeded: 'Existing signed local votes/certificates are extended offline, then captured through the production reviewed/fenced four-copy workflow. Seeding is not sequential admission throughput.',
  near: '90% of the 8 MiB complete application checkpoint bound, with both witness and coordinator rows; row limits also apply.',
  coordinatorDeadlineMs: 3000, historyDeadlineMs: historyTimeoutMs, coldRestartHistoryDeadlineMs: 10000, trials, results,
};
function save() { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
interface VolunteerSnapshot { cpuMicros: number; receivedBytes: number; sentBytes: number; exchanges: number; rssMiB: number; peakRssMiB: number }
function startWorker(input: RoleCostWorkerInput) {
  const child = fork(new URL('./fixtures/protected-role-cost-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0, stderr = '', readyResolve!: (value: { endpoint?: string; result?: object }) => void, readyReject!: (error: Error) => void;
  const ready = new Promise<{ endpoint?: string; result?: object }>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => { readyReject(new Error('Benchmark worker startup timed out')); child.kill('SIGKILL'); }, 120000);
  const exited = new Promise<void>(resolve => child.once('exit', () => {
    clearTimeout(timer); const error = new Error(`Benchmark worker exited: ${stderr}`); readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); resolve();
  }));
  child.on('error', error => { clearTimeout(timer); readyReject(error); });
  child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-2048); });
  child.on('message', (message: { ready?: boolean; endpoint?: string; result?: object; error?: string; id?: number }) => {
    if (message.id) {
      const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error)); else item.resolve(message.result); return;
    }
    if (message.error) { clearTimeout(timer); readyReject(new Error(message.error)); }
    else if (message.ready) { clearTimeout(timer); readyResolve(message); }
  });
  child.send({ init: input });
  const request = (operation: string) => new Promise<unknown>((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error('Benchmark worker reply timed out')); }, 10000);
    pending.set(id, { resolve, reject, timer }); child.send({ id, operation }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
  });
  return { ready, snapshot: async () => await request('snapshot') as VolunteerSnapshot,
    async close() {
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
      try { if (input.role === 'volunteer' && child.connected) await request('close').catch(() => {}); await exited; }
      finally { clearTimeout(deadline); }
    } };
}
for (const requested of counts) {
  const n = await protectedRoleFixture(f);
  // Match the production history writer default. The reusable test fixture uses
  // a deliberately shorter one-second deadline; expose it as a separate option.
  n.options.protection.timeoutMs = historyTimeoutMs;
  const volunteers: ReturnType<typeof startWorker>[] = [];
  const operations: object[] = []; let requestBytes = 0, replyBytes = 0, exchanges = 0;
  const transport = n.options.protection.transport;
  n.options.protection.transport = async (member, frame, signal) => {
    requestBytes += Buffer.byteLength(JSON.stringify(frame)); exchanges++;
    const reply = await transport(member, frame, signal); replyBytes += Buffer.byteLength(JSON.stringify(reply)); return reply;
  };
  async function measure(name: string, operation: () => unknown | Promise<unknown>) {
    const volunteerBefore = await Promise.all(volunteers.map(worker => worker.snapshot()));
    const started = performance.now(), cpu = process.cpuUsage(), before = { requestBytes, replyBytes, exchanges };
    let error: string | null = null;
    try { await operation(); } catch (cause) { error = cause instanceof Error ? cause.message : 'operation failed'; }
    const usage = process.cpuUsage(cpu), wallMs = performance.now() - started;
    const volunteerAfter = await Promise.all(volunteers.map(worker => worker.snapshot()));
    const row = { name, ok: error === null, error, wallMs, cpuMs: (usage.user + usage.system) / 1000,
      requestBytes: requestBytes - before.requestBytes, replyBytes: replyBytes - before.replyBytes, exchanges: exchanges - before.exchanges,
      rssMiB: process.memoryUsage().rss / 1048576, lifetimePeakRssMiB: process.resourceUsage().maxRSS / 1024,
      ...(volunteers.length ? { volunteers: volunteerAfter.map((after, i) => ({ cpuMs: (after.cpuMicros - volunteerBefore[i].cpuMicros) / 1000,
        receivedBytes: after.receivedBytes - volunteerBefore[i].receivedBytes, sentBytes: after.sentBytes - volunteerBefore[i].sentBytes,
        exchanges: after.exchanges - volunteerBefore[i].exchanges, rssMiB: after.rssMiB, peakRssMiB: after.peakRssMiB })) } : {}) };
    operations.push(row); console.log(JSON.stringify({ requested, ...row })); return error === null;
  }
  let roles: ReturnType<typeof createProtectedAdmissionRoles> | undefined;
  try {
    const workerInput = (role: RoleCostWorkerInput['role'], index = 0): RoleCostWorkerInput => {
      const key = role === 'reader' ? n.owner : n.memberKeys[index];
      return { role, directory: role === 'reader' ? n.options.directory : join(n.directory, `r${index}`),
        key: Buffer.from(role === 'reader' ? n.key : n.localKey).toString('base64url'), context: n.context,
        rootId: historyCheckpointEnvelopeId(n.root), policy: f.policy, time: f.time, members: n.members,
        signingKey: { publicKey: Buffer.from(key.publicKey).toString('base64url'), secretKey: Buffer.from(key.secretKey).toString('base64url') } };
    };
    const readerInput = workerInput('reader');
    if (values['separate-volunteers']) {
      const inputs = n.stores.map((_, i) => workerInput('volunteer', i));
      n.stores.forEach((store, i) => { n.replicas[i].close(); store.close(); });
      volunteers.push(...inputs.map(startWorker));
      const started = await Promise.allSettled(volunteers.map(worker => worker.ready));
      started.forEach((result, i) => { if (result.status === 'rejected') throw result.reason; n.members[i].endpoint = result.value.endpoint!; });
    }
    await n.reopen(); await n.history.ready();
    const witness = openEncryptedLocalState<AdmissionWitnessHistoryState>({ path: join(n.options.directory, 'admission-witness-votes.json'), key: n.key,
      domain: 'resonance:admission-witness-votes:v1', maxBytes: 16 * 1024 * 1024, mode: 'open-existing', initial: null!,
      validate(value): value is AdmissionWitnessHistoryState { try { parseAdmissionRoleHistories({ witness: value, coordinator: null }, f.policy); return true; } catch { return false; } } });
    const coordinator = openEncryptedLocalState<AdmissionCoordinatorHistoryState>({ path: join(n.options.directory, 'admission-witness-certificates.json'), key: n.key,
      domain: 'resonance:admission-witness-certificates:v1', maxBytes: 32 * 1024 * 1024, mode: 'open-existing', initial: null!,
      validate(value): value is AdmissionCoordinatorHistoryState { try { parseAdmissionRoleHistories({ witness: null, coordinator: value }, f.policy); return true; } catch { return false; } } });
    const seeded: AdmissionRoleHistories = { witness: structuredClone(witness.read()), coordinator: structuredClone(coordinator.read()) };
    const imageBytes = () => Buffer.byteLength(JSON.stringify({ ...n.history.read().image, version: 2, roles: seeded }));
    const single = imageBytes(), claim = n.claim(), votes = f.witnesses.slice(0, 4).map(key => createAdmissionWitnessVote(claim, key));
    const rowBytes = Buffer.byteLength(JSON.stringify(votes[0])) + Buffer.byteLength(JSON.stringify({ version: 1, votes })) + 2;
    const count = requested === 'near' ? Math.min(9998, Math.floor((0.9 * HISTORY_CHECKPOINT_MAX_PAYLOAD - single) / rowBytes) + 1) : Number(requested);
    try {
      for (let i = 1; i < count; i++) {
        const claim = n.claim(), votes = f.witnesses.slice(0, 4).map(key => createAdmissionWitnessVote(claim, key));
        seeded.witness!.votes.push(votes[0]); seeded.coordinator!.certificates.push({ version: 1, votes });
      }
      witness.write(seeded.witness!); coordinator.write(seeded.coordinator!);
    } finally { coordinator.close(); witness.close(); }
    const row = { requested, retainedRowsPerRole: count, checkpointPlaintextBytes: imageBytes(), operations }; results.push(row); save();
    const captured = await measure('capture', async () => { const capture = await n.capture(); try { await capture.apply((await capture.review()).approvalDigest); } finally { capture.close(); } });
    if (!captured) { save(); continue; }
    roles = createProtectedAdmissionRoles({ history: n.history, witnessKey: f.witnesses[0], coordinatorKey: f.coordinators[0], now: () => f.time, timeoutMs: 3000,
      transport: async (member, request) => {
        const index = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
        if (index < 1) throw new Error('The other four local witnesses serve this measured coordinator');
        return n.witnesses[index].vote(request);
      } });
    for (let i = 0; i < trials; i++) {
      const vote = createAdmissionWitnessRequest(n.claim(), f.coordinators[0]);
      await measure(`witness-new-${i}`, () => roles!.witness!.vote(vote));
      await measure(`witness-retry-${i}`, () => roles!.witness!.vote(vote));
      const claim = n.claim();
      await measure(`coordinator-new-${i}`, () => roles!.quorum!.authorize(claim.issuerKey, claim.spend, claim));
      await measure(`coordinator-retry-${i}`, () => roles!.quorum!.authorize(claim.issuerKey, claim.spend, claim));
      save();
    }
    await measure('concurrent-witness-burst', async () => {
      const outcomes = await Promise.allSettled([0, 1].map(() => roles!.witness!.vote(createAdmissionWitnessRequest(n.claim(), f.coordinators[0]))));
      operations.push({ name: 'concurrent-witness-outcomes', accepted: outcomes.filter(v => v.status === 'fulfilled').length,
        refused: outcomes.filter(v => v.status === 'rejected').length });
    });
    roles.close(); roles = undefined;
    await measure('reopen-and-readiness-warm-cache', async () => { await n.reopen(); await n.history.ready(); }); save();
    if (values['cold-restart']) {
      n.history.close(); const started = performance.now(), reader = startWorker(readerInput);
      try {
        const result = await reader.ready;
        const row = { name: 'cold-process-restart', fullProcessWallMs: performance.now() - started, cpuScope: 'new owner process only; volunteer CPU excluded', ...result.result };
        operations.push(row); console.log(JSON.stringify({ requested, ...row }));
      } finally { await reader.close(); }
      save();
    }
  } finally { roles?.close(); await Promise.allSettled(volunteers.map(worker => worker.close())); await n.close(); save(); }
}
console.log(JSON.stringify({ report: output, scenarios: results.length }));
