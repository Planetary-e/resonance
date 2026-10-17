/** Run five real witness processes plus an explicitly synthetic uptime model. */
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Socket } from 'node:net';
import { generateSigningKeyPair, createAdmissionRequestBindingV2 } from '@resonance/core';
import { admissionKeyFingerprint, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionQuorumGate } from '@resonance/relay';
import { availabilityScenarios, percentile } from './witness-availability.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' }, trials: { type: 'string', default: '12' }, seed: { type: 'string', default: '20261001' } } });
const trials = Number(values.trials), seed = Number(values.seed);
if (!Number.isInteger(trials) || trials < 1 || trials > 100 || !Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff) {
  throw new Error('Use 1–100 trials and a positive 32-bit seed');
}
const output = values.out ? resolve(root, values.out) : join(root, 'docs/evals', `witness-availability-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
type Snapshot = { cpuMicros: number; voteCalls: number; replyPayloadBytes: number; droppedReplyBytes: number };
class WitnessProcess {
  child: ChildProcess;
  endpoint = '';
  ready: Promise<void>;
  exited: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stderr = '';
  constructor(directory: string) {
    this.child = fork(fileURLToPath(new URL('./fixtures/witness-relay.ts', import.meta.url)), [directory], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.stderr?.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
    this.exited = new Promise(resolve => this.child.once('exit', () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Witness startup timed out')), 15000);
      this.child.once('error', error => { clearTimeout(timer); reject(error); });
      this.child.once('exit', code => {
        clearTimeout(timer); const error = new Error(`Witness exited (${code}): ${this.stderr}`); reject(error);
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
        this.pending.clear();
      });
      this.child.on('message', (message: any) => {
        if (message.event === 'ready') { clearTimeout(timer); this.endpoint = message.endpoint; resolve(); return; }
        const item = this.pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timer); this.pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error)); else item.resolve(message.result);
      });
    });
  }
  request(command: string, fields: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child.connected) { reject(new Error('Witness is disconnected')); return; }
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Witness ${command} timed out`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, command, ...fields }, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try { await this.request('stop'); } catch { this.child.kill('SIGKILL'); }
    await this.exited; clearTimeout(timer);
  }
}

const directory = mkdtempSync(join(tmpdir(), 'resonance-witness-eval-'));
const witnesses: WitnessProcess[] = [];
let gate: ReturnType<typeof createAdmissionQuorumGate> | undefined;
const traces: Array<{ scenario: string; trial: number; accepted: boolean; elapsedMs: number; socketBytes: number;
  connections: number; cpuMs: number; voteCalls: number; replyPayloadBytes: number; droppedReplyBytes: number }> = [];
