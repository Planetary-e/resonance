import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { cpus, totalmem, freemem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createContentPollRequestV1,
  createLeasedIndexV1,
  createLeasedIndexLookupRequestV1,
  createLeasedIndexSearchRequestV1,
  createOfflineFetchRequestV1,
  createOriginalCommitmentV1,
  parseLeasedIndexOperationV1,
  createPairwiseChannelId,
  deriveSharedSecret,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateRelationshipKeyMaterial,
  generateSigningKeyPair,
  encodeBase64,
  decodeBase64,
  createRelayContactHintV1,
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
  type RelayDescriptorV1,
} from '@resonance/core';
import {
  ContentGrantStore,
  OfflineRequestStore,
  createRelayClient,
  type AdmissionCapabilityProviderV2,
  type AdmissionCapabilityRequestContextV2,
  type ClientHeldRelayClient,
} from '@resonance/node';
import { discoverRelayContactV1, LeasedIndexStore } from '@resonance/relay';
import {
  ActiveFixtureState,
  SearchValidationError,
  ValidationInconclusiveError,
  advanceFixtureOnAcknowledgment,
  validateSearchResults,
} from './client-held-search-validation.js';
import {
  attemptsInFixedWindow,
  FixedWindowOfferScheduler,
  waitForQuietWindowRetryCapacity,
  type FixedWindowAttempt,
} from './client-held-retry-capacity.js';
import {
  HarnessDiskAccounting,
  realDirectoryBytes as directoryBytes,
} from './client-held-disk-accounting.js';
import { MailboxState } from './client-held-mailbox-rotation.js';
import { reconstructRelayFixtureState, reconcileFixtureWithCurrent } from './client-held-oracle-reconstruction.js';
import {
  attachDeadlineContention,
  attachOperationContention,
  memorySample,
  operationContentionEvidence,
  RpcTelemetry,
  RuntimeTelemetry,
} from './client-held-runtime-telemetry.js';

const DAY = 86_400_000;
const REPLICAS = 5;
const RETRY_SOURCE_BUCKET = 'loopback:127.0.0.1';
const DEFAULT_PUBLICATIONS = 10_000;
const DEFAULT_OPERATIONS = 1_002;
const RESULT_DIR = resolve('delivery/results');
const SOURCE_FILES = [
  'packages/eval/src/client-held-local-resources.ts',
  'packages/eval/src/client-held-search-validation.ts',
  'packages/eval/src/client-held-retry-capacity.ts',
  'packages/eval/src/client-held-disk-accounting.ts',
  'packages/eval/src/client-held-mailbox-rotation.ts',
  'packages/eval/src/client-held-oracle-reconstruction.ts',
  'packages/eval/src/client-held-runtime-telemetry.ts',
  'packages/eval/src/fixtures/client-held-resource-relay.ts',
  'packages/relay/src/atomic-file.ts',
  'packages/relay/src/leased-index-store.ts',
  'packages/relay/src/matching-engine.ts',
  'packages/relay/src/hamming-index.ts',
  'packages/relay/src/mailbox-generation-store.ts',
  'packages/relay/src/server.ts',
  'packages/node/src/offline-request-store.ts',
  'packages/node/src/content-grant-store.ts',
  'packages/node/src/relay-client.ts',
];
const TARGETS = Object.freeze({
  minimumNominalSuccess: 0.995,
  warmP95Ms: 6_000,
  p99Ms: 10_000,
  protectedDecisionMs: 3_000,
  privateOperationMs: 10_000,
  maximumBytesPerGoodOperation: 1024 ** 2,
  maximumRelayRssBytes: 512 * 1024 ** 2,
  maximumApplicationRssBytes: 1536 * 1024 ** 2,
  maximumStartupRssBytes: 2 * 1024 ** 3,
  maximumIdleCpuPercentOfOneCore: 1,
});
const runtimeTelemetry = new RuntimeTelemetry();
const rpcTelemetry = new RpcTelemetry();
const moduleEntryParentMemory = memorySample();
const localIo = { fsyncCount: 0, fsyncMicros: 0, writeCount: 0, writeBytes: 0, renameCount: 0 };
const parentFsync = fs.fsyncSync;
fs.fsyncSync = function (fd) {
  const started = performance.now();
  try { return parentFsync(fd); }
  finally {
    localIo.fsyncCount++;
    localIo.fsyncMicros += (performance.now() - started) * 1000;
  }
};
const parentWriteFile = fs.writeFileSync;
fs.writeFileSync = function (path: any, data: any, options?: any) {
  const result = parentWriteFile(path, data, options);
  localIo.writeCount++;
  localIo.writeBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  return result;
};
const parentAppendFile = fs.appendFileSync;
fs.appendFileSync = function (path: any, data: any, options?: any) {
  const result = parentAppendFile(path, data, options);
  localIo.writeCount++;
  localIo.writeBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  return result;
};
const parentWrite = fs.writeSync;
fs.writeSync = function (...args: any[]) {
  const result = (parentWrite as any)(...args);
  localIo.writeCount++;
  if (typeof result === 'number') localIo.writeBytes += result;
  return result;
};
const parentRename = fs.renameSync;
fs.renameSync = function (from, to) {
  const result = parentRename(from, to);
  localIo.renameCount++;
  return result;
};
syncBuiltinESMExports();
const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'run' },
    profile: { type: 'string', default: 'nominal' },
    run: { type: 'string', default: '1' },
    root: { type: 'string', default: join(tmpdir(), 'resonance-client-held-local-resources-dec023') },
    publications: { type: 'string', default: String(DEFAULT_PUBLICATIONS) },
    operations: { type: 'string', default: String(DEFAULT_OPERATIONS) },
    'idle-seconds': { type: 'string', default: '1800' },
  },
});
const mode = args.mode!;
let measurementStage = 'initialization';
const root = resolve(args.root!);
const diskAccounting = new HarnessDiskAccounting(root);
const publicationCount = Number(args.publications);
const operationCount = Number(args.operations);
const runNumber = Number(args.run);
const idleSeconds = Number(args['idle-seconds']);
const qualificationShape = publicationCount === DEFAULT_PUBLICATIONS && operationCount === DEFAULT_OPERATIONS;
if (!Number.isSafeInteger(publicationCount) || publicationCount < 1
  || !Number.isSafeInteger(operationCount) || operationCount < 3
  || !Number.isSafeInteger(runNumber) || runNumber < 1
  || !Number.isSafeInteger(idleSeconds) || idleSeconds < 1) throw new Error('Invalid measurement arguments');
