/** Explicit configuration for already prepared observer state. Never initializes
 * an owner, discovers replacement members, or relaxes a retained recovery fence. */
import { dirname, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointEnvelopeId, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { assertPolicyObserverHistoryContext } from './policy-observer-history-replay.js';
import { parseAdmissionHistoryArchiveLimits } from './admission-history-config.js';
import { readOperatorFile, readOperatorSigningKey, readOperatorStorageKey } from './admission-operator-files.js';
import { openProtectedPolicyObserver } from './protected-policy-observer.js';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver } from './admission-policy-observation-transport.js';
import type { HistoryCheckpointTransport } from './history-checkpoint-exchange.js';
import type { PolicyObserverHealth } from './history-health.js';

export const POLICY_OBSERVER_CONFIGURATION_MAX_BYTES = 2 * HISTORY_ENVELOPE_MAX_BYTES + 64 * 1024;
export function parsePolicyObserverMemberPins(value: unknown, keys: readonly string[]) {
  if (!Array.isArray(value) || value.length !== 5) throw new Error('Policy history needs five pinned members');
  const members = value.map(raw => {
    if (!exactWitnessFields(raw, ['publicKey', 'endpoint']) || typeof raw.publicKey !== 'string'
      || !keys.includes(raw.publicKey) || typeof raw.endpoint !== 'string') throw new Error('Invalid policy history member');
    assertSecureRelayTransportEndpoint(raw.endpoint);
    const endpoint = new URL(raw.endpoint);
    if (endpoint.pathname !== '/history-checkpoint' || endpoint.search || endpoint.hash) throw new Error('Policy history endpoints must use the pinned history route');
    return { publicKey: raw.publicKey, endpoint: endpoint.href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) throw new Error('Policy history needs five distinct members and endpoints');
  return members;
}
export function parsePolicyObserverPath(raw: unknown, base: string) {
  if (typeof raw !== 'string' || !raw.length || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('Invalid policy observer path');
  return resolve(base, raw);
}
export function parsePolicyObserverListener(value: unknown) {
  if (!exactWitnessFields(value, ['port', 'maxConnections', 'connectionTimeoutMs'])) throw new Error('Invalid policy observer listener');
  const { port, maxConnections, connectionTimeoutMs } = value;
  if (!Number.isSafeInteger(port) || (port as number) < 0 || (port as number) > 65535
    || !Number.isSafeInteger(maxConnections) || (maxConnections as number) < 1 || (maxConnections as number) > 8
    || !Number.isSafeInteger(connectionTimeoutMs) || (connectionTimeoutMs as number) < 50 || (connectionTimeoutMs as number) > 30000) {
    throw new Error('Invalid policy observer listener bounds');
  }
  return { port: port as number, maxConnections: maxConnections as number, connectionTimeoutMs: connectionTimeoutMs as number };
}
export function parsePolicyObserverConfiguration(value: unknown, base: string) {
  if (!exactWitnessFields(value, ['version', 'kind', 'context', 'historyContext', 'genesis', 'root', 'members',
    'directory', 'signingKeyFile', 'storageKeyFile', 'limits', 'listen']) || value.version !== 1 || value.kind !== 'policy-observer-configuration') {
    throw new Error('Invalid policy observer configuration');
  }
  const context = parseAdmissionPolicyObservers(value.context), historyContext = parseHistoryCheckpointContext(value.historyContext);
  assertPolicyObserverHistoryContext(context, historyContext);
  const genesis = parseHistoryCheckpointEnvelope(value.genesis, historyContext), root = parseHistoryCheckpointEnvelope(value.root, historyContext);
  if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0
    || root.kind !== 'continuation' && historyCheckpointEnvelopeId(root) !== historyCheckpointEnvelopeId(genesis)) {
    throw new Error('Policy observer configuration needs independently retained genesis and an explicit original or certified root');
  }
  const members = parsePolicyObserverMemberPins(value.members, historyContext.members);
  const path = (raw: unknown) => parsePolicyObserverPath(raw, base);
  return { version: 1 as const, kind: 'policy-observer-configuration' as const, context, historyContext, genesis, root, members,
    directory: path(value.directory), signingKeyFile: path(value.signingKeyFile), storageKeyFile: path(value.storageKeyFile),
    limits: parseAdmissionHistoryArchiveLimits(value.limits),
    listen: parsePolicyObserverListener(value.listen) };
}
export type PolicyObserverConfiguration = ReturnType<typeof parsePolicyObserverConfiguration>;
export function readPolicyObserverConfigurationFile(path: string) {
  const bytes = readOperatorFile(path, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES);
  try {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Policy observer configuration must be valid UTF-8 JSON'); }
    return parsePolicyObserverConfiguration(value, dirname(resolve(path)));
  } finally { bytes.fill(0); }
}
/** Every caller must close its returned owner. Secrets are copied into the owner
 * and cleared here; neither status inspection nor this open performs network I/O. */
export async function openConfiguredPolicyObserver(value: PolicyObserverConfiguration, options: {
  transport?: HistoryCheckpointTransport; timeoutMs?: number; now?: () => number;
} = {}) {
  const config = parsePolicyObserverConfiguration(value, '/');
  const signingKey = readOperatorSigningKey(config.signingKeyFile);
  let encryptionKey: Buffer | undefined;
  try {
    encryptionKey = readOperatorStorageKey(config.storageKeyFile);
    return await openProtectedPolicyObserver({ directory: config.directory, encryptionKey, signingKey, context: config.context,
      historyContext: config.historyContext, root: config.root, genesis: config.genesis, members: config.members, mode: 'open-existing',
      maxArchiveBytes: config.limits.archiveBytes, maxArchiveBlocks: config.limits.archiveBlocks,
      transport: options.transport, timeoutMs: options.timeoutMs, now: options.now });
  } finally { encryptionKey?.fill(0); signingKey.secretKey.fill(0); }
}

/** Explicit startup checks four current copies before exposing the bounded
 * loopback listener. Public TLS/reverse routing remains separately configured. */
export async function serveConfiguredPolicyObserver(value: PolicyObserverConfiguration, options: {
  transport?: HistoryCheckpointTransport; timeoutMs?: number; now?: () => number; signal?: AbortSignal;
  onSocket?: (socket: Socket) => void; acceptNewWork?: (bytes: number) => boolean;
} = {}) {
  const config = parsePolicyObserverConfiguration(value, '/'), signal = options.signal;
  let observer: Awaited<ReturnType<typeof openConfiguredPolicyObserver>> | undefined;
  let listener: Awaited<ReturnType<typeof listenAdmissionPolicyObserver>> | undefined;
  let closing: Promise<void> | undefined;
  function cancelled() { if (signal?.aborted || closing) throw new Error('Policy observer startup cancelled'); }
  function close(): Promise<void> {
    if (!closing) closing = (async () => {
      signal?.removeEventListener('abort', abort);
      try { await listener?.close(); } finally { observer?.close(); }
    })();
    return closing;
  }
  const abort = () => { void close().catch(() => {}); };
  try {
    cancelled(); signal?.addEventListener('abort', abort, { once: true });
    observer = await openConfiguredPolicyObserver(config, options);
    if (signal?.aborted || closing) { observer.close(); cancelled(); }
    await observer.ready(); cancelled();
    listener = await listenAdmissionPolicyObserver(createAdmissionPolicyObserverExchange(observer, config.context, options.now),
      { ...config.listen, onSocket: options.onSocket, acceptNewWork: options.acceptNewWork });
    if (signal?.aborted || closing) { await listener.close(); observer.close(); cancelled(); }
    return { endpoint: listener.endpoint, status: () => observer!.status(), close,
      health(): PolicyObserverHealth {
        return { ...observer!.health(), listening: !closing };
      } };
  } catch (error) { await close(); throw error; }
}