try {
  for (let i = 0; i < 5; i++) witnesses.push(new WitnessProcess(join(directory, String(i))));
  await Promise.all(witnesses.map(witness => witness.ready));
  const authorityKey = generateSigningKeyPair(), witnessKeys = witnesses.map(() => generateSigningKeyPair()), coordinatorKey = generateSigningKeyPair();
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  const issuerPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const time = Date.now(), encryptionKey = randomBytes(32);
  const policy = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', revision: 1, issuedAt: time - 1000, expiresAt: time + 86400000,
    activeKey: admissionKeyFingerprint(issuerPublicKey), keys: [{
      profile: { version: 1, scope: { issuer: 'eval-witnesses', community: 'public', epoch: 'eval-one' }, issuerPublicKey, relayUrls: [witnesses[0].endpoint] },
      notBefore: time - 1000, issueUntil: time + 3600000, spendUntil: time + 7200000, retryUntil: time + 10800000,
      witnesses: { version: 1, quorum: 4, members: witnessKeys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: witnesses[i].endpoint })),
        coordinators: [Buffer.from(coordinatorKey.publicKey).toString('base64url')] },
    }] }, authority, authorityKey.secretKey);
  await Promise.all(witnesses.map((witness, i) => witness.request('configure', { policy, authority,
    encryptionKey: encryptionKey.toString('base64'), publicKey: Buffer.from(witnessKeys[i].publicKey).toString('base64'), secretKey: Buffer.from(witnessKeys[i].secretKey).toString('base64') })));
  let sockets: Socket[] = [];
  const gateOptions = { directory: join(directory, 'coordinator'), encryptionKey, policy, signingKey: coordinatorKey,
    onTransportSocket(socket: Socket) { sockets.push(socket); } };
  gate = createAdmissionQuorumGate({ ...gateOptions, initialize: true });
  const claim = () => ({ spend: randomBytes(32).toString('base64url'), action: 'search' as const,
    requestBinding: createAdmissionRequestBindingV2('search', { text: randomBytes(16).toString('hex') }) });
  type Claim = ReturnType<typeof claim>;
  const snapshots = (): Promise<Snapshot[]> => Promise.all(witnesses.map(witness => witness.request('snapshot')));
  async function run(scenario: string, modes: string[], claims: Claim[], expected: boolean) {
    await Promise.all(witnesses.map((witness, i) => witness.request('profile', { mode: modes[i], seed: seed + i })));
    for (const [trial, value] of claims.entries()) {
      sockets = [];
      const before = await snapshots(), cpuBefore = process.cpuUsage(), start = performance.now();
      let accepted = true;
      try { await gate!.authorize(policy.activeKey, value.spend, value); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'Four admission witnesses are unavailable or disagree') throw error;
        accepted = false;
      }
      const elapsedMs = performance.now() - start;
      await Promise.all(sockets.map(socket => socket.closed ? Promise.resolve() : new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Witness socket did not close')), 1000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
      })));
      const after = await snapshots(), cpu = process.cpuUsage(cpuBefore);
      const delta = (field: keyof Snapshot) => after.reduce((sum, item, i) => sum + item[field] - before[i][field], 0);
      const row = { scenario, trial, accepted, elapsedMs, connections: sockets.length,
        socketBytes: sockets.reduce((sum, socket) => sum + socket.bytesRead + socket.bytesWritten, 0),
        cpuMs: (cpu.user + cpu.system + delta('cpuMicros')) / 1000,
        voteCalls: delta('voteCalls'), replyPayloadBytes: delta('replyPayloadBytes'), droppedReplyBytes: delta('droppedReplyBytes') };
      if (accepted !== expected) throw new Error(`Unexpected result: ${JSON.stringify(row)}`);
      if (scenario === 'cached-retry-all-offline' && (row.connections || row.voteCalls || row.socketBytes)) throw new Error('Cached retry unexpectedly used the network');
      if (scenario === 'two-lost-replies' && (row.voteCalls !== 5 || row.droppedReplyBytes <= 0)) throw new Error('Lost-reply fixture did not persist all votes');
      traces.push(row);
    }
    console.log(JSON.stringify({ scenario, trials: claims.length, accepted: expected }));
  }
  const normal = Array(5).fill('normal'), cached = Array.from({ length: trials }, claim);
  await run('all-online', normal, cached, true);
  await run('one-offline', [...normal.slice(0, 4), 'offline'], Array.from({ length: trials }, claim), true);
  await run('two-offline', [...normal.slice(0, 3), 'offline', 'offline'], Array.from({ length: trials }, claim), false);
  await run('delayed-replies', Array(5).fill('delayed'), Array.from({ length: trials }, claim), true);
  await run('one-offline-delayed', [...Array(4).fill('delayed'), 'offline'], Array.from({ length: trials }, claim), true);
  const lost = Array.from({ length: Math.min(trials, 4) }, claim);
  await run('two-lost-replies', [...normal.slice(0, 3), 'drop-reply', 'drop-reply'], lost, false);
  await run('same-claims-after-recovery', normal, lost, true);
  gate.close(); gate = createAdmissionQuorumGate(gateOptions);
  await run('cached-retry-all-offline', Array(5).fill('offline'), cached, true);
} finally {
  gate?.close();
  const stopped = await Promise.allSettled(witnesses.map(witness => witness.stop()));
  rmSync(directory, { recursive: true, force: true });
  for (const result of stopped) if (result.status === 'rejected') console.error(result.reason);
}