if (!process.env.NODE_EXTRA_CA_CERTS || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('WSS requires NODE_EXTRA_CA_CERTS and normal certificate verification');
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url');
}
const admissionProvider: AdmissionCapabilityProviderV2 = Object.assign(
  (context: AdmissionCapabilityRequestContextV2): AdmissionCapabilityV2 => ({
    version: 2,
    kind: 'admission-capability',
    scheme: 'live-test-v1',
    issuer: 'community:test',
    token: digest(`token:${context.requestBinding}`),
    requestProof: digest(context.requestBinding),
  }),
  { assertMaintenanceDestination: () => {} },
);
const LOCAL_ADMISSION: AdmissionCapabilityV2 = {
  version: 2,
  kind: 'admission-capability',
  scheme: 'live-test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};

interface SeedRecord {
  keys: LeasedIndexKeyMaterialV1;
  index: LeasedIndexV1;
  operationBytes: string;
}
interface SeedManifest {
  publicationCount: number;
  createdAt: number;
  expiresAt: number;
  refreshCreatedAt: number;
  refreshExpiresAt: number;
}

function fingerprint(index: number): Uint8Array {
  const value = Buffer.alloc(64, (index * 17 + 31) % 251);
  value.writeUInt32BE(index, 0);
  return value;
}
function serializeKeys(keys: LeasedIndexKeyMaterialV1): any {
  return {
    ...keys,
    signingKeyPair: {
      publicKey: encodeBase64(keys.signingKeyPair.publicKey),
      secretKey: encodeBase64(keys.signingKeyPair.secretKey),
    },
    mailboxKeyPair: {
      publicKey: encodeBase64(keys.mailboxKeyPair.publicKey),
      secretKey: encodeBase64(keys.mailboxKeyPair.secretKey),
    },
  };
}
function deserializeKeys(value: any): LeasedIndexKeyMaterialV1 {
  return {
    ...value,
    signingKeyPair: {
      publicKey: decodeBase64(value.signingKeyPair.publicKey),
      secretKey: decodeBase64(value.signingKeyPair.secretKey),
    },
    mailboxKeyPair: {
      publicKey: decodeBase64(value.mailboxKeyPair.publicKey),
      secretKey: decodeBase64(value.mailboxKeyPair.secretKey),
    },
  };
}
function seedPaths() {
  return {
    manifest: join(root, 'seed-manifest.json'),
    records: join(root, 'seed-records.json'),
    reference: join(root, 'seed-reference'),
  };
}
function loadSeed(): { manifest: SeedManifest; records: SeedRecord[] } {
  const paths = seedPaths();
  const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as SeedManifest;
  if (manifest.publicationCount !== publicationCount) {
    throw new Error(`Seed cardinality ${manifest.publicationCount} does not match requested ${publicationCount}`);
  }
  const records = (JSON.parse(readFileSync(paths.records, 'utf8')) as any[]).map(record => ({
    ...record,
    keys: deserializeKeys(record.keys),
  }));
  if (records.length !== publicationCount) throw new Error('Seed record count mismatch');
  return { manifest, records };
}
function environment() {
  return {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryAtStartBytes: freemem(),
    tls: 'WSS with NODE_EXTRA_CA_CERTS; certificate verification enabled; no external network',
    modelRuntime: 'none; fixed derivation and deterministic 64-byte fingerprint fixtures',
  };
}
function sourceIdentity() {
  return SOURCE_FILES.map(path => ({
    path,
    sha256: createHash('sha256').update(readFileSync(resolve(path))).digest('hex'),
  }));
}
function seedDataIdentity() {
  return ['seed-manifest.json', 'seed-records.json'].map(name => ({
    name,
    sha256: createHash('sha256').update(readFileSync(join(root, name))).digest('hex'),
  }));
}
function command() {
  return ['node', '--import', 'tsx', 'packages/eval/src/client-held-local-resources.ts', ...process.argv.slice(2)];
}
function writeResult(name: string, value: unknown): string {
  mkdirSync(RESULT_DIR, { recursive: true });
  const path = join(RESULT_DIR, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function latencySummary(values: number[]) {
  return {
    count: values.length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maximumMs: values.length ? Math.max(...values) : null,
  };
}
function operationPhaseSummary(records: OperationRecord[]) {
  const selected = records.filter(record => record.kind === 'mailbox' && record.phases);
  const names = [...new Set(selected.flatMap(record => Object.keys(record.phases!)))];
  return Object.fromEntries(names.map(name => [
    name,
    latencySummary(selected.map(record => record.phases![name]).filter(Number.isFinite)),
  ]));
}
function summarizeOperations(records: OperationRecord[]) {
  const good = records.filter(record => record.outcome === 'good');
  const byKind: Record<string, unknown> = {};
  for (const kind of ['publish', 'search', 'mailbox']) {
    const selected = records.filter(record => record.kind === kind && record.outcome !== 'retry');
    const selectedGood = selected.filter(record => record.outcome === 'good');
    byKind[kind] = {
      submitted: selected.length,
      good: selectedGood.length,
      refused: selected.filter(record => record.outcome === 'refused').length,
      retries: selected.filter(record => record.outcome === 'retry').length,
      uncertain: selected.filter(record => record.outcome === 'uncertain').length,
      inconclusive: selected.filter(record => record.outcome === 'inconclusive').length,
      deadlineExceeded: selected.filter(record => record.outcome === 'deadline_exceeded').length,
      latency: latencySummary(selectedGood.map(record => record.latencyMs)),
    };
  }
  return {
    submitted: records.filter(record => record.outcome !== 'retry').length,
    good: good.length,
    refused: records.filter(record => record.outcome === 'refused').length,
    retries: records.filter(record => record.outcome === 'retry').length,
    uncertain: records.filter(record => record.outcome === 'uncertain').length,
    inconclusive: records.filter(record => record.outcome === 'inconclusive').length,
    deadlineExceeded: records.filter(record => record.outcome === 'deadline_exceeded').length,
    successFraction: records.length ? good.length / records.filter(record => record.outcome !== 'retry').length : 0,
    errorClasses: Object.fromEntries([...new Set(records.map(record => record.errorClass).filter(Boolean))].map(category => [
      category,
      records.filter(record => record.errorClass === category).length,
    ])),
    latency: latencySummary(good.map(record => record.latencyMs)),
    relayEvidence: records.filter(record => record.relayEvidence).map(record => ({
      sequence: record.sequence,
      kind: record.kind,
      outcome: record.outcome,
      ...(record.errorClass ? { errorClass: record.errorClass } : {}),
      attempts: record.relayEvidence,
    })),
    reconciliationEvidence: records.filter(record => record.reconciliationEvidence?.length).map(record => ({
      sequence: record.sequence,
      kind: record.kind,
      outcome: record.outcome,
      evidence: record.reconciliationEvidence,
    })),
    contentionEvidence: operationContentionEvidence(records),
    validationFailures: records.filter(record => record.validationDetails).map(record => ({
      sequence: record.sequence,
      outcome: record.outcome,
      failure: record.validationDetails,
    })),
    byKind,
    connectionClasses: Object.fromEntries(['cold', 'reconnecting', 'warm-client-new-TCP'].map(category => [
      category,
      records.filter(record => record.connectionClass === category).length,
    ])),
  };
}

interface Pair {
  front: Socket;
  back: Socket;
}
class ByteProxy {
  endpoint!: string;
  private server: Server;
  private pairs = new Set<Pair>();
  private closed: Pair[] = [];
  connections = 0;
  private constructor(port: number) {
    this.server = createServer(front => {
      this.connections++;
      const back = connect({ port, host: '127.0.0.1' });
      const pair = { front, back };
      this.pairs.add(pair);
      front.on('error', () => back.destroy());
      back.on('error', () => front.destroy());
      front.pipe(back).pipe(front);
      const cleanup = () => {
        if (!this.pairs.delete(pair)) return;
        this.closed.push(pair);
        front.destroy();
        back.destroy();
      };
      front.once('close', cleanup);
      back.once('close', cleanup);
    });
    this.endpoint = '';
  }
  static async start(port: number): Promise<ByteProxy> {
    const proxy = new ByteProxy(port);
    await new Promise<void>((accept, reject) => {
      proxy.server.once('error', reject);
      proxy.server.listen(0, '127.0.0.1', () => accept());
    });
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('Byte proxy listener failed');
    proxy.endpoint = `wss://127.0.0.1:${address.port}/`;
    return proxy;
  }
  snapshot() {
    const all = [...this.closed, ...this.pairs];
    const result = {
      connections: this.connections,
      clientToProxyBytes: 0,
      proxyToClientBytes: 0,
      proxyToRelayBytes: 0,
      relayToProxyBytes: 0,
      totalPhysicalBytes: 0,
      relaySideBytes: 0,
    };
    for (const pair of all) {
      result.clientToProxyBytes += pair.front.bytesRead;
      result.proxyToClientBytes += pair.front.bytesWritten;
      result.proxyToRelayBytes += pair.back.bytesWritten;
      result.relayToProxyBytes += pair.back.bytesRead;
    }
    result.relaySideBytes = result.proxyToRelayBytes + result.relayToProxyBytes;
    result.totalPhysicalBytes = result.clientToProxyBytes + result.proxyToClientBytes + result.relaySideBytes;
    return result;
  }
  async stop(): Promise<void> {
    for (const pair of this.pairs) {
      pair.front.destroy();
      pair.back.destroy();
    }
    if (this.server.listening) await new Promise<void>(accept => this.server.close(() => accept()));
  }
}

class ResourceRelay {
  readonly child: ChildProcess;
  readonly token = randomBytes(32).toString('base64url');
  readonly ready: Promise<void>;
  descriptor!: RelayDescriptorV1;
  endpoint!: string;
  port!: number;
  readySample: any;
  private nextId = 0;
  private pending = new Map<number, { accept: (value: any) => void; reject: (error: Error) => void }>();
  private exited: Promise<void>;
  private stderr = '';
  private telemetry: any[] = [];
  constructor(readonly index: number, readonly rssSampleIntervalMs = 250) {
    const fixture = fileURLToPath(new URL('./fixtures/client-held-resource-relay.ts', import.meta.url));
    this.child = fork(fixture, [], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        RESONANCE_RESOURCE_RELAY: JSON.stringify({
          persistDir: join(root, `relay-${index}`),
          rssSampleIntervalMs,
        }),
        RESONANCE_RESOURCE_TOKEN: this.token,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.stderr?.on('data', chunk => { this.stderr += String(chunk); });
    this.exited = new Promise<void>((accept, reject) => {
      this.child.once('exit', (code, signal) => (
        code === 0 && signal === null ? accept() : reject(this.exitError(code, signal))
      ));
    });
    this.ready = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`Relay ${index} startup timeout: ${this.stderr}`)), 60_000);
      this.child.on('message', (message: any) => {
        if (message.event === 'ready') {
          clearTimeout(timer);
          this.descriptor = message.descriptor;
          this.endpoint = message.descriptor.endpoints[0];
          this.port = message.port;
          this.readySample = message.sample;
          this.rememberSample(message.sample);
          accept();
        } else if (message.event === 'failed') {
          clearTimeout(timer);
          reject(new Error(message.error));
        } else if (typeof message.id === 'number') {
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error));
          else request.accept(message.result);
        }
      });
      this.child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const error = this.exitError(code, signal);
        reject(error);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      });
    });
  }
  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    return new Error(`Relay ${this.index} exited (code=${code}, signal=${signal}): ${this.stderr}`);
  }
  static async start(index: number, rssSampleIntervalMs = 250): Promise<ResourceRelay> {
    const relay = new ResourceRelay(index, rssSampleIntervalMs);
    await relay.ready;
    return relay;
  }
  rememberSample(sample: any): void {
    this.telemetry.push({
      atMicros: Math.floor((performance.timeOrigin + performance.now()) * 1000),
      ...sample,
      rpc: rpcTelemetry.snapshot(this.index),
    });
    if (this.telemetry.length > 30) this.telemetry.shift();
  }
  contentionSnapshot() {
    return this.telemetry.map(sample => ({ ...sample }));
  }
  request(command: string): Promise<any> {
    const id = ++this.nextId;
    return new Promise((accept, reject) => {
      this.pending.set(id, { accept, reject });
      this.child.send({ id, command, token: this.token });
    });
  }
  async stop(): Promise<any> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return undefined;
    const result = await this.request('stop');
    this.child.send({ command: 'exit', token: this.token });
    await this.exited;
    return result;
  }
}

interface OperationRecord {
  sequence: number;
  kind: 'publish' | 'search' | 'mailbox';
  connectionClass: 'cold' | 'reconnecting' | 'warm-client-new-TCP';
  outcome: 'good' | 'refused' | 'retry' | 'uncertain' | 'deadline_exceeded' | 'inconclusive';
  latencyMs: number;
  errorClass?: string;
  validationDetails?: SearchValidationError['failure'];
  relayEvidence?: RelayAttemptEvidence[];
  reconciliationEvidence?: unknown[];
  contention?: unknown;
  phases?: Record<string, number>;
}

function errorClass(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('rate_limited')) return 'rate_limited';
  if (message.includes('timeout') || message.includes('deadline')) return 'timeout';
  if (message.includes('closed before answering') || message.includes('closed')) return 'connection_closed';
  if (message.includes('admission')) return 'admission_refused';
  return message.slice(0, 120);
}

