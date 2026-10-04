/** Compare forwarding with/without shared entry mixing in separate relay processes. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRelayClient, type RelayClient } from '@resonance/node';
import { type RelayConfig } from '@resonance/relay';
import { simulateFrameDelay, timingNow } from './fixtures/timing-delay.js';
import { scoreTimingCorrelation } from './timing-correlation.js';

interface Observation { phase: 'request' | 'reply'; requestId: string; atMs: number; bytes: number }
interface Action { id: string; actionAt: number; requestId?: string; clientReplyAt?: number; completedAt?: number }
interface Trace { id: string; actionAt: number; entryAt: number; destinationAt: number;
  destinationReplyAt: number; clientReplyAt: number; completedAt: number; bytes: number; replyBytes: number }
type Mode = 'unmixed' | 'entry-mix-750ms' | 'request-mix-only' | 'request-and-reply-mix';
type Profile = 'loopback' | 'frame-delay-20-60ms';
type Workload = 'burst-20ms' | 'sparse-1000ms';

const fixture = fileURLToPath(new URL('./fixtures/timing-relay.ts', import.meta.url));
class ProcessRelay {
  private child: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  readonly ready: Promise<{ descriptor: unknown; pid: number }>;
  constructor(config: Partial<RelayConfig>) {
    this.child = fork(fixture, [], { execArgv: ['--import', 'tsx'],
      env: { ...process.env, RESONANCE_TIMING_RELAY_CONFIG: JSON.stringify(config) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    this.child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8_192); });
    this.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => { this.child.kill(); rejectReady(new Error(`Relay startup timed out: ${stderr}`)); }, 15_000);
      this.child.on('message', (message: any) => {
        if (message.event === 'ready') { clearTimeout(timer); resolveReady(message); return; }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      });
      const fail = (error: Error) => {
        clearTimeout(timer); rejectReady(error);
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
      };
      this.child.on('error', fail);
      this.child.on('exit', code => fail(new Error(`Timing relay exited ${code}: ${stderr}`)));
    });
  }
  request(command: string, extra: object = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Relay command timed out: ${command}`)); }, 10_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.child.send({ id, command, ...extra }, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async stop(): Promise<void> {
    try { if (this.child.connected) await this.request('stop'); }
    finally { if (this.child.exitCode === null) this.child.kill(); }
  }
}

const { values } = parseArgs({ options: { clients: { type: 'string', default: '8' },
  trials: { type: 'string', default: '3' }, out: { type: 'string' },
  'reply-comparison': { type: 'boolean', default: false } } });
const count = integer(values.clients, 2, 16);
const trials = integer(values.trials, 1, 10);
const replyComparison = values['reply-comparison'];
const baseline: Mode = replyComparison ? 'request-mix-only' : 'unmixed';
const treatment: Mode = replyComparison ? 'request-and-reply-mix' : 'entry-mix-750ms';
const context = new AsyncLocalStorage<Action>();
const delay = simulateFrameDelay((socket, data) => {
  const action = context.getStore();
  if (!action || typeof data !== 'string') return;
  const frame = JSON.parse(data);
  if (frame.stage !== 'entry') return;
  if (action.requestId) throw new Error('Unexpected private request retry in timing experiment');
  action.requestId = frame.requestId;
  socket.once('message', () => { action.clientReplyAt = timingNow(); });
});
const directory = mkdtempSync(join(tmpdir(), 'resonance-mix-timing-'));
const processes: ProcessRelay[] = [];
const clients: RelayClient[] = [];
const results: Array<{ profile: Profile; workload: Workload; mode: Mode; trial: number; traces: Trace[];
  forward: ReturnType<typeof scoreTimingCorrelation>; reply: ReturnType<typeof scoreTimingCorrelation> }> = [];
let processIds: number[] = [];
try {
  const ports: number[] = [];
  for (const host of ['127.0.0.1', '127.0.0.1', '::1']) {
    let port: number;
    do { port = await freePort(host); } while (ports.includes(port));
    ports.push(port);
  }
  const endpoints = [`ws://127.0.0.1:${ports[0]}/`, `ws://127.0.0.1:${ports[1]}/`, `ws://[::1]:${ports[2]}/`];
  for (let index = 0; index < 3; index++) processes.push(new ProcessRelay({
    port: ports[index], host: index === 2 ? '::1' : '127.0.0.1', persistDir: join(directory, String(index)),
    privateEntryMix: index === 1 || (replyComparison && index === 0) ? {} : false,
    privateReplyMix: replyComparison && index === 1 ? {} : false,
    maxPeerRequestsPerMin: 10_000, maxSearchesPerMin: 10_000,
    relayDiscovery: { endpoints: [endpoints[index]], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 }, maxKnownRelays: 8 },
  }));
  const ready = await Promise.all(processes.map(relay => relay.ready));
  processIds = ready.map(item => item.pid);
  if (new Set(processIds).size !== 3 || processIds.includes(process.pid)) throw new Error('Relays are not isolated');
  for (const entry of processes.slice(0, 2)) {
    if (await entry.request('observe', { descriptor: ready[2].descriptor }) !== 'accepted') throw new Error('Route setup failed');
  }
  for (const profile of ['loopback', 'frame-delay-20-60ms'] as const) {
    for (const workload of ['burst-20ms', 'sparse-1000ms'] as const) {
      for (let trial = 1; trial <= trials; trial++) {
        const modes: Mode[] = [baseline, treatment];
        if (trial % 2 === 0) modes.reverse();
        for (const mode of modes) {
          const entryIndex = mode === baseline ? 0 : 1;
          const seed = trial * 10_007 + (workload === 'burst-20ms' ? 31 : 71);
          const delayed = profile !== 'loopback';
          delay.configure(delayed, seed);
          await Promise.all(processes.map((relay, index) => relay.request('reset', { delay: delayed, seed: seed + index + 1 })));
          const start = timingNow();
          const actions: Action[] = [];
          const tasks = Array.from({ length: count }, (_, index) => {
            const client = createRelayClient({ relayUrl: endpoints[2], privateEntryUrls: [endpoints[entryIndex]] });
            clients.push(client);
            return new Promise<void>((resolveTask, reject) => setTimeout(() => {
              const action: Action = { id: `client-${index + 1}`, actionAt: timingNow() };
              actions.push(action);
              context.run(action, () => {
                void client.searchV2({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
                  fingerprint: new Uint8Array(64).fill(0xb5), itemType: 'need', k: 5, threshold: 0.9,
                }).then(reply => {
                  if (reply.results.length) throw new Error('Unexpected result in empty index');
                  action.completedAt = timingNow(); resolveTask();
                }).catch(reject);
              });
            }, index * (workload === 'burst-20ms' ? 20 : 1_000)));
          });
          const outcomes = await Promise.allSettled(tasks);
          for (const client of clients.splice(0)) client.disconnect();
          const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
          if (failures.length) throw new Error(`Incomplete timing trial: ${failures.map(result => String(result.reason)).join('; ')}`);
          const incoming = indexObservations(await processes[entryIndex].request('snapshot'), 'request', count);
          const destinationEvents: Observation[] = await processes[2].request('snapshot');
          const forwarded = indexObservations(destinationEvents, 'request', count);
          const replies = indexObservations(destinationEvents, 'reply', count);
          const traces = actions.map(action => {
            const id = action.requestId ?? '';
            const entry = incoming.get(id); const destination = forwarded.get(id); const reply = replies.get(id);
            if (!entry || !destination || !reply || action.clientReplyAt === undefined || action.completedAt === undefined) {
              throw new Error('Missing trace ground truth');
            }
            const stages = [action.actionAt, entry.atMs, destination.atMs, reply.atMs, action.clientReplyAt, action.completedAt];
            if (stages.some((time, index) => !Number.isFinite(time) || (index > 0 && time + 2 < stages[index - 1]))) {
              throw new Error('Trace stage order or cross-process clock check failed');
            }
            return { id: action.id, actionAt: action.actionAt - start, entryAt: entry.atMs - start,
              destinationAt: destination.atMs - start, destinationReplyAt: reply.atMs - start,
              clientReplyAt: action.clientReplyAt - start, completedAt: action.completedAt - start,
              bytes: entry.bytes, replyBytes: reply.bytes };
          });
          const obs = (field: 'entryAt' | 'destinationAt' | 'destinationReplyAt' | 'clientReplyAt') =>
            traces.map(trace => ({ truth: trace.id, atMs: trace[field] }));
          const forward = scoreTimingCorrelation(obs('entryAt'), obs('destinationAt'));
          const reply = scoreTimingCorrelation(obs('destinationReplyAt'), obs('clientReplyAt'));
          results.push({ profile, workload, mode, trial, traces, forward, reply });
          console.log(`MIX ${profile} ${workload} ${mode} trial=${trial} forward=${forward.correct}/${count} reply=${reply.correct}/${count}`);
        }
      }
    }
  }
} finally {
  for (const client of clients) client.disconnect();
  await Promise.allSettled(processes.map(relay => relay.stop()));
  delay.restore(); rmSync(directory, { recursive: true, force: true });
}

const summaries = [...new Set(results.map(result => `${result.profile}|${result.workload}|${result.mode}`))].map(key => {
  const group = results.filter(result => `${result.profile}|${result.workload}|${result.mode}` === key);
  const traces = group.flatMap(result => result.traces);
  return { profile: group[0].profile, workload: group[0].workload, mode: group[0].mode, requests: traces.length,
    forwardCorrect: group.reduce((sum, row) => sum + row.forward.correct, 0),
    replyCorrect: group.reduce((sum, row) => sum + row.reply.correct, 0),
    transitP50Ms: percentile(traces.map(trace => trace.destinationAt - trace.entryAt), 0.5),
    transitP95Ms: percentile(traces.map(trace => trace.destinationAt - trace.entryAt), 0.95),
    returnP50Ms: percentile(traces.map(trace => trace.clientReplyAt - trace.destinationReplyAt), 0.5),
    returnP95Ms: percentile(traces.map(trace => trace.clientReplyAt - trace.destinationReplyAt), 0.95),
    completionP95Ms: percentile(traces.map(trace => trace.completedAt - trace.actionAt), 0.95),
    distinctEntrySizes: new Set(traces.map(trace => trace.bytes)).size,
    distinctReplySizes: new Set(traces.map(trace => trace.replyBytes)).size };
});
const timestamp = new Date().toISOString();
const output = values.out ? resolve(values.out) : join(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/evals'),
  `private-${replyComparison ? 'reply' : 'mix'}-${timestamp.replace(/[:.]/g, '-')}`);
mkdirSync(dirname(output), { recursive: true });
const report = { timestamp, sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version, platform: `${process.platform}/${process.arch}`, processIds, parentPid: process.pid,
  comparison: replyComparison ? 'reply-mixing' : 'request-mixing',
  clientsPerTrial: count, trials, summaries, results };
writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${output}.md`, [
  `# Separate-process ${replyComparison ? 'reply' : 'entry'}-mixing experiment`, '',
  `Run: ${timestamp}; Node ${process.version}; ${report.platform}. Source base: ${report.sourceBase}. Experiment and queue changes are in the same commit as this report.`, '',
  '## Method and limits', '',
  `${count} logical clients each send one equal-size search per trial. The clients share the parent process; baseline entry, treatment entry, and destination each run in their own child process. Both conditions use the default client scheduler. ${replyComparison
    ? 'Both entries mix requests using a 750 ms collection window. The baseline immediately returns each encrypted reply; the treatment collects replies in an independent 750 ms queue and shuffles their release.'
    : 'The treatment holds requests for a 750 ms collection window, then shuffles them; the baseline forwards immediately. Both entries explicitly disable reply mixing to isolate request mixing.'} Mode order alternates across ${trials} trials per workload/network profile. Burst actions are scheduled 20 ms apart; sparse actions 1,000 ms apart.`, '',
  'The simulated network profile delays each outgoing application frame by 20–60 ms, using seeded per-process pseudo-random streams. The zero-delay profile is ordinary loopback. This models frame latency and reordering between independent short connections, not TCP packet loss, bandwidth, geographic paths, or TLS record sizes. Relays share a physical machine and host clock; traces use epoch timestamps with a 2 ms cross-process clock tolerance. Per-IP discovery/search limits are raised to 10,000/minute because virtual clients share an address.', '',
  'The observer pairs timestamps by rank, without IDs, payloads, or sizes. Ground truth is kept only by the scorer. Forward accuracy compares entry ingress to destination ingress; reply accuracy compares destination reply send to client receipt. Transit latency includes queueing, cryptography, signing, and the simulated link. Full completion latency includes discovery. All requests must finish and have complete traces; failed trials stop the run. Crypto randomness is enabled, so exact measurements vary.', '',
  `Random-pairing reference for ${count} requests per trial: ${(100 / count).toFixed(1)}%; actual collection windows may contain fewer requests. Every request here uses one destination and one size bucket; batches split across destinations or sizes are not measured. Scores are a limited diagnostic, not independent statistical samples or an Internet anonymity guarantee. A stronger observer can use sizes, destinations, discovery, and repeated traffic. Colluding relays can still link the forwarded ciphertext and request ID.`, '',
  '## Results', '',
  '| Network | Workload | Entry | Forward matches | Reply matches | Transit p50 / p95 ms | Return p50 / p95 ms | Completion p95 ms |',
  '|---|---|---|---:|---:|---:|---:|---:|',
  ...summaries.map(row => `| ${row.profile} | ${row.workload} | ${row.mode} | ${metric(row.forwardCorrect, row.requests)} | ${metric(row.replyCorrect, row.requests)} | ${row.transitP50Ms} / ${row.transitP95Ms} | ${row.returnP50Ms} / ${row.returnP95Ms} | ${row.completionP95Ms} |`),
  '', '## Interpretation', '',
  `Compare baseline and treatment under the same workload and network profile. Mixing may reorder a busy batch; it does not create other users in a quiet window. ${replyComparison
    ? 'Reply scores isolate the added return queue; changes in forward scores between these two modes do not establish a benefit from reply mixing. Replies remain bound to their original request deadline, and admission failure never bypasses the queue.'
    : 'The return path is explicitly unmixed in this request-only comparison.'} This experiment provides no cover traffic and no defense against colluding relay operators. Do not treat a low score for one attack as proof of anonymity.`, '',
  '## Reproduce', '', '```sh', `npm run eval:private-${replyComparison ? 'replies' : 'mix'} -- --clients ${count} --trials ${trials}`, '```', '',
  `[Machine-readable traces](${basename(output)}.json). No production records, encrypted payloads, or private keys are retained.`, '',
].join('\n'));
console.log(JSON.stringify({ report: `${output}.md`, summaries }, null, 2));

function indexObservations(observations: Observation[], phase: Observation['phase'], expected: number) {
  const selected = observations.filter(value => value.phase === phase);
  const indexed = new Map(selected.map(value => [value.requestId, value]));
  if (selected.length !== expected || indexed.size !== expected) throw new Error('Missing or duplicate observations');
  return indexed;
}
async function freePort(host: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, host, resolveListen); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}
function integer(value: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error('Invalid experiment size');
  return number;
}
function percentile(values: number[], fraction: number): number {
  return Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1].toFixed(1));
}
function metric(correct: number, total: number): string { return `${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`; }