const latency = (rows: typeof traces) => ({ p50Ms: percentile(rows.map(r => r.elapsedMs), 0.5), p95Ms: percentile(rows.map(r => r.elapsedMs), 0.95) });
const measured = [...new Set(traces.map(row => row.scenario))].map(scenario => {
  const rows = traces.filter(row => row.scenario === scenario);
  return { scenario, attempts: rows.length, accepted: rows.filter(row => row.accepted).length,
    successLatency: latency(rows.filter(row => row.accepted)), refusalLatency: latency(rows.filter(row => !row.accepted)),
    meanSocketBytes: rows.reduce((sum, row) => sum + row.socketBytes, 0) / rows.length,
    meanCpuMs: rows.reduce((sum, row) => sum + row.cpuMs, 0) / rows.length };
});
const sources = ['packages/eval/src/witness-quorum.ts', 'packages/eval/src/witness-availability.ts', 'packages/eval/src/fixtures/witness-relay.ts',
  'packages/relay/src/server.ts', 'packages/relay/src/admission-witness.ts', 'packages/relay/src/admission-witness-transport.ts',
  'packages/relay/src/configured-admission-verifier.ts', 'packages/core/src/admission-witness.ts', 'packages/core/src/local-encrypted-state.ts', 'package-lock.json'];