class Coordinator {
  clients: ClientHeldRelayClient[] = [];
  reconnects = 0;
  constructor(readonly id: number, readonly relays: ResourceRelay[], readonly proxies: ByteProxy[]) {}
  connect(): void {
    this.disconnect();
    this.clients = this.proxies.map(proxy => createRelayClient({
      relayUrl: proxy.endpoint,
      admissionCapabilityProvider: admissionProvider,
    }));
  }
  disconnect(): void {
    for (const client of this.clients) client.disconnect();
    this.clients = [];
  }
  reconnect(): void {
    this.reconnects++;
    this.connect();
  }
}

function makeClients(count: number, relays: ResourceRelay[], proxies: ByteProxy[][]): Coordinator[] {
  return Array.from({ length: count }, (_, id) => {
    const coordinator = new Coordinator(id, relays, proxies[id]);
    coordinator.connect();
    return coordinator;
  });
}

async function discover(relays: ResourceRelay[]): Promise<void> {
  for (const relay of relays) {
    const discovered = await discoverRelayContactV1(createRelayContactHintV1('configured', relay.endpoint));
    if (discovered.responder.relayId !== relay.descriptor.relayId) throw new Error('Discovery identity mismatch');
  }
}

interface RelayAttemptEvidence {
  relayIndex: number;
  outcome: 'ok' | 'error';
  status?: string;
  reason: string;
  reconciliationRequired?: boolean;
}

class PublishFailure extends Error {
  constructor(
    readonly acknowledgments: RelayAttemptEvidence[],
    readonly reconciliationEvidence: unknown[],
  ) {
    super('publish_refused');
  }
}

async function reconcileUncertainty(
  coordinator: Coordinator,
  relayIndex: number,
  state: ActiveFixtureState,
): Promise<unknown[]> {
  const evidence: unknown[] = [];
  for (const publicationId of state.uncertainPublicationIds()) {
    try {
      const createdAt = Date.now();
      const bytes = await rpcTelemetry.measure(relayIndex, 'lookup', () => (
        coordinator.clients[relayIndex].lookupLeasedIndex(createLeasedIndexLookupRequestV1({
          publicationId, createdAt, expiresAt: createdAt + 10_000,
        }, generateSigningKeyPair()))
      ));
      if (!bytes) {
        evidence.push({ publicationId, status: 'unresolved', reason: 'current_not_found' });
        continue;
      }
      const operation = parseLeasedIndexOperationV1(bytes);
      if (operation.kind !== 'leased-discovery-index') {
        evidence.push({ publicationId, status: 'unresolved', reason: 'current_not_active' });
        continue;
      }
      evidence.push(reconcileFixtureWithCurrent(state, operation, Date.now()));
    } catch (error) {
      evidence.push({ publicationId, status: 'unresolved', reason: errorClass(error) });
    }
  }
  if (evidence.some(item => (item as any).status === 'reconciled')) {
    state.replaceWith(reconstructRelayFixtureState(
      join(root, `relay-${relayIndex}`, 'client-held'), state.allOperations(), Date.now, new Map(),
    ));
    evidence.push({
      status: 'order_reconstructed',
      proof: 'complete relay oracle rebuilt once from the persisted incremental log in actual commit order',
    });
  }
  return evidence;
}

async function submitPublishBytes(
  coordinator: Coordinator,
  operation: LeasedIndexV1,
  states: ActiveFixtureState[],
  attempts: FixedWindowAttempt[],
  reconciliationEvidence: unknown[] = [],
): Promise<RelayAttemptEvidence[]> {
  const operationBytes = JSON.stringify(operation);
  const acknowledgments: RelayAttemptEvidence[] = [];
  await Promise.all(coordinator.clients.map(async (client, relayIndex) => {
    attempts.push({
      bucket: `${RETRY_SOURCE_BUCKET}:relay-${relayIndex}`,
      timestamp: Date.now(),
    });
    let acknowledgment: RelayAttemptEvidence;
    try {
      const value = await rpcTelemetry.measure(relayIndex, 'publish', () => (
        client.submitLeasedIndexOperation(operationBytes)
      ));
      acknowledgment = {
        relayIndex,
        outcome: value.status === 'ok' ? 'ok' : 'error',
        status: value.status,
        reason: value.message ?? value.status,
      };
    } catch (error) {
      const reason = errorClass(error);
      acknowledgment = {
        relayIndex,
        outcome: 'error',
        reason,
        ...(reason === 'timeout' || reason === 'connection_closed'
          ? { reconciliationRequired: true }
          : {}),
      };
    }
    acknowledgments.push(acknowledgment);
    advanceFixtureOnAcknowledgment(states[relayIndex], operation, acknowledgment);
  }));
  for (let relayIndex = 0; relayIndex < states.length; relayIndex++) {
    if (states[relayIndex].hasPendingUncertainty()) {
      reconciliationEvidence.push(...await reconcileUncertainty(coordinator, relayIndex, states[relayIndex]));
    }
  }
  if (acknowledgments.some(result => result.outcome !== 'ok')) {
    throw new PublishFailure(acknowledgments, reconciliationEvidence);
  }
  return acknowledgments;
}

async function runPublish(
  coordinator: Coordinator,
  record: SeedRecord,
  manifest: SeedManifest,
  states: ActiveFixtureState[],
  attempts: FixedWindowAttempt[],
  reconciliationEvidence: unknown[] = [],
) {
  const refreshed = createLeasedIndexV1({
    leaseSequence: record.index.leaseSequence + 1,
    semanticRevision: record.index.semanticRevision,
    groupId: record.index.groupId,
    itemType: record.index.itemType,
    derivationId: record.index.derivationId,
    fingerprintEpoch: record.index.fingerprint.epoch,
    fingerprint: decodeBase64(record.index.fingerprint.value),
    originalCommitment: record.index.original.commitment,
    createdAt: manifest.refreshCreatedAt,
    expiresAt: manifest.refreshExpiresAt,
  }, record.keys);
  const operationBytes = JSON.stringify(refreshed);
  const acknowledgments = await submitPublishBytes(coordinator, refreshed, states, attempts, reconciliationEvidence);
  return { operation: refreshed, operationBytes, acknowledgments, reconciliationEvidence };
}

async function runSearch(
  coordinator: Coordinator,
  sequence: number,
  expected: SeedRecord,
  states: ActiveFixtureState[],
): Promise<void> {
  const relayIndex = sequence % REPLICAS;
  const state = states[relayIndex];
  if (state.hasPendingUncertainty()) throw new ValidationInconclusiveError();
  const request = createLeasedIndexSearchRequestV1({
    groupId: 'public',
    itemType: 'offer',
    fingerprintEpoch: 'epoch-1',
    fingerprint: decodeBase64(expected.index.fingerprint.value),
    limit: 10,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  }, generateSigningKeyPair());
  const results = await rpcTelemetry.measure(relayIndex, 'search', () => (
    coordinator.clients[relayIndex].searchLeasedIndexes(request)
  ));
  const expectedGenerationId = state.currentGenerationId(expected.index.publicationId);
  if (!expectedGenerationId) throw new Error('search_expected_inactive');
  validateSearchResults({
    request,
    results,
    state,
    expectedPublicationId: expected.index.publicationId,
    expectedGenerationId,
    now: Date.now(),
  });
}

async function runMailbox(
  coordinator: Coordinator,
  record: SeedRecord,
  mailbox: MailboxState,
  sequence: number,
): Promise<Record<string, number>> {
  const phases: Record<string, number> = {};
  let phaseStarted = performance.now();
  const mark = (name: string) => {
    phases[name] = performance.now() - phaseStarted;
    phaseStarted = performance.now();
  };
  const store = mailbox.current();
  store.retainGeneration(record.index, record.keys);
  mark('localRetainMs');
  const relayIds = coordinator.relays.slice(0, 3).map(relay => relay.descriptor.relayId);
  const value = store.createDeposit({
    index: record.index,
    requestNonce: Uint8Array.from(new Uint8Array(16).map((_, index) => (sequence + index) % 251)),
    payload: 'DEC-023 bounded mailbox measurement',
    replyCapability: 'reply-capability',
    createdAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    admission: LOCAL_ADMISSION,
    selectedRelayIds: relayIds,
  });
  mark('localCreateMs');
  const receipts = await Promise.all(coordinator.clients.slice(0, 3).map((client, relayIndex) => (
    rpcTelemetry.measure(relayIndex, 'mailbox-deposit', () => client.depositOfflineDiscovery(value.depositBytes))
  )));
  mark('depositNetworkMs');
  if (receipts.some(receipt => receipt.status !== 'stored' || !receipt.receipt)) {
    throw new Error(`mailbox_deposit_refused:${receipts.map(receipt => receipt.status).join(',')}`);
  }
  for (const receipt of receipts) store.recordReceipt(value.requestId, receipt.receipt!);
  if (store.listOutbox().at(-1)?.state !== 'queued') throw new Error('mailbox_not_queued_after_three_receipts');
  const fetch = createOfflineFetchRequestV1({
    index: record.index,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  }, record.keys);
  mark('localReceiptPersistenceMs');
  const deposits = await rpcTelemetry.measure(0, 'mailbox-fetch', () => (
    coordinator.clients[0].fetchOfflineDiscovery(fetch)
  ));
  mark('fetchNetworkMs');
  if (deposits.length !== 1 || deposits[0] !== value.depositBytes) throw new Error('mailbox_fetch_mismatch');
  const received = store.receive(deposits[0], Date.now());
  mark('localReceiveMs');
  await Promise.all(coordinator.clients.slice(0, 3).map((client, relayIndex) => (
    rpcTelemetry.measure(relayIndex, 'mailbox-ack', () => client.acknowledgeOfflineDiscovery(received.ackBytes))
  )));
  mark('acknowledgeNetworkMs');
  store.markAcknowledged(received.ackBytes);
  store.recordGenerationAck(value.requestId, received.ackBytes);
  if (store.listOutbox().at(-1)?.state !== 'acknowledged') throw new Error('mailbox_not_acknowledged');
  mark('localAcknowledgePersistenceMs');
  return phases;
}

