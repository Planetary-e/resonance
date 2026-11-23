import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
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
  waitForQuietWindowRetryCapacity,
  type FixedWindowAttempt,
} from './client-held-retry-capacity.js';
import { MailboxState } from './client-held-mailbox-rotation.js';
import { reconstructRelayFixtureState } from './client-held-oracle-reconstruction.js';

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
  'packages/eval/src/client-held-mailbox-rotation.ts',
  'packages/eval/src/client-held-oracle-reconstruction.ts',
  'packages/eval/src/fixtures/client-held-resource-relay.ts',
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
function command() {
  return ['node', '--import', 'tsx', 'packages/eval/src/client-held-local-resources.ts', ...process.argv.slice(2)];
}
function writeResult(name: string, value: unknown): string {
  mkdirSync(RESULT_DIR, { recursive: true });
  const path = join(RESULT_DIR, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
function directoryBytes(path: string): number {
  let total = 0;
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); }
  catch { return 0; }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) {
      try { total += statSync(child).size; } catch { /* Concurrent replacement. */ }
    }
  }
  return total;
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
  private nextId = 0;
  private pending = new Map<number, { accept: (value: any) => void; reject: (error: Error) => void }>();
  private exited: Promise<void>;
  private stderr = '';
  constructor(readonly index: number) {
    const fixture = fileURLToPath(new URL('./fixtures/client-held-resource-relay.ts', import.meta.url));
    this.child = fork(fixture, [], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        RESONANCE_RESOURCE_RELAY: JSON.stringify({ persistDir: join(root, `relay-${index}`) }),
        RESONANCE_RESOURCE_TOKEN: this.token,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.stderr?.on('data', chunk => { this.stderr += String(chunk); });
    this.exited = new Promise<void>((accept, reject) => {
      this.child.once('exit', code => code === 0 ? accept() : reject(new Error(`Relay ${index} exited ${code}: ${this.stderr}`)));
    });
    this.ready = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`Relay ${index} startup timeout: ${this.stderr}`)), 60_000);
      this.child.on('message', (message: any) => {
        if (message.event === 'ready') {
          clearTimeout(timer);
          this.descriptor = message.descriptor;
          this.endpoint = message.descriptor.endpoints[0];
          this.port = message.port;
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
      this.child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Relay ${index} exited before ready (${code})`));
        for (const request of this.pending.values()) request.reject(new Error('Relay exited'));
        this.pending.clear();
      });
    });
  }
  static async start(index: number): Promise<ResourceRelay> {
    const relay = new ResourceRelay(index);
    await relay.ready;
    return relay;
  }
  request(command: string): Promise<any> {
    const id = ++this.nextId;
    return new Promise((accept, reject) => {
      this.pending.set(id, { accept, reject });
      this.child.send({ id, command, token: this.token });
    });
  }
  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { await this.request('stop'); } finally { await this.exited; }
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
  constructor(readonly acknowledgments: RelayAttemptEvidence[]) {
    super('publish_refused');
  }
}

async function submitPublishBytes(
  coordinator: Coordinator,
  operation: LeasedIndexV1,
  states: ActiveFixtureState[],
  attempts: FixedWindowAttempt[],
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
      const value = await client.submitLeasedIndexOperation(operationBytes);
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
  if (acknowledgments.some(result => result.outcome !== 'ok')) throw new PublishFailure(acknowledgments);
  return acknowledgments;
}

async function runPublish(
  coordinator: Coordinator,
  record: SeedRecord,
  manifest: SeedManifest,
  states: ActiveFixtureState[],
  attempts: FixedWindowAttempt[],
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
  const acknowledgments = await submitPublishBytes(coordinator, refreshed, states, attempts);
  return { operation: refreshed, operationBytes, acknowledgments };
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
  const results = await coordinator.clients[relayIndex].searchLeasedIndexes(request);
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
): Promise<void> {
  const store = mailbox.current();
  store.retainGeneration(record.index, record.keys);
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
  const receipts = await Promise.all(coordinator.clients.slice(0, 3).map(client => (
    client.depositOfflineDiscovery(value.depositBytes)
  )));
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
  const deposits = await coordinator.clients[0].fetchOfflineDiscovery(fetch);
  if (deposits.length !== 1 || deposits[0] !== value.depositBytes) throw new Error('mailbox_fetch_mismatch');
  const received = store.receive(deposits[0], Date.now());
  await Promise.all(coordinator.clients.slice(0, 3).map(client => client.acknowledgeOfflineDiscovery(received.ackBytes)));
  store.markAcknowledged(received.ackBytes);
  store.recordGenerationAck(value.requestId, received.ackBytes);
  if (store.listOutbox().at(-1)?.state !== 'acknowledged') throw new Error('mailbox_not_acknowledged');
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
      acknowledgedPublishes.push({
        sequence: record.sequence,
        coordinatorId: coordinator.id,
        operation: published.operation,
        operationBytes: published.operationBytes,
        acknowledgments: published.acknowledgments,
        completedAt: Date.now(),
      });
    } else if (record.kind === 'search') await runSearch(coordinator, record.sequence, seed, states);
    else await runMailbox(coordinator, seed, mailbox, record.sequence);
    record.latencyMs = performance.now() - started;
    record.outcome = record.latencyMs > TARGETS.privateOperationMs ? 'deadline_exceeded' : 'good';
  } catch (error) {
    if (error instanceof PublishFailure) record.relayEvidence = error.acknowledgments;
    if (error instanceof SearchValidationError) record.validationDetails = error.failure;
    record.latencyMs = performance.now() - started;
    record.errorClass = errorClass(error);
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
  const { manifest, records } = loadSeed();
  const fixtureStates = Array.from({ length: REPLICAS }, (_, relayIndex) => (
    reconstructRelayFixtureState(join(root, `relay-${relayIndex}`, 'client-held'), records.map(record => record.index))
  ));
  const acknowledgedPublishes: AcknowledgedPublish[] = [];
  const publishAttempts: FixedWindowAttempt[] = [];
  const relays: ResourceRelay[] = [];
  let initialStats: any[] = [];
  const proxies: ByteProxy[][] = [];
  const coordinators: Coordinator[] = [];
  const mailboxes: MailboxState[] = [];
  let monitor: ReturnType<typeof setInterval> | undefined;
  let diskMonitor: ReturnType<typeof setInterval> | undefined;
  let peakAggregateRss = process.memoryUsage().rss;
  let diskPeak = 0;
  try {
    for (let index = 0; index < REPLICAS; index++) relays.push(await ResourceRelay.start(index));
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
    const initialCpu = initialSamples.reduce((sum, sample) => sum + sample.cpuMicros, 0) + process.cpuUsage().user + process.cpuUsage().system;
    diskPeak = directoryBytes(root);
    monitor = setInterval(async () => {
      try {
        const samples = await Promise.all(relays.map(relay => relay.request('sample')));
        peakAggregateRss = Math.max(peakAggregateRss,
          process.memoryUsage().rss + samples.reduce((sum, sample) => sum + sample.rssBytes, 0));
      } catch { /* Final relay exit reports the defect. */ }
    }, 1_000);
    monitor.unref();
    diskMonitor = setInterval(() => { diskPeak = Math.max(diskPeak, directoryBytes(root)); }, 1_000);
    diskMonitor.unref();
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
      operationRecords.push(record);
      await executeOperation(
        coordinators[coordinatorId], record, records, manifest, mailboxes[coordinatorId],
        fixtureStates, acknowledgedPublishes, publishAttempts,
      );
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
      let replayError: string | undefined;
      try {
        replayAcknowledgments = await submitPublishBytes(
          coordinators[original.coordinatorId], original.operation, fixtureStates, publishAttempts,
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
      processTree: {
        peakAggregateRssBytes: peakAggregateRss,
        finalAggregateRssBytes: process.memoryUsage().rss + finalSamples.reduce((sum, sample) => sum + sample.rssBytes, 0),
        parentRssBytes: process.memoryUsage().rss,
        relays: finalSamples,
        aggregateCpuSeconds: (finalCpu - initialCpu) / 1e6,
        rssSampleIntervalMs: 250,
        aggregateSampleIntervalMs: 1000,
      },
      disk: {
        finalBytes: directoryBytes(root),
        sampledPeakBytes: diskPeak,
        sampleIntervalMs: 1000,
        includesTemporaryAndReplacementFilesWhenPresentAtSample: true,
        fsyncAndWrites: {
          parent: { ...localIo },
          relays: finalSamples.map(sample => ({
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
        'Disk peaks are one-second samples and may miss shorter-lived temporary files.',
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
    if (diskMonitor) clearInterval(diskMonitor);
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
  const artifact = {
    schema_version: 1,
    authorization_id: 'DEC-023',
    qualification: qualificationShape ? 'reference-seed' : 'development-smoke-not-qualification',
    command: command(),
    source: sourceIdentity(),
    environment: environment(),
    requestedPublications: publicationCount,
    acceptedPublications: accepted,
    activeRecords: store.activeRecords(createdAt).length,
    replicasMaterialized: REPLICAS,
    elapsedMs: performance.now() - started,
    referenceBytes: directoryBytes(paths.reference),
    allReplicaBytes: directoryBytes(root),
    initializationNetworkBytes: 0,
    method: 'One real LeasedIndexStore persisted once, then exact signed-state copies materialized in five relay directories. Every measured operation uses actual WSS listeners and Node clients.',
  };
  const path = writeResult(qualificationShape
    ? 'client-held-local-resource-seed.json'
    : 'client-held-local-resource-development-smoke-seed.json', artifact);
  console.log(JSON.stringify({ path, ...artifact }, null, 2));
}

async function idle(): Promise<void> {
  const { manifest: _manifest, records: _records } = loadSeed();
  const relays = await Promise.all(Array.from({ length: REPLICAS }, (_, index) => ResourceRelay.start(index)));
  const samples: any[] = [];
  const started = performance.now();
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    const initialStats = await Promise.all(relays.map(relay => relay.request('stats')));
    for (const stats of initialStats) {
      if (stats.leasedActivePublications !== publicationCount) throw new Error('Idle reference cardinality mismatch');
    }
    const startedCpu = process.cpuUsage();
    const initialCpu = initialStats.reduce((sum, stats) => sum + stats.sample.cpuMicros, 0)
      + startedCpu.user + startedCpu.system;
    const sample = async () => {
      const relaySamples = await Promise.all(relays.map(relay => relay.request('sample')));
      samples.push({
        elapsedMs: performance.now() - started,
        parentRssBytes: process.memoryUsage().rss,
        relayRssBytes: relaySamples.map(value => value.rssBytes),
        aggregateRssBytes: process.memoryUsage().rss + relaySamples.reduce((sum, value) => sum + value.rssBytes, 0),
        aggregateCpuMicros: relaySamples.reduce((sum, value) => sum + value.cpuMicros, 0)
          + process.cpuUsage().user + process.cpuUsage().system,
        diskBytes: directoryBytes(root),
      });
    };
    await sample();
    monitor = setInterval(() => { void sample().catch(error => { throw error; }); }, 5_000);
    const remaining = idleSeconds * 1000 - (performance.now() - started);
    if (remaining > 0) await new Promise(accept => setTimeout(accept, remaining));
    if (monitor) clearInterval(monitor);
    await sample();
    const finalStats = await Promise.all(relays.map(relay => relay.request('stats')));
    const finalCpu = finalStats.reduce((sum, stats) => sum + stats.sample.cpuMicros, 0)
      + process.cpuUsage().user + process.cpuUsage().system;
    const elapsedMs = performance.now() - started;
    const cpuSeconds = (finalCpu - initialCpu) / 1e6;
    const artifact = {
      schema_version: 1,
      authorization_id: 'DEC-023',
      qualification: qualificationShape && idleSeconds === 1800 ? 'bounded-30-minute-idle' : 'development-idle-not-qualification',
      command: command(),
      source: sourceIdentity(),
      environment: environment(),
      fixedActivePublicationsPerRelay: publicationCount,
      replicas: REPLICAS,
      requestedIdleSeconds: idleSeconds,
      achievedIdleSeconds: elapsedMs / 1000,
      sampleCount: samples.length,
      sampleIntervalMs: 5000,
      cpuSeconds,
      idleCpuPercentOfOneCore: cpuSeconds / (elapsedMs / 1000) * 100,
      meanAggregateRssBytes: samples.reduce((sum, value) => sum + value.aggregateRssBytes, 0) / samples.length,
      peakAggregateRssBytes: Math.max(...samples.map(value => value.aggregateRssBytes)),
      peakPerRelayRssBytes: finalStats.map(stats => stats.sample.rssPeakBytes),
      diskPeakBytes: Math.max(...samples.map(value => value.diskBytes)),
      diskFinalBytes: samples.at(-1).diskBytes,
      fsyncAndWrites: finalStats.map(stats => stats.sample),
      samples,
      physicalPower: 'not measured; no power samples; CPU seconds are not watts',
      limitations: [
        'No new user work; ordinary relay timers remained active. No external issuer, witness, policy, or relay-peer service was enrolled.',
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
}
