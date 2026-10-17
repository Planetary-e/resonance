/** Local socket experiment using real private clients, envelopes, and relays. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';
import { RELAY_PEER_REQUEST_FRAME_TYPE, RELAY_PRIVATE_FORWARD_FRAME_TYPE } from '@resonance/core';
import { createRelayClient, type RelayClient, type PrivateTrafficScheduleOptions } from '@resonance/node';
import { createRelayServer, type RelayServer } from '@resonance/relay';
import { scoreTimingCorrelation } from './timing-correlation.js';

interface WireEvent { atMs: number; bytes: number }
interface ActionTrace {
  action: string;
  actionAtMs: number;
  discoveryAtMs?: number;
  completedAtMs?: number;
  requestId?: string;
}
interface Capture {
  startedAt: number;
  actions: Map<string, ActionTrace>;
  entry: Map<string, WireEvent>;
  destination: Map<string, WireEvent>;
  errors: string[];
}
interface Trace {
  action: string;
  actionAtMs: number;
  discoveryAtMs: number;
  entryAtMs: number;
  destinationAtMs: number;
  completedAtMs: number;
  entryBytes: number;
  destinationBytes: number;
}
type Mode = 'minimal-10ms-no-jitter' | 'default-250ms-batch-jitter';
type Workload = 'burst-20ms' | 'sparse-1000ms';
interface Trial {
  trial: number;
  mode: Mode;
  workload: Workload;
  traces: Trace[];
  actionToDiscovery: ReturnType<typeof scoreTimingCorrelation>;
  entryToDestination: ReturnType<typeof scoreTimingCorrelation>;
  colludingRequestIdLinks: number;
}

const { values } = parseArgs({ options: {
  clients: { type: 'string', default: '8' },
  trials: { type: 'string', default: '3' },
  out: { type: 'string' },
} });
const clientsPerTrial = integer(values.clients, 2, 16);
const trialCount = integer(values.trials, 1, 10);
const context = new AsyncLocalStorage<{ action: ActionTrace; capture: Capture }>();
let active: Capture | undefined;
const serverEmit = WebSocketServer.prototype.emit;
const clientSend = WebSocket.prototype.send;

// Test-only instrumentation: retain timestamps and lengths, not payloads or keys.
// Request IDs join ground truth for scoring and for the separate collusion probe.
WebSocketServer.prototype.emit = function (event, ...args) {
  if (event === 'connection' && active) {
    const capture = active;
    const [socket] = args;
    socket.once('message', (data: Buffer) => {
      const raw = data.toString('utf8');
      const frame = JSON.parse(raw);
      const observation = { atMs: performance.now() - capture.startedAt, bytes: Buffer.byteLength(raw) };
      if (frame.stage === 'entry') record(capture, capture.entry, frame.requestId, observation);
      if (frame.type === RELAY_PRIVATE_FORWARD_FRAME_TYPE) {
        record(capture, capture.destination, frame.destination.requestId, observation);
      }
    });
  }
  return Reflect.apply(serverEmit, this, [event, ...args]);
};
WebSocket.prototype.send = function (data, ...args) {
  const current = context.getStore();
  if (current && typeof data === 'string') {
    const frame = JSON.parse(data);
    if (frame.type === RELAY_PEER_REQUEST_FRAME_TYPE && current.action.discoveryAtMs === undefined) {
      current.action.discoveryAtMs = performance.now() - current.capture.startedAt;
    }
    if (frame.stage === 'entry') {
      if (current.action.requestId) current.capture.errors.push('A client sent more than one private request');
      current.action.requestId = frame.requestId;
    }
  }
  return Reflect.apply(clientSend, this, [data, ...args]);
};

const directory = mkdtempSync(join(tmpdir(), 'resonance-private-timing-'));
const relays: RelayServer[] = [];
const clients: RelayClient[] = [];
const results: Trial[] = [];

try {
  const entryPort = await freePort('127.0.0.1');
  const destinationPort = await freePort('::1');
  const entryUrl = `ws://127.0.0.1:${entryPort}/`;
  const destinationUrl = `ws://[::1]:${destinationPort}/`;
  const entry = relay(entryPort, '127.0.0.1', entryUrl, join(directory, 'entry'));
  const destination = relay(destinationPort, '::1', destinationUrl, join(directory, 'destination'));
  relays.push(entry, destination);
  await entry.start();
  await destination.start();
  if (entry.observeRelayDescriptor(destination.getRelayDescriptor()!) !== 'accepted') {
    throw new Error('Experiment could not establish a verified route');
  }
  for (const workload of ['burst-20ms', 'sparse-1000ms'] as const) {
    for (let trial = 1; trial <= trialCount; trial++) {
      // Alternate mode order to avoid always measuring the baseline first.
      const modes: Mode[] = ['minimal-10ms-no-jitter', 'default-250ms-batch-jitter'];
      if (trial % 2 === 0) modes.reverse();
      for (const mode of modes) {
        const capture: Capture = { startedAt: performance.now(), actions: new Map(),
          entry: new Map(), destination: new Map(), errors: [] };
        active = capture;
        const settings: PrivateTrafficScheduleOptions = mode === 'minimal-10ms-no-jitter'
          ? { batchWindowMs: 10, jitterMs: 0 } : {};
        // Independent virtual clients, each doing one action per trial. They
        // share a machine and IP; they do not share their local schedulers.
        const tasks = Array.from({ length: clientsPerTrial }, (_, index) => {
          const client = createRelayClient({ relayUrl: destinationUrl,
            privateEntryUrls: [entryUrl], privateTraffic: settings });
          clients.push(client);
          return new Promise<void>((resolveTask, rejectTask) => {
            setTimeout(() => {
              const action: ActionTrace = { action: `client-${index + 1}`,
                actionAtMs: performance.now() - capture.startedAt };
              capture.actions.set(action.action, action);
              context.run({ action, capture }, () => {
                void client.searchV2({
                  groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
                  fingerprint: new Uint8Array(64).fill(0xb5), itemType: 'need', k: 5, threshold: 0.9,
                }).then(reply => {
                  if (reply.results.length) throw new Error('Expected an empty synthetic index');
                  action.completedAtMs = performance.now() - capture.startedAt;
                  resolveTask();
                }).catch(rejectTask);
              });
            }, index * (workload === 'burst-20ms' ? 20 : 1_000));
          });
        });
        const outcomes = await Promise.allSettled(tasks);
        active = undefined;
        for (const client of clients.splice(0)) client.disconnect();
        if (outcomes.some(result => result.status === 'rejected')) {
          throw new Error(`Invalid timing trial: ${JSON.stringify(outcomes.filter(r => r.status === 'rejected'))}`);
        }
        results.push(scoreTrial(capture, trial, mode, workload));
        console.log(`TIMING trial=${trial} mode=${mode} workload=${workload} complete=${clientsPerTrial}`);
      }
    }
  }
} finally {
  active = undefined;
  for (const client of clients) client.disconnect();
  for (const server of relays.reverse()) await server.stop();
  WebSocketServer.prototype.emit = serverEmit;
  WebSocket.prototype.send = clientSend;
  rmSync(directory, { recursive: true, force: true });
}

const summaries = (['burst-20ms', 'sparse-1000ms'] as const).flatMap(workload =>
  (['minimal-10ms-no-jitter', 'default-250ms-batch-jitter'] as const).map(mode => {
    const group = results.filter(result => result.mode === mode && result.workload === workload);
    const traces = group.flatMap(result => result.traces);
    return {
      workload, mode, trials: group.length, requests: traces.length,
      actionToDiscoveryCorrect: group.reduce((sum, result) => sum + result.actionToDiscovery.correct, 0),
      entryToDestinationCorrect: group.reduce((sum, result) => sum + result.entryToDestination.correct, 0),
      colludingRequestIdLinks: group.reduce((sum, result) => sum + result.colludingRequestIdLinks, 0),
      releaseDelayP50Ms: percentile(traces.map(trace => trace.discoveryAtMs - trace.actionAtMs), 0.5),
      releaseDelayP95Ms: percentile(traces.map(trace => trace.discoveryAtMs - trace.actionAtMs), 0.95),
      completionP95Ms: percentile(traces.map(trace => trace.completedAtMs - trace.actionAtMs), 0.95),
      distinctEntryFrameSizes: new Set(traces.map(trace => trace.entryBytes)).size,
    };
  }));
const timestamp = new Date().toISOString();
const report = { timestamp, sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  platform: `${process.platform}/${process.arch}`, node: process.version,
  clientsPerTrial, trialCount, randomPairingAccuracy: 1 / clientsPerTrial, summaries, results };
const output = values.out ? resolve(values.out) : join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/evals'),
  `private-timing-${timestamp.replace(/[:.]/g, '-')}`,
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
const lines = [
  '# Local private-transport timing experiment', '',
  `Run: ${timestamp}. Node ${process.version}, ${report.platform}. Source base: ${report.sourceBase}; experiment source is in the same change as this report.`, '',
  '## Method and limits', '',
  `${clientsPerTrial} independent virtual clients each perform one equal-size search per trial through two real loopback relay sockets. Each mode/workload has ${trialCount} trials. Burst actions are scheduled 20 ms apart; sparse actions 1,000 ms apart. The baseline uses the minimum supported 10 ms queue window and no jitter; it is not a bypass of the production scheduler. The other mode uses the shipped 250 ms window and 0–250 ms jitter. Mode order alternates across trials.`, '',
  'Per-IP discovery and search limits are raised to 10,000/minute solely in the experiment because virtual clients share an address. Release delay means action invocation to the first discovery send; it includes signing, scheduler wait, and event-loop contention. It can exceed the configured jitter range. Completion latency includes both discovery exchanges and the private search.', '',
  'The timing attacker sorts source and destination timestamps and pairs by rank. It sees no request IDs, client labels, payloads, or ciphertext bytes. Ground-truth IDs are used only by the scorer. The action-to-discovery probe assumes an observer also knows user-action times; the inter-hop probe uses entry and destination ingress times. A separate collusion probe joins the one-use request ID visible to both relays. Incomplete or failed trials stop the experiment rather than disappearing from the denominator.', '',
  'This is a local diagnostic, not an Internet anonymity estimate. Clients and relays share a process, event loop, machine, and clock; sources share an IP. Sockets use loopback WS, not TLS, and the probe observes whole application frames rather than packets. Equal-size empty searches and a known trial window favor controlled comparison. The attack ignores addresses, sizes, discovery metadata, and repeated-user behavior; stronger attackers may do better. Production randomness remains enabled, so exact values vary between runs. No statistical privacy guarantee or release threshold is inferred.', '',
  `Random pairing reference within one ${clientsPerTrial}-action trial: ${(100 / clientsPerTrial).toFixed(1)}%. Counts below aggregate complete trials; they are not independent samples for a confidence interval.`, '',
  '## Results', '',
  '| Workload | Mode | Actions → discovery | Entry → destination | Colluding ID join | Release p50 / p95 ms | Completion p95 ms |',
  '|---|---|---:|---:|---:|---:|---:|',
  ...summaries.map(row => `| ${row.workload} | ${row.mode} | ${metric(row.actionToDiscoveryCorrect, row.requests)} | ${metric(row.entryToDestinationCorrect, row.requests)} | ${metric(row.colludingRequestIdLinks, row.requests)} | ${row.releaseDelayP50Ms} / ${row.releaseDelayP95Ms} | ${row.completionP95Ms} |`),
  '', '## Interpretation', '',
  'Compare the action-to-discovery columns to see whether local scheduling changes action order at the first network observation. The entry-to-destination column measures what remains after that scheduling has already happened. The local queue does not delay or mix forwarding at the entry relay. Exact ID joins belong to the stronger colluding-relay threat and are not available from encrypted Internet traffic alone.', '',
  'The implementation does not yet establish protection from a network observer. The next design must evaluate mixing requests from different clients at an entry relay, low-traffic behavior and cover traffic, response timing, and network delay variation. Colluding relays remain outside the two-hop non-collusion assumption. Removing a shared request ID alone would not prevent an entry from recognizing the ciphertext it forwards.', '',
  '## Reproduce', '',
  '```sh', `npm run eval:private-timing -- --clients ${clientsPerTrial} --trials ${trialCount}`, '```', '',
  `Machine-readable measurements: [JSON trace](${output.split('/').pop()}.json). No production data or private keys are recorded.`, '',
];
writeFileSync(`${output}.md`, lines.join('\n'));
console.log(JSON.stringify({ report: `${output}.md`, trace: `${output}.json`, summaries }, null, 2));

function scoreTrial(capture: Capture, trial: number, mode: Mode, workload: Workload): Trial {
  if (capture.errors.length || capture.actions.size !== clientsPerTrial
    || capture.entry.size !== clientsPerTrial || capture.destination.size !== clientsPerTrial) {
    throw new Error(`Incomplete timing observations: ${capture.errors.join(', ')}`);
  }
  const traces: Trace[] = [...capture.actions.values()].map(action => {
    const incoming = capture.entry.get(action.requestId ?? '');
    const outgoing = capture.destination.get(action.requestId ?? '');
    if (!incoming || !outgoing || action.discoveryAtMs === undefined || action.completedAtMs === undefined) {
      throw new Error('Missing timing ground truth');
    }
    return { action: action.action, actionAtMs: action.actionAtMs,
      discoveryAtMs: action.discoveryAtMs, entryAtMs: incoming.atMs,
      destinationAtMs: outgoing.atMs, completedAtMs: action.completedAtMs,
      entryBytes: incoming.bytes, destinationBytes: outgoing.bytes };
  });
  const observation = (key: 'actionAtMs' | 'discoveryAtMs' | 'entryAtMs' | 'destinationAtMs') =>
    traces.map(trace => ({ truth: trace.action, atMs: trace[key] }));
  return { trial, mode, workload, traces,
    actionToDiscovery: scoreTimingCorrelation(observation('actionAtMs'), observation('discoveryAtMs')),
    entryToDestination: scoreTimingCorrelation(observation('entryAtMs'), observation('destinationAtMs')),
    colludingRequestIdLinks: traces.length };
}

function record(capture: Capture, target: Map<string, WireEvent>, id: string, value: WireEvent): void {
  if (typeof id !== 'string' || target.has(id)) capture.errors.push('Duplicate or invalid observed request ID');
  else target.set(id, value);
}

function relay(port: number, host: string, endpoint: string, persistDir: string): RelayServer {
  return createRelayServer({ port, host, persistDir,
    privateEntryMix: false, // Preserve this earlier client-scheduler comparison.
    privateReplyMix: false,
    // Many virtual clients share one loopback IP; do not confound this timing
    // experiment with the default per-IP admission limits.
    maxPeerRequestsPerMin: 10_000, maxSearchesPerMin: 10_000,
    relayDiscovery: { endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 }, maxKnownRelays: 8 },
  });
}

async function freePort(host: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject); server.listen(0, host, resolveListen);
  });
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

function metric(correct: number, total: number): string {
  return `${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`;
}