interface AcknowledgedPublish {
  sequence: number;
  coordinatorId: number;
  operation: LeasedIndexV1;
  operationBytes: string;
  acknowledgments: RelayAttemptEvidence[];
  completedAt: number;
}

async function executeOperation(
  coordinator: Coordinator,
  record: OperationRecord,
  records: SeedRecord[],
  manifest: SeedManifest,
  mailbox: MailboxState,
  states: ActiveFixtureState[],
  acknowledgedPublishes: AcknowledgedPublish[],
  publishAttempts: FixedWindowAttempt[],
): Promise<void> {
  const started = performance.now();
  try {
    const seed = records[(record.sequence + (runNumber - 1) * operationCount) % records.length];
    if (record.kind === 'publish') {
      const published = await runPublish(coordinator, seed, manifest, states, publishAttempts);
      record.relayEvidence = published.acknowledgments;
      record.reconciliationEvidence = published.reconciliationEvidence;
      acknowledgedPublishes.push({
        sequence: record.sequence,
        coordinatorId: coordinator.id,
        operation: published.operation,
        operationBytes: published.operationBytes,
        acknowledgments: published.acknowledgments,
        completedAt: Date.now(),
      });
    } else if (record.kind === 'search') await runSearch(coordinator, record.sequence, seed, states);
    else record.phases = await runMailbox(coordinator, seed, mailbox, record.sequence);
    record.latencyMs = performance.now() - started;
    record.outcome = record.latencyMs > TARGETS.privateOperationMs ? 'deadline_exceeded' : 'good';
    attachDeadlineContention(record, coordinator.relays);
  } catch (error) {
    if (error instanceof PublishFailure) {
      record.relayEvidence = error.acknowledgments;
      record.reconciliationEvidence = error.reconciliationEvidence;
    }
    if (error instanceof SearchValidationError) record.validationDetails = error.failure;
    record.latencyMs = performance.now() - started;
    record.errorClass = errorClass(error);
    if (error instanceof PublishFailure || record.errorClass === 'timeout' || record.errorClass === 'connection_closed') {
      attachOperationContention(record, coordinator.relays);
    }
    record.outcome = error instanceof ValidationInconclusiveError
      ? 'inconclusive'
      : record.errorClass === 'timeout' || record.errorClass === 'connection_closed'
        ? 'uncertain'
        : 'refused';
  }
}

function contentChannels(ownerKeys: LeasedIndexKeyMaterialV1, requesterKeys: LeasedIndexKeyMaterialV1,
  owner: ContentGrantStore, requester: ContentGrantStore) {
  const ownerRelationship = generateRelationshipKeyMaterial();
  const requesterRelationship = generateRelationshipKeyMaterial();
  const channelId = createPairwiseChannelId(
    `match_${'M'.repeat(43)}`,
    ownerRelationship.relationshipId,
    requesterRelationship.relationshipId,
  );
  owner.registerChannel({
    channelId,
    localPublicationId: ownerKeys.publicationId,
    partnerPublicationId: requesterKeys.publicationId,
    localRelationshipKeys: ownerRelationship,
    publicationKeys: ownerKeys,
    partnerRelationshipId: requesterRelationship.relationshipId,
    partnerRelationshipKey: Buffer.from(requesterRelationship.signingKeyPair.publicKey).toString('base64'),
    sharedKey: deriveSharedSecret(ownerRelationship.channelKeyPair.secretKey, requesterRelationship.channelKeyPair.publicKey),
  });
  requester.registerChannel({
    channelId,
    localPublicationId: requesterKeys.publicationId,
    partnerPublicationId: ownerKeys.publicationId,
    localRelationshipKeys: requesterRelationship,
    publicationKeys: requesterKeys,
    partnerRelationshipId: ownerRelationship.relationshipId,
    partnerRelationshipKey: Buffer.from(ownerRelationship.signingKeyPair.publicKey).toString('base64'),
    sharedKey: deriveSharedSecret(requesterRelationship.channelKeyPair.secretKey, ownerRelationship.channelKeyPair.publicKey),
  });
  return { channelId, ownerRelationship, requesterRelationship };
}

async function runContentMeasurements(coordinator: Coordinator, localRoot: string) {
  const ownerKeys = generateLeasedIndexKeyMaterialV1();
  const requesterKeys = generateLeasedIndexKeyMaterialV1();
  const original = new TextEncoder().encode('DEC-023 separate online-content measurement');
  const commitmentKey = generateOriginalCommitmentKeyV1();
  const index = createLeasedIndexV1({
    groupId: 'public', itemType: 'offer', derivationId: 'dec023-content-v1', fingerprintEpoch: 'epoch-1',
    fingerprint: fingerprint(1), originalCommitment: createOriginalCommitmentV1(original, commitmentKey),
    createdAt: Date.now() - 1_000, expiresAt: Date.now() + DAY,
  }, ownerKeys);
  const owner = ContentGrantStore.open({ path: join(localRoot, 'content-owner.json'), encryptionKey: randomBytes(32) });
  const requester = ContentGrantStore.open({ path: join(localRoot, 'content-requester.json'), encryptionKey: randomBytes(32) });
  const latencies: number[] = [];
  const errors: string[] = [];
  let failures = 0;
  try {
    const channel = contentChannels(ownerKeys, requesterKeys, owner, requester);
    owner.retainOriginal(index, original, commitmentKey);
    for (let iteration = 0; iteration < 4; iteration++) {
      const started = performance.now();
      try {
        const requestCreatedAt = Date.now();
        const requestExpiresAt = requestCreatedAt + 10_000;
        const requestId = requester.createRequest({
          channelId: channel.channelId, index, createdAt: requestCreatedAt, expiresAt: requestExpiresAt,
        });
        const operation = requester.prepareRequest(requestId).operationBytes;
        const ownerPoll = coordinator.clients[0].pollContent(createContentPollRequestV1({
          channelId: channel.channelId, createdAt: Date.now(), expiresAt: Date.now() + 10_000,
        }, channel.ownerRelationship));
        await new Promise(resolve => setTimeout(resolve, 30));
        await coordinator.clients[0].sendContentOperation(operation);
        owner.receiveRequest(await ownerPoll, Date.now());
        const grant = owner.grantRequest({ requestId, createdAt: Date.now(), expiresAt: requestExpiresAt });
        const response = owner.prepareResponse(grant.grantId!).operationBytes;
        const requesterPoll = coordinator.clients[0].pollContent(createContentPollRequestV1({
          channelId: channel.channelId, createdAt: Date.now(), expiresAt: Date.now() + 10_000,
        }, channel.requesterRelationship));
        await new Promise(resolve => setTimeout(resolve, 30));
        await coordinator.clients[0].sendContentOperation(response);
        requester.receiveResponse(await requesterPoll, Date.now());
        if (new TextDecoder().decode(requester.receivedContent(requestId)) !== 'DEC-023 separate online-content measurement') {
          throw new Error('Content mismatch');
        }
        latencies.push(performance.now() - started);
      } catch (error) {
        failures++;
        errors.push(errorClass(error));
      }
    }
  } finally {
    owner.close();
    requester.close();
  }
  return { submitted: 4, good: latencies.length, failures, errors, warmPollConnections: 8, latency: latencySummary(latencies) };
}