const report = {
  generatedAt: new Date().toISOString(), sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
  runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  trials, seed, timeoutMs: 3000, replyDelayMs: [80, 160], measured, availability: availabilityScenarios(seed), traces,
};
const number = (value: number | null) => value === null ? '—' : value.toFixed(2);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${output}.md`, [
  '# Four-of-five witness availability and cost', '',
  `Generated ${report.generatedAt}; base commit \`${report.sourceBase}\`. The worktree includes this evaluation and the listener-port fix; exact source hashes and individual traces are in the [JSON report](${basename(output)}.json).`, '',
  '## Scope and assumptions', '',
  'The cost experiment runs five real relay processes, signed votes flushed to encrypted storage, and the production quorum gate on one computer. It measures only the witness-authorization phase: no token issuance, Blind RSA redemption, publication, client mixing, discovery, or private-route exchange is included. Synthetic random spend digests stand in for already-verified tokens. This is not an Internet pilot or an end-to-end app certification.', '',
  `Host: ${report.runtime.cpu}, ${report.runtime.platform}/${report.runtime.arch}, Node ${report.runtime.node}. Each condition has ${trials} sequential attempts, except lost replies and their recovery (at most four); no warm-up samples are discarded. p95 is a small-sample descriptive percentile, not a service-level guarantee. Histories start empty and remain small; this does not measure near-capacity snapshot rewrites or sustained concurrent load.`, '',
  'Offline means the witness listener is stopped; its process remains available for instrumentation and retains vote state. Delayed replies inject seeded 80–160 ms application-frame delay after the durable vote, not a kernel network model. Two lost replies persist all five votes but suppress two replies until the production three-second timeout; the next condition retries those exact claims after recovery. Cached retries reopen the coordinator history before attempting the identical operations with all five listeners stopped.', '',
  'Socket bytes count coordinator-side reads plus writes on successful WebSocket upgrades, once per link. They include HTTP upgrade and WebSocket framing on cleartext loopback; they exclude TCP/IP headers, failed connection attempts, retransmissions, TLS, and other application traffic. CPU milliseconds sum the coordinator and five relay processes, including instrumentation and incidental background work. They are not elapsed latency, energy, battery use, or radio wakeups.', '',
  '## Measured quorum phase', '',
  '| Condition | Accepted / attempts | Success p50 / p95 ms | Refusal p50 / p95 ms | Mean socket bytes | Mean CPU ms |',
  '|---|---:|---:|---:|---:|---:|',
  ...measured.map(row => `| ${row.scenario} | ${row.accepted}/${row.attempts} | ${number(row.successLatency.p50Ms)} / ${number(row.successLatency.p95Ms)} | ${number(row.refusalLatency.p50Ms)} / ${number(row.refusalLatency.p95Ms)} | ${number(row.meanSocketBytes)} | ${number(row.meanCpuMs)} |`), '',
  'Refusals remain in their own latency column and in the attempt denominator. A fast refusal does not mean useful availability. Cached acceptance applies only to a previously certified exact request, while the policy remains valid; it does not authorize new work.', '',
  '## Synthetic volunteer availability', '',
  'These are hypothetical schedules, not measured user behavior. The independent model has five separate on/off chains with six-hour mean online sessions and an offline mean chosen to give each stated online fraction. It samples exact Markov transitions every five minutes, warms up for seven days, then models 90 days with seed ' + seed + '. Requests are uniformly sampled every five minutes; an extra hour prevents censoring retries at the end. Available witnesses are assumed to respond within the three-second gate deadline. Conflicts, malicious votes, storage failures, and policy expiry are excluded.', '',
  'The 15/60-minute columns are explicit same-operation retry scenarios, not a new automatic retry feature. They model the gate alone and assume the claim and policy stay valid; application request expiry can prevent such long retries. Every attempt still needs four responses together: the coordinator does not retain partial certificates between attempts. Latency/loss costs above are separate from this uptime model. There is one seeded trace per scenario, with no confidence intervals or inference about the volunteer population.', '',
  '| Hypothetical scenario | Immediate | Within 15 min | Within 60 min | Accepted 60-min-window wait p95 |',
  '|---|---:|---:|---:|---:|',
  ...report.availability.scenarios.map(row => `| ${row.name} | ${row.windows.map(window => `${(100 * window.availability).toFixed(2)}%`).join(' | ')} | ${number(row.windows[2].acceptedWaitP95Minutes)} min |`), '',
  'Analytically, five independent witnesses each online with probability p give P(at least four) = p⁴(5−4p): 18.75% at p=0.5, 63.28% at 0.75, 91.85% at 0.9, and 97.74% at 0.95. With one witness permanently absent or withholding replies, availability is p⁴ for the other four: 65.61% at p=0.9. These exact independent probabilities are also retained in JSON; finite simulated traces need not equal them.', '',
  'The shared schedule gives all witnesses the same eight online hours per day. The staggered schedule starts eight-hour sessions at 00:00, 05:00, 10:00, 15:00, and 20:00: some witnesses are always online, but never four together. Temporal diversity alone therefore cannot sustain a fixed four-of-five quorum.', '',
  '## Decision', '',
  'Keep four-of-five admission experimental and opt-in. The local safety behavior is correct in these conditions, but ordinary intermittent desktops do not establish sufficient availability. Do not lower the threshold or introduce permanently operated relays to hide this problem. Within the volunteer-only requirement, a pilot needs volunteers with measured overlapping availability; that remains unproven here.', '',
  'Before enabling this by default: specify safe witness replacement and membership governance, including old/new-set overlap and retained spend history; measure real volunteer overlap and network delay; then measure device energy and near-capacity/concurrent costs. Partial-certificate retention may be worth a separate design review, but it changes which non-overlapping online periods can complete a request and is not implemented or assumed here. No production retry or membership behavior changes in this evaluation.', '',
  '## Reproduce', '', '```sh', `npm run eval:witness-availability -- --trials ${trials} --seed ${seed}`, '```', '',
  'This starts only temporary loopback listeners and removes its encrypted test histories on completion. It creates no installer or release. Timing/CPU values vary with host load; seeds reproduce the schedule model and injected-delay sequences, not cryptographic randomness or OS scheduling.', '',
].join('\n'));
console.log(JSON.stringify({ report: `${output}.md`, attempts: traces.length, measured }, null, 2));