async function runLoad(profile: string) {
  if (profile !== 'nominal' && profile !== 'burst8') throw new Error('Profile must be nominal or burst8');
  const concurrency = profile === 'nominal' ? 2 : 8;
  const localRoot = join(root, `local-${profile}-${runNumber}-${process.pid}`);
  mkdirSync(localRoot, { recursive: true });
  const startupStarted = performance.now();
  const startupAllocation: any[] = [{ stage: 'module-entry', elapsedMs: 0, memory: moduleEntryParentMemory }];
  const parentTelemetry: any[] = [];
  const captureParent = (stage: string) => {
    const sample = {
      stage,
      atMicros: Math.floor((performance.timeOrigin + performance.now()) * 1000),
      elapsedMs: performance.now() - startupStarted,
      memory: memorySample(),
      ...runtimeTelemetry.sample(),
    };
    parentTelemetry.push(sample);
    if (parentTelemetry.length > 30) parentTelemetry.shift();
    return sample;
  };
  const { manifest, records } = loadSeed();
  startupAllocation.push(captureParent('seed-loaded'));
  const canonicalOperations = new Map<string, LeasedIndexV1>();
  const fixtureOperations = records.map(record => record.index);
  const fixtureStates = Array.from({ length: REPLICAS }, (_, relayIndex) => (
    reconstructRelayFixtureState(
      join(root, `relay-${relayIndex}`, 'client-held'), fixtureOperations, Date.now, canonicalOperations,
    )
  ));
  startupAllocation.push(captureParent('oracle-reconstructed'));
  const acknowledgedPublishes: AcknowledgedPublish[] = [];
  const publishAttempts: FixedWindowAttempt[] = [];
  const publishScheduler = new FixedWindowOfferScheduler();
  const offeredPublishWaitsMs: number[] = [];
  const relays: ResourceRelay[] = [];
  let initialStats: any[] = [];
  const proxies: ByteProxy[][] = [];
  const coordinators: Coordinator[] = [];
  const mailboxes: MailboxState[] = [];
  let monitor: ReturnType<typeof setInterval> | undefined;
  let peakAggregateRss = process.memoryUsage().rss;
  try {
    for (let index = 0; index < REPLICAS; index++) relays.push(await ResourceRelay.start(index));
    const readyParent = captureParent('relay-ready');
    startupAllocation.push(readyParent);
    const postLoadReadyPeakSumBytes = readyParent.memory.rssBytes + relays.reduce(
      (sum, relay) => sum + relay.readySample.rssPeakBytes, 0,
    );
    peakAggregateRss = Math.max(peakAggregateRss, postLoadReadyPeakSumBytes);
    initialStats = await Promise.all(relays.map(relay => relay.request('stats')));
    for (const stats of initialStats) {
      if (stats.leasedActivePublications !== publicationCount) {
        throw new Error(`Reference load mismatch: ${stats.leasedActivePublications}/${publicationCount}`);
      }
    }
    for (let id = 0; id < concurrency; id++) {
      const row = await Promise.all(relays.map(relay => ByteProxy.start(relay.port)));
      proxies.push(row);
    }
    measurementStage = 'discovery';
    await discover(relays);
    measurementStage = 'load';
    for (let id = 0; id < concurrency; id++) {
      const coordinator = new Coordinator(id, relays, proxies[id]);
      coordinator.connect();
      coordinators.push(coordinator);
      mailboxes.push(new MailboxState(localRoot, id));
    }
    const initialSamples = await Promise.all(relays.map(relay => relay.request('sample')));
    for (let index = 0; index < relays.length; index++) relays[index].rememberSample(initialSamples[index]);
    captureParent('load-start');
    const initialCpu = initialSamples.reduce((sum, sample) => sum + sample.cpuMicros, 0) + process.cpuUsage().user + process.cpuUsage().system;
    monitor = setInterval(async () => {
      try {
        const samples = await Promise.all(relays.map(relay => relay.request('sample')));
        for (let index = 0; index < relays.length; index++) relays[index].rememberSample(samples[index]);
        captureParent('load');
        peakAggregateRss = Math.max(peakAggregateRss,
          process.memoryUsage().rss + samples.reduce((sum, sample) => sum + sample.rssBytes, 0));
      } catch { /* Final relay exit reports the defect. */ }
    }, 1_000);
    monitor.unref();
    const operationRecords: OperationRecord[] = [];
    let next = 0;
    const started = performance.now();
    const execute = async (sequence: number, coordinatorId: number) => {
      const connectionClass = sequence < concurrency ? 'cold'
        : sequence > 0 && sequence % 251 < concurrency ? 'reconnecting' : 'warm-client-new-TCP';
      if (connectionClass === 'reconnecting') coordinators[coordinatorId].reconnect();
      const kind = (['publish', 'search', 'mailbox'] as const)[sequence % 3];
      const record: OperationRecord = {
        sequence, kind, connectionClass, outcome: 'refused', latencyMs: 0,
      };
      let completeOffer: (() => void) | undefined;
      if (kind === 'publish') {
        const scheduled = await publishScheduler.schedule(Array.from({ length: REPLICAS }, (_, relayIndex) => (
          `${RETRY_SOURCE_BUCKET}:relay-${relayIndex}`
        )));
        completeOffer = scheduled.complete;
        offeredPublishWaitsMs.push(scheduled.waitedMs);
      }
      operationRecords.push(record);
      try {
        await executeOperation(
          coordinators[coordinatorId], record, records, manifest, mailboxes[coordinatorId],
          fixtureStates, acknowledgedPublishes, publishAttempts,
        );
      } finally {
        completeOffer?.();
      }
    };
    if (profile === 'nominal') {
      await Promise.all(Array.from({ length: concurrency }, async (_, coordinatorId) => {
        while (next < operationCount) {
          const sequence = next++;
          if (sequence >= operationCount) break;
          await execute(sequence, coordinatorId);
        }
      }));
    } else {
      while (next < operationCount) {
        const batch = Array.from({ length: Math.min(concurrency, operationCount - next) }, () => next++);
        await Promise.all(batch.map((sequence, index) => execute(sequence, index)));
      }
    }
    const elapsedMs = performance.now() - started;
    const content = await runContentMeasurements(coordinators[0], localRoot);
    const original = acknowledgedPublishes.at(-1);
    let intentionalExactRetries = 0;
    let retryFailures = 0;
    let exactRetryEvidence: Record<string, unknown>;
    if (!original) {
      retryFailures++;
      exactRetryEvidence = { status: 'not_run', reason: 'no_fully_acknowledged_original' };
    } else {
      const waitStarted = performance.now();
      const relayCapacityWaitsMs = await Promise.all(Array.from({ length: REPLICAS }, (_, relayIndex) => (
        waitForQuietWindowRetryCapacity(
          publishAttempts, `${RETRY_SOURCE_BUCKET}:relay-${relayIndex}`,
        )
      )));
      const capacityWaitMs = performance.now() - waitStarted;
      const remainingAttempts = Array.from({ length: REPLICAS }, (_, relayIndex) => (
        attemptsInFixedWindow(
          publishAttempts, `${RETRY_SOURCE_BUCKET}:relay-${relayIndex}`, Date.now(),
        ).length
      )).reduce((sum, count) => sum + count, 0);
      intentionalExactRetries = 1;
      const retryStarted = performance.now();
      let replayAcknowledgments: RelayAttemptEvidence[] = [];
      const replayReconciliationEvidence: unknown[] = [];
      let replayError: string | undefined;
      try {
        replayAcknowledgments = await submitPublishBytes(
          coordinators[original.coordinatorId], original.operation, fixtureStates, publishAttempts,
          replayReconciliationEvidence,
        );
      } catch (error) {
        retryFailures++;
        replayError = errorClass(error);
        if (error instanceof PublishFailure) replayAcknowledgments = error.acknowledgments;
      }
      const latencyMs = performance.now() - retryStarted;
      operationRecords.push({
        sequence: operationCount,
        kind: 'publish',
        connectionClass: 'warm-client-new-TCP',
        outcome: 'retry',
        latencyMs,
        relayEvidence: replayAcknowledgments,
        ...(retryFailures ? { errorClass: 'exact_retry_failed' } : {}),
      });
      exactRetryEvidence = {
        status: retryFailures ? 'failed' : 'acknowledged',
        original: {
          sequence: original.sequence,
          coordinatorId: original.coordinatorId,
          completedAt: original.completedAt,
          acknowledgments: original.acknowledgments,
        },
        sourceBucket: RETRY_SOURCE_BUCKET,
        capacityWaitMs,
        relayCapacityWaitsMs,
        remainingAttemptsInWindow: remainingAttempts,
        replayAcknowledgments,
        replayReconciliationEvidence,
        ...(replayError ? { replayError } : {}),
      };
    }
    const invalidProvider: AdmissionCapabilityProviderV2 = Object.assign(
      (context: AdmissionCapabilityRequestContextV2): AdmissionCapabilityV2 => ({
        version: 2,
        kind: 'admission-capability',
        scheme: 'live-test-v1',
        issuer: 'community:test',
        token: 'A'.repeat(43),
        requestProof: digest(context.requestBinding),
      }),
      { assertMaintenanceDestination: () => {} },
    );
    const invalid = createRelayClient({ relayUrl: proxies[0][0].endpoint, admissionCapabilityProvider: invalidProvider });
    let failedAttempts = 0;
    try {
      await invalid.searchLeasedIndexes(createLeasedIndexSearchRequestV1({
        groupId: 'public', itemType: 'offer', fingerprintEpoch: 'epoch-1', fingerprint: fingerprint(0),
        limit: 1, createdAt: Date.now(), expiresAt: Date.now() + 10_000,
      }, generateSigningKeyPair()));
    } catch { failedAttempts++; }
    finally { invalid.disconnect(); }
    for (const coordinator of coordinators) coordinator.disconnect();
    await new Promise(accept => setTimeout(accept, 50));
    const finalStats = await Promise.all(relays.map(relay => relay.request('stats')));
    const finalSamples = finalStats.map(stats => stats.sample);
    for (let index = 0; index < relays.length; index++) relays[index].rememberSample(finalSamples[index]);
    captureParent('final-stats');
    const finalCpu = finalSamples.reduce((sum, sample) => sum + sample.cpuMicros, 0) + process.cpuUsage().user + process.cpuUsage().system;
    const proxyRows = proxies.flat().map(proxy => proxy.snapshot());
    const network = proxyRows.reduce((sum, row) => {
      for (const key of Object.keys(sum) as Array<keyof typeof sum>) sum[key] += row[key];
      return sum;
    }, {
      connections: 0, clientToProxyBytes: 0, proxyToClientBytes: 0,
      proxyToRelayBytes: 0, relayToProxyBytes: 0, totalPhysicalBytes: 0, relaySideBytes: 0,
    });
    const relayTrafficDeltas = finalStats.map((stats, index) => (
      stats.relay.transport_ingress_bytes + stats.relay.transport_egress_bytes
      - initialStats[index].relay.transport_ingress_bytes - initialStats[index].relay.transport_egress_bytes
    ));
    const proxyRelayBytes = proxies[0].map((_, relayIndex) => proxies.reduce((sum, row) => (
      sum + row[relayIndex].snapshot().relaySideBytes
    ), 0));
    const directDiscoveryBytes = relayTrafficDeltas.map((value, index) => value - proxyRelayBytes[index]);
    network.totalPhysicalBytes = network.clientToProxyBytes + network.proxyToClientBytes
      + relayTrafficDeltas.reduce((sum, value) => sum + value, 0);
    const coverageMismatches = relayTrafficDeltas.map((value, index) => (
      value - proxyRelayBytes[index] - directDiscoveryBytes[index]
    ));
    if (coverageMismatches.some(value => value !== 0)) {
      throw new Error(`Network coverage mismatch: ${JSON.stringify(coverageMismatches)}`);
    }
    for (const mailbox of mailboxes) mailbox.close();
    await Promise.all(proxies.flat().map(proxy => proxy.stop()));
    const stopSamples = await Promise.all(relays.map(relay => relay.stop()));
    const relayDiskEvents = stopSamples.map((sample, index) => sample?.diskEvents ?? finalStats[index].diskEvents);
    const disk = diskAccounting.reconcile(relayDiskEvents.flat());
    if (!disk.matchesActualFinalBytes) {
      throw new Error(`Disk event reconciliation mismatch: ${disk.finalBytes}/${disk.actualFinalBytes}`);
    }
    const finalIoSamples = stopSamples.map((sample, index) => sample ?? finalSamples[index]);
    const operations = summarizeOperations(operationRecords);
    const good = operations.good as number;
    const artifact = {
      schema_version: 1,
      authorization_id: 'DEC-023',
      qualification: qualificationShape ? 'local-quantitative-run' : 'development-smoke-not-qualification',
      profile,
      run: runNumber,
      command: command(),
      source: sourceIdentity(),
      seedData: seedDataIdentity(),
      environment: environment(),
      configuration: {
        retainedActivePublicationsPerRelay: publicationCount,
        replicaCount: REPLICAS,
        desiredReplicaCount: 5,
        minimumHealthyReplicaCount: 3,
        requestedLogicalOperations: operationCount,
        balance: 'publish/search/mailbox assigned round-robin 334/334/334 at the default 1002',
        concurrency,
        publishPhysicalCallsPerLogicalOperation: 5,
        mailboxDepositAndAckReplicas: 3,
        rateLimits: 'production defaults unchanged: publish 10/min, search 30/min, discovery 60/min, replica 120/min per source IP',
        prototypeQuotas: 'unchanged',
        protectedDecisionBudgetMs: 3000,
        privateOperationBudgetMs: 10000,
      },
      operations,
      achieved: {
        elapsedMs,
        submittedOperationsPerSecond: (operations.submitted as number) / (elapsedMs / 1000),
        goodOperationsPerSecond: good / (elapsedMs / 1000),
        reconnects: coordinators.reduce((sum, coordinator) => sum + coordinator.reconnects, 0),
        offeredPublishPacing: {
          scheduledPublishes: offeredPublishWaitsMs.length,
          scheduledRelayReservations: publishScheduler.snapshot().length,
          capacityWaitMs: offeredPublishWaitsMs.reduce((sum, value) => sum + value, 0),
          maximumCapacityWaitMs: offeredPublishWaitsMs.length ? Math.max(...offeredPublishWaitsMs) : 0,
          sourceBucketLimit: 10,
          sourceBucketWindowMs: 60_000,
          includedInOperationLatency: false,
          fullWindowWaitsForCompletionAndQuietReset: true,
          exactReplayUsesSeparateSubmissionAccounting: true,
        },
        mailboxPhaseProfile: operationPhaseSummary(operationRecords),
        intentionalExactRetries,
        exactRetryFailures: retryFailures,
        exactRetryEvidence,
        intentionalFailedAdmissionAttempts: failedAttempts,
        lateExactRetryPromotedToGood: 0,
      },
      content,
      network: {
        ...network,
        bytesPerGoodOperation: good ? network.totalPhysicalBytes / good : null,
        relayTrafficDeltas,
        proxyRelayBytes,
        directDiscoveryBytes,
        coverageMismatches,
        coverage: 'all client-proxy and proxy-relay TCP directions plus directly metered discovery, including WSS handshake/TLS records, admission-bearing RPC, five-replica refresh, mailbox, retry and failed attempts',
        exclusions: 'IPC is not a physical network edge; no separate issuer/witness/policy service was contacted; direct persisted seed generation has no network traffic',
      },
      contention: {
        bounds: {
          recentSamplesPerRelay: 30,
          persistenceSpansPerSample: 32,
          gcEntriesPerSample: 128,
          completedRpcEntries: 256,
        },
        parent: parentTelemetry,
        rpc: rpcTelemetry.snapshot(),
        relays: finalIoSamples.map((sample, relayIndex) => ({
          relayIndex,
          eventLoopDelay: sample.eventLoopDelay,
          gc: sample.gc,
          persistenceSpans: sample.persistenceSpans,
          persistenceDroppedEntries: sample.persistenceDroppedEntries,
        })),
      },
      processTree: {
        peakAggregateRssBytes: peakAggregateRss,
        postLoadReadyPeakSumBytes,
        preExecMeasurementAvailable: false,
        startup: relays.map(relay => ({
          pid: relay.child.pid,
          moduleEntryRssBytes: relay.readySample.moduleEntryRssBytes,
          readyRssBytes: relay.readySample.rssBytes,
          readyPeakRssBytes: relay.readySample.rssPeakBytes,
          eventLoopDelay: relay.readySample.eventLoopDelay,
          gc: relay.readySample.gc,
          persistenceSpans: relay.readySample.persistenceSpans,
          persistenceDroppedEntries: relay.readySample.persistenceDroppedEntries,
        })),
        allocation: startupAllocation,
        finalAggregateRssBytes: process.memoryUsage().rss + finalSamples.reduce((sum, sample) => sum + sample.rssBytes, 0),
        parentRssBytes: process.memoryUsage().rss,
        relays: finalSamples,
        aggregateCpuSeconds: (finalCpu - initialCpu) / 1e6,
        rssSampleIntervalMs: 250,
        aggregateSampleIntervalMs: 1000,
      },
      disk: {
        method: 'synchronous filesystem-event deltas from module instrumentation through relay stop; no periodic recursive walks',
        baselineBytes: disk.baselineBytes,
        finalBytes: disk.finalBytes,
        actualFinalBytes: disk.actualFinalBytes,
        finalReconciliationPass: disk.matchesActualFinalBytes,
        eventOrderedPeakBytes: disk.eventOrderedPeakBytes,
        peakLowerBoundBytes: disk.peakLowerBoundBytes,
        peakUpperBoundBytes: disk.peakUpperBoundBytes,
        eventCount: disk.eventCount,
        operationCounts: disk.operationCounts,
        processes: stopSamples.map((sample, index) => ({
          pid: relays[index].child.pid,
          ...(sample?.disk ?? finalStats[index].disk),
        })),
        fsyncAndWrites: {
          parent: { ...localIo },
          relays: finalIoSamples.map(sample => ({
            fsyncCount: sample.fsyncCount,
            fsyncMicros: sample.fsyncMicros,
            writeCount: sample.writeCount,
            writeBytes: sample.writeBytes,
            renameCount: sample.renameCount,
          })),
        },
      },
      limitations: [
        'One macOS host; loopback WSS only, no external deployment or packet impairment.',
        'The 10000-publication reference was generated once with the real LeasedIndexStore and copied into five replica directories before listener startup; initialization network is therefore zero and excluded from operation traffic.',
        'Direct RPC uses a fresh TCP connection per operation. Warm-client-new-TCP is not a persistent connection; only the separately reported content polls are warm connections.',
        'Latency percentiles are conditional on good operations. Refusals, timeouts and uncertain outcomes remain failures in the success denominator.',
        'Original operation outcomes are never relabeled by reconciliation; searches remain inconclusive until exact-current production replay clears every uncertainty.',
        'Runtime telemetry retention is bounded as recorded; totals are cumulative where provided, retained entries are recent windows, and dropped-entry counters are explicit.',
        'Disk accounting covers synchronous filesystem mutations through the instrumented parent and five relay fixture modules. Async fs APIs, streams, descriptors not opened through instrumented openSync, and changes by external/uninstrumented processes are not covered; a final real-walk mismatch fails the run.',
        'RSS begins at module entry and uses the ready sample for post-load startup peaks; pre-exec and dynamic-loader peaks are unavailable.',
        'No physical power samples were collected; CPU time is not watts.',
      ],
    };
    const name = qualificationShape
      ? `client-held-local-resource-${profile}-run-${runNumber}.json`
      : `client-held-local-resource-development-smoke-${profile}-run-${runNumber}.json`;
    const path = writeResult(name, artifact);
    console.log(JSON.stringify({ path, profile, run: runNumber, operations, elapsedMs, networkBytes: network.totalPhysicalBytes }, null, 2));
  } finally {
    if (monitor) clearInterval(monitor);
    for (const coordinator of coordinators) coordinator.disconnect();
    for (const mailbox of mailboxes) mailbox.close();
    await Promise.allSettled(proxies.flat().map(proxy => proxy.stop()));
    await Promise.allSettled(relays.map(relay => relay.stop()));
  }
}

async function seed(): Promise<void> {
  const paths = seedPaths();
  if (existsSync(paths.manifest)) {
    const existing = JSON.parse(readFileSync(paths.manifest, 'utf8')) as SeedManifest;
    if (existing.publicationCount !== publicationCount) {
      throw new Error(`Existing seed has ${existing.publicationCount}; requested ${publicationCount}`);
    }
    console.log(JSON.stringify({ retainedSeed: root, publicationCount }, null, 2));
    return;
  }
  mkdirSync(root, { recursive: true });
  const createdAt = Date.now() - 6 * DAY;
  const expiresAt = createdAt + 7 * DAY;
  const store = new LeasedIndexStore();
  const records: any[] = [];
  let accepted = 0;
  const started = performance.now();
  for (let index = 0; index < publicationCount; index++) {
    const keys = generateLeasedIndexKeyMaterialV1();
    const record = createLeasedIndexV1({
      leaseSequence: 0,
      semanticRevision: 0,
      groupId: 'public',
      itemType: 'need',
      derivationId: 'dec023-fixed-derivation-v1',
      fingerprintEpoch: 'epoch-1',
      fingerprint: fingerprint(index),
      originalCommitment: createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1()),
      createdAt,
      expiresAt,
    }, keys);
    const operationBytes = JSON.stringify(record);
    const result = store.apply(operationBytes, createdAt);
    if (result.status !== 'accepted') throw new Error(`Seed ${index} failed: ${result.status}`);
    accepted++;
    records.push({ keys: serializeKeys(keys), index: record, operationBytes });
    if ((index + 1) % 1000 === 0) console.error(`Seeded ${index + 1}/${publicationCount}`);
  }
  store.save(paths.reference);
  for (let replica = 0; replica < REPLICAS; replica++) {
    cpSync(paths.reference, join(root, `relay-${replica}`, 'client-held'), { recursive: true });
  }
  const manifest: SeedManifest = {
    publicationCount,
    createdAt,
    expiresAt,
    refreshCreatedAt: createdAt + DAY,
    refreshExpiresAt: createdAt + 8 * DAY,
  };
  writeFileSync(paths.manifest, JSON.stringify(manifest));
  writeFileSync(paths.records, JSON.stringify(records));
  const disk = diskAccounting.reconcile();
  if (!disk.matchesActualFinalBytes) {
    throw new Error(`Disk event reconciliation mismatch: ${disk.finalBytes}/${disk.actualFinalBytes}`);
  }
  const artifact = {
    schema_version: 1,
    authorization_id: 'DEC-023',
    qualification: qualificationShape ? 'reference-seed' : 'development-smoke-not-qualification',
    command: command(),
    source: sourceIdentity(),
    seedData: seedDataIdentity(),
    environment: environment(),
    requestedPublications: publicationCount,
    acceptedPublications: accepted,
    activeRecords: store.activeRecords(createdAt).length,
    replicasMaterialized: REPLICAS,
    elapsedMs: performance.now() - started,
    referenceBytes: directoryBytes(paths.reference),
    allReplicaBytes: disk.actualFinalBytes,
    disk: {
      method: 'synchronous filesystem-event deltas with final real-walk reconciliation',
      baselineBytes: disk.baselineBytes,
      finalBytes: disk.finalBytes,
      actualFinalBytes: disk.actualFinalBytes,
      finalReconciliationPass: disk.matchesActualFinalBytes,
      eventOrderedPeakBytes: disk.eventOrderedPeakBytes,
      peakLowerBoundBytes: disk.peakLowerBoundBytes,
      peakUpperBoundBytes: disk.peakUpperBoundBytes,
      eventCount: disk.eventCount,
      operationCounts: disk.operationCounts,
    },
    initializationNetworkBytes: 0,
    method: 'One real LeasedIndexStore persisted once, then exact signed-state copies materialized in five relay directories. Every measured operation uses actual WSS listeners and Node clients.',
  };
  const path = writeResult(qualificationShape
    ? 'client-held-local-resource-seed.json'
    : 'client-held-local-resource-development-smoke-seed.json', artifact);
  console.log(JSON.stringify({ path, ...artifact }, null, 2));
}

async function idle(): Promise<void> {
  const manifest = JSON.parse(readFileSync(seedPaths().manifest, 'utf8')) as SeedManifest;
  if (manifest.publicationCount !== publicationCount) throw new Error('Idle seed cardinality mismatch');
  const fixtureRssSampleIntervalMs = 250;
  const relays = await Promise.all(Array.from({ length: REPLICAS }, (_, index) => (
    ResourceRelay.start(index, fixtureRssSampleIntervalMs)
  )));
  const samples: any[] = [];
  let monitor: ReturnType<typeof setInterval> | undefined;
  let activeSample: Promise<void> | undefined;
  try {
    const initialStats = await Promise.all(relays.map(relay => relay.request('stats')));
    const initialLeasedActivePublications = initialStats.map(stats => stats.leasedActivePublications);
    for (const active of initialLeasedActivePublications) {
      if (active !== publicationCount) throw new Error('Idle reference cardinality mismatch');
    }
    const initialRelaySamples = await Promise.all(relays.map(relay => relay.request('sample')));
    const initialRelayCpuMicros = initialRelaySamples.map(sample => sample.cpuMicros);
    const startedParentCpu = process.cpuUsage();
    const initialParentCpuMicros = startedParentCpu.user + startedParentCpu.system;
    const started = performance.now();
    const measurementStartedAt = Date.now();
    if (manifest.expiresAt <= measurementStartedAt) throw new Error('Idle signed seed expires inside measurement window');
    let samplingError: unknown;
    const sample = async () => {
      const relaySamples = await Promise.all(relays.map(relay => relay.request('sample')));
      const parentRssBytes = process.memoryUsage().rss;
      const parentCpu = process.cpuUsage();
      const parentCpuMicros = parentCpu.user + parentCpu.system;
      samples.push({
        elapsedMs: performance.now() - started,
        parentRssBytes,
        parentCpuMicros,
        relayRssBytes: relaySamples.map(value => value.rssBytes),
        relayCpuMicros: relaySamples.map(value => value.cpuMicros),
        aggregateRssBytes: parentRssBytes + relaySamples.reduce((sum, value) => sum + value.rssBytes, 0),
        aggregateCpuMicros: parentCpuMicros + relaySamples.reduce((sum, value) => sum + value.cpuMicros, 0),
      });
    };
    const requestSample = () => {
      if (activeSample) return;
      activeSample = sample().catch(error => { samplingError = error; }).finally(() => { activeSample = undefined; });
    };
    await sample();
    monitor = setInterval(requestSample, 5_000);
    const remaining = idleSeconds * 1000 - (performance.now() - started);
    if (remaining > 0) await new Promise(accept => setTimeout(accept, remaining));
    if (monitor) clearInterval(monitor);
    if (activeSample) await activeSample;
    if (samplingError) throw samplingError;
    await sample();
    const elapsedMs = performance.now() - started;
    const measurementEndedAt = Date.now();
    const finalTimedSample = samples.at(-1);
    const finalStats = await Promise.all(relays.map(relay => relay.request('stats')));
    const finalLeasedActivePublications = finalStats.map(stats => stats.leasedActivePublications);
    for (const active of finalLeasedActivePublications) {
      if (active !== publicationCount) throw new Error('Idle final cardinality mismatch');
    }
    if (manifest.expiresAt <= measurementEndedAt) throw new Error('Idle signed seed expired during measurement window');
    const stopSamples = await Promise.all(relays.map(relay => relay.stop()));
    const relayDiskEvents = stopSamples.map((sample, index) => sample?.diskEvents ?? finalStats[index].diskEvents);
    const disk = diskAccounting.reconcile(relayDiskEvents.flat());
    if (!disk.matchesActualFinalBytes) {
      throw new Error(`Disk event reconciliation mismatch: ${disk.finalBytes}/${disk.actualFinalBytes}`);
    }
    const finalIoSamples = stopSamples.map((sample, index) => sample ?? finalStats[index].sample);
    const relayCpuSeconds = finalTimedSample.relayCpuMicros.map((value: number, index: number) => (
      (value - initialRelayCpuMicros[index]) / 1e6
    ));
    const parentCpuSeconds = (finalTimedSample.parentCpuMicros - initialParentCpuMicros) / 1e6;
    const cpuSeconds = parentCpuSeconds + relayCpuSeconds.reduce((sum: number, value: number) => sum + value, 0);
    const cardinalityStability = initialLeasedActivePublications.every((active: number) => active === publicationCount)
      && finalLeasedActivePublications.every((active: number) => active === publicationCount);
    const artifact = {
      schema_version: 1,
      authorization_id: 'DEC-023',
      qualification: qualificationShape && idleSeconds === 1800 ? 'bounded-30-minute-idle' : 'development-idle-not-qualification',
      command: command(),
      source: sourceIdentity(),
      seedData: seedDataIdentity(),
      environment: environment(),
      fixedActivePublicationsPerRelay: publicationCount,
      initialLeasedActivePublications,
      finalLeasedActivePublications,
      cardinalityStability,
      signedSeedExpiry: {
        expiresAt: manifest.expiresAt,
        measurementStartedAt,
        measurementEndedAt,
        expiresAfterMeasurementWindow: manifest.expiresAt > measurementEndedAt,
        marginAfterMeasurementMs: manifest.expiresAt - measurementEndedAt,
      },
      replicas: REPLICAS,
      requestedIdleSeconds: idleSeconds,
      achievedIdleSeconds: elapsedMs / 1000,
      sampleCount: samples.length,
      sampleIntervalMs: 5000,
      fixtureRssSampleIntervalMs,
      cpuSeconds,
      cpuAttribution: {
        parentCpuSeconds,
        relayCpuSeconds: relayCpuSeconds.reduce((sum: number, value: number) => sum + value, 0),
        relays: finalStats.map((stats, index) => ({ pid: stats.sample.pid, cpuSeconds: relayCpuSeconds[index] })),
      },
      idleCpuPercentOfOneCore: cpuSeconds / (elapsedMs / 1000) * 100,
      meanAggregateRssBytes: samples.reduce((sum, value) => sum + value.aggregateRssBytes, 0) / samples.length,
      peakAggregateRssBytes: Math.max(...samples.map(value => value.aggregateRssBytes)),
      peakPerRelayRssBytes: finalStats.map(stats => stats.sample.rssPeakBytes),
      disk: {
        method: 'synchronous filesystem-event deltas from module instrumentation through relay stop; no periodic recursive walks',
        baselineBytes: disk.baselineBytes,
        finalBytes: disk.finalBytes,
        actualFinalBytes: disk.actualFinalBytes,
        finalReconciliationPass: disk.matchesActualFinalBytes,
        growthBytes: disk.finalBytes - disk.baselineBytes,
        eventOrderedPeakBytes: disk.eventOrderedPeakBytes,
        peakLowerBoundBytes: disk.peakLowerBoundBytes,
        peakUpperBoundBytes: disk.peakUpperBoundBytes,
        eventCount: disk.eventCount,
        operationCounts: disk.operationCounts,
        processes: stopSamples.map((sample, index) => ({
          pid: relays[index].child.pid,
          ...(sample?.disk ?? finalStats[index].disk),
        })),
      },
      fsyncAndWrites: finalIoSamples,
      samples,
      physicalPower: 'not measured; no power samples; CPU seconds are not watts',
      limitations: [
        'No new user work; ordinary relay timers remained active. No external issuer, witness, policy, or relay-peer service was enrolled.',
        'Initial/final active-cardinality scans and stats are outside the timed CPU window; no per-sample active-record scans are performed.',
        'Disk accounting covers synchronous filesystem mutations through the instrumented parent and five relay fixture modules. Async fs APIs, streams, descriptors not opened through instrumented openSync, and changes by external/uninstrumented processes are not covered; a final real-walk mismatch fails the run.',
        'One loopback host; no production, deployment, power, or K/R acceptance.',
      ],
    };
    const path = writeResult(qualificationShape && idleSeconds === 1800
      ? 'client-held-local-resource-idle-1800s.json'
      : 'client-held-local-resource-development-idle.json', artifact);
    console.log(JSON.stringify({ path, elapsedMs, cpuSeconds, idleCpuPercent: artifact.idleCpuPercentOfOneCore }, null, 2));
  } finally {
    if (monitor) clearInterval(monitor);
    await Promise.allSettled(relays.map(relay => relay.stop()));
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function runVariation(values: number[]) {
  const average = mean(values);
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
    : 0;
  const halfWidth = values.length > 1 ? 4.302653 * Math.sqrt(variance / values.length) : null;
  return {
    runs: values,
    mean: average,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    range: Math.max(...values) - Math.min(...values),
    studentT95HalfWidth: halfWidth,
    studentT95Interval: halfWidth === null ? null : [average - halfWidth, average + halfWidth] as [number, number],
  };
}
function summarize(): void {
  const profiles: Record<string, unknown> = {};
  const artifacts: string[] = [];
  for (const profile of ['nominal', 'burst8']) {
    const runs = [1, 2, 3].map(run => {
      const name = `client-held-local-resource-${profile}-run-${run}.json`;
      const path = join(RESULT_DIR, name);
      if (!existsSync(path)) throw new Error(`Missing required run artifact: ${name}`);
      artifacts.push(name);
      return JSON.parse(readFileSync(path, 'utf8'));
    });
    const submitted = runs.reduce((sum, run) => sum + run.operations.submitted, 0);
    const good = runs.reduce((sum, run) => sum + run.operations.good, 0);
    const latencies = runs.map(run => run.operations.latency);
    const p95 = runVariation(latencies.map(value => value.p95Ms));
    const p99 = runVariation(latencies.map(value => value.p99Ms));
    const success = good / submitted;
    const bytes = runs.reduce((sum, run) => sum + run.network.totalPhysicalBytes, 0);
    const relayPeak = Math.max(...runs.flatMap(run => run.processTree.relays.map((relay: any) => relay.rssPeakBytes)));
    const intervalStraddles = (interval: [number, number] | null, target: number) => (
      interval !== null && interval[0] <= target && interval[1] >= target
    );
    const evaluation = {
      operationCountPass: submitted >= 1000 && runs.every(run => run.operations.submitted >= 1000),
      independentExecutionsPass: runs.length === 3,
      successPass: success >= TARGETS.minimumNominalSuccess,
      warmP95Pass: p95.maximum <= TARGETS.warmP95Ms && !intervalStraddles(p95.studentT95Interval, TARGETS.warmP95Ms),
      p99Pass: p99.maximum <= TARGETS.p99Ms && !intervalStraddles(p99.studentT95Interval, TARGETS.p99Ms),
      networkPass: bytes / good <= TARGETS.maximumBytesPerGoodOperation,
      relayRssPass: relayPeak <= TARGETS.maximumRelayRssBytes,
      processTreeRssPass: Math.max(...runs.map(run => run.processTree.peakAggregateRssBytes)) <= TARGETS.maximumApplicationRssBytes,
      networkCoveragePass: runs.every(run => run.network.coverageMismatches.every((value: number) => value === 0)),
      contentPass: runs.every(run => run.content.good === run.content.submitted && run.content.failures === 0),
      refusalFreePass: runs.every(run => run.operations.refused === 0 && run.operations.uncertain === 0 && run.operations.deadlineExceeded === 0),
    };
    profiles[profile] = {
      runs: runs.map(run => ({
        run: run.run,
        submitted: run.operations.submitted,
        good: run.operations.good,
        refused: run.operations.refused,
        retries: run.operations.retries,
        uncertain: run.operations.uncertain,
        inconclusive: run.operations.inconclusive,
        deadlineExceeded: run.operations.deadlineExceeded,
        latency: run.operations.latency,
        achieved: run.achieved,
        networkBytes: run.network.totalPhysicalBytes,
        peakAggregateRssBytes: run.processTree.peakAggregateRssBytes,
      })),
      totals: { submitted, good, successFraction: success, physicalNetworkBytes: bytes, bytesPerGoodOperation: bytes / good },
      runVariation: {
        p95Ms: p95,
        p99Ms: p99,
        throughputGoodPerSecond: runVariation(runs.map(run => run.achieved.goodOperationsPerSecond)),
      },
      maximumPerRelayRssBytes: relayPeak,
      evaluation,
      pass: Object.values(evaluation).every(Boolean),
    };
  }
  const seedName = 'client-held-local-resource-seed.json';
  artifacts.push(seedName);
  const seedArtifact = JSON.parse(readFileSync(join(RESULT_DIR, seedName), 'utf8'));
  const idleName = 'client-held-local-resource-idle-1800s.json';
  const idleArtifact = existsSync(join(RESULT_DIR, idleName))
    ? JSON.parse(readFileSync(join(RESULT_DIR, idleName), 'utf8'))
    : null;
  if (idleArtifact) artifacts.push(idleName);
  const receipt = {
    schema_version: 1,
    authorization_id: 'DEC-023',
    recorded_at: new Date().toISOString(),
    candidate_head: '56a593c plus uncommitted measurement harness identified by source hashes',
    source: sourceIdentity(),
    commands: [
      'NODE_EXTRA_CA_CERTS=packages/relay/src/__tests__/fixtures/tls/test-ca.crt node --import tsx packages/eval/src/client-held-local-resources.ts --mode seed',
      'NODE_EXTRA_CA_CERTS=packages/relay/src/__tests__/fixtures/tls/test-ca.crt node --import tsx packages/eval/src/client-held-local-resources.ts --mode run --profile nominal --run 1|2|3',
      'NODE_EXTRA_CA_CERTS=packages/relay/src/__tests__/fixtures/tls/test-ca.crt node --import tsx packages/eval/src/client-held-local-resources.ts --mode run --profile burst8 --run 1|2|3',
      'NODE_EXTRA_CA_CERTS=packages/relay/src/__tests__/fixtures/tls/test-ca.crt node --import tsx packages/eval/src/client-held-local-resources.ts --mode idle --idle-seconds 1800',
    ],
    environment: environment(),
    targets: TARGETS,
    reference: seedArtifact,
    profiles,
    idle: idleArtifact ? {
      achievedIdleSeconds: idleArtifact.achievedIdleSeconds,
      sampleCount: idleArtifact.sampleCount,
      initialLeasedActivePublications: idleArtifact.initialLeasedActivePublications,
      finalLeasedActivePublications: idleArtifact.finalLeasedActivePublications,
      cardinalityStability: idleArtifact.cardinalityStability,
      signedSeedExpiry: idleArtifact.signedSeedExpiry,
      sustainedCardinalityPass: idleArtifact.cardinalityStability === true
        && idleArtifact.signedSeedExpiry?.expiresAfterMeasurementWindow === true,
      cpuAttribution: idleArtifact.cpuAttribution,
      idleCpuPercentOfOneCore: idleArtifact.idleCpuPercentOfOneCore,
      idleCpuPass: idleArtifact.idleCpuPercentOfOneCore <= TARGETS.maximumIdleCpuPercentOfOneCore,
      meanAggregateRssBytes: idleArtifact.meanAggregateRssBytes,
      peakAggregateRssBytes: idleArtifact.peakAggregateRssBytes,
      physicalPower: idleArtifact.physicalPower,
    } : { status: 'not-run' },
    packetImpairment: 'not qualified; no below-TCP packet loss/retransmission profile was run',
    productionAcceptance: false,
    krAcceptance: false,
    limitations: [
      'Local macOS loopback evidence only; no external deployment, independent operators, or production/K/R acceptance.',
      'Seed initialization used real store persistence and exact replica copies, not network placement; all measured refresh traffic did use five actual relay listeners.',
      'No physical power measurement and no separate online issuer/witness/policy service measurement.',
      'Three runs on one host do not provide independent deployment/device/day samples.',
    ],
  };
  const receiptName = 'client-held-local-resource-qualification-receipt.json';
  writeResult(receiptName, receipt);
  const hashes = [...artifacts, receiptName].map(name => ({
    path: `delivery/results/${name}`,
    sha256: createHash('sha256').update(readFileSync(join(RESULT_DIR, name))).digest('hex'),
  }));
  console.log(JSON.stringify({ receipt: `delivery/results/${receiptName}`, artifacts: hashes, profiles, idle: receipt.idle }, null, 2));
  if (!Object.values(profiles).every((profile: any) => profile.pass)) process.exitCode = 1;
}

try {
  if (mode === 'seed') await seed();
  else if (mode === 'run') await runLoad(args.profile!);
  else if (mode === 'idle') await idle();
  else if (mode === 'summarize') summarize();
  else throw new Error(`Unknown mode: ${mode}`);
} catch (error) {
  const failure = {
    schema_version: 1,
    authorization_id: 'DEC-023',
    qualification: 'failed-no-substitution',
    mode,
    profile: args.profile,
    run: runNumber,
    command: command(),
    source: sourceIdentity(),
    environment: environment(),
    requested: { publicationCount, operationCount, idleSeconds, replicas: REPLICAS },
    stage: measurementStage,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  const path = writeResult(`client-held-local-resource-failure-${mode}-${args.profile}-run-${runNumber}.json`, failure);
  console.error(JSON.stringify({ failure: path, error: failure.error }, null, 2));
  process.exitCode = 1;
} finally {
  runtimeTelemetry.stop();
}
