import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyAdmissionCapabilityV2, type AdmissionCapabilityV2 } from '@resonance/core';
import { createRelayServer } from '../../../relay/src/server.js';
import { LeasedIndexStore } from '../../../relay/src/leased-index-store.js';
import { MailboxGenerationStore } from '../../../relay/src/mailbox-generation-store.js';
import { RelayOperationLog } from '../../../relay/src/operation-log.js';
import { HarnessDiskAccounting } from '../client-held-disk-accounting.js';
import { RuntimeTelemetry } from '../client-held-runtime-telemetry.js';

const moduleEntryRssBytes = process.memoryUsage().rss;
const config = JSON.parse(process.env.RESONANCE_RESOURCE_RELAY!);
const rssSampleIntervalMs = config.rssSampleIntervalMs ?? 250;
if (!Number.isSafeInteger(rssSampleIntervalMs) || rssSampleIntervalMs < 250) {
  throw new Error('Invalid resource fixture RSS sample interval');
}
const token = Buffer.from(process.env.RESONANCE_RESOURCE_TOKEN!, 'base64url');
const metrics = {
  fsyncCount: 0,
  fsyncMicros: 0,
  writeCount: 0,
  writeBytes: 0,
  renameCount: 0,
};
const runtimeTelemetry = new RuntimeTelemetry();
const persistenceSpans: Array<{ atMicros: number; kind: string; durationMicros: number }> = [];
let persistenceDroppedEntries = 0;
function recordPersistenceSpan(kind: string, durationMicros: number): void {
  persistenceSpans.push({
    atMicros: Math.floor((performance.timeOrigin + performance.now()) * 1000),
    kind,
    durationMicros,
  });
  if (persistenceSpans.length > 32) {
    persistenceSpans.shift();
    persistenceDroppedEntries++;
  }
}
const originalFsync = fs.fsyncSync;
fs.fsyncSync = function (fd) {
  const started = performance.now();
  try { return originalFsync(fd); }
  finally {
    const elapsed = (performance.now() - started) * 1000;
    metrics.fsyncCount++;
    metrics.fsyncMicros += elapsed;
    recordPersistenceSpan('fsync', elapsed);
  }
};
const originalWriteFile = fs.writeFileSync;
fs.writeFileSync = function (path: any, data: any, options?: any) {
  const result = originalWriteFile(path, data, options);
  metrics.writeCount++;
  metrics.writeBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  return result;
};
const originalAppendFile = fs.appendFileSync;
fs.appendFileSync = function (path: any, data: any, options?: any) {
  const result = originalAppendFile(path, data, options);
  metrics.writeCount++;
  metrics.writeBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  return result;
};
const originalWrite = fs.writeSync;
fs.writeSync = function (...args: any[]) {
  const result = (originalWrite as any)(...args);
  metrics.writeCount++;
  if (typeof result === 'number') metrics.writeBytes += result;
  return result;
};
const originalRename = fs.renameSync;
fs.renameSync = function (from, to) {
  const result = originalRename(from, to);
  metrics.renameCount++;
  return result;
};
syncBuiltinESMExports();
const diskAccounting = new HarnessDiskAccounting(config.persistDir);

function instrumentPersistence(prototype: any, name: string, kind: string): void {
  const original = prototype[name];
  prototype[name] = function (...args: any[]) {
    const started = performance.now();
    try { return original.apply(this, args); }
    finally { recordPersistenceSpan(kind, (performance.now() - started) * 1000); }
  };
}
instrumentPersistence(LeasedIndexStore.prototype, 'save', 'leased-index-save');
instrumentPersistence(MailboxGenerationStore.prototype, 'compact', 'mailbox-compaction');
instrumentPersistence(RelayOperationLog.prototype, 'compact', 'operation-log-compaction');

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
function authenticated(message: any): boolean {
  if (typeof message?.token !== 'string') return false;
  const supplied = Buffer.from(message.token, 'base64url');
  return supplied.length === token.length && timingSafeEqual(supplied, token);
}

const spent = new Map<string, string>();
const relay = createRelayServer({
  port: 0,
  host: '127.0.0.1',
  persistDir: config.persistDir,
  tls: {
    cert: readFileSync(new URL('../../../relay/src/__tests__/fixtures/tls/localhost.crt', import.meta.url)),
    key: readFileSync(new URL('../../../relay/src/__tests__/fixtures/tls/localhost.key', import.meta.url)),
  },
  identityPassphrase: 'DEC-023 local measurement fixture',
  privateEntryMix: false,
  privateReplyMix: false,
  desiredReplicaCount: 5,
  minimumHealthyReplicaCount: 3,
  relayDiscovery: {
    endpoints: ['wss://127.0.0.1:0/'],
    reachability: 'direct',
    supportedGroups: ['public'],
    storage: { capacityBytes: 2 * 1024 ** 3, availableBytes: 1024 ** 3 },
  },
  admissionVerifier: {
    verifyAndSpend(capability: AdmissionCapabilityV2, context: { requestBinding: string }) {
      if (!verifyAdmissionCapabilityV2(capability)
        || capability.requestProof !== digest(context.requestBinding)
        || capability.token !== digest(`token:${context.requestBinding}`)) {
        return { status: 'rejected' as const };
      }
      const prior = spent.get(capability.token);
      if (prior) {
        return prior === context.requestBinding
          ? { status: 'replay' as const }
          : { status: 'rejected' as const };
      }
      spent.set(capability.token, context.requestBinding);
      return { status: 'accepted' as const };
    },
  },
});

let rssPeak = moduleEntryRssBytes;
let rssTotal = 0;
let rssSamples = 0;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  rssPeak = Math.max(rssPeak, rss);
  rssTotal += rss;
  rssSamples++;
}, rssSampleIntervalMs);
sampler.unref();

function sample() {
  const cpu = process.cpuUsage();
  const rss = process.memoryUsage().rss;
  rssPeak = Math.max(rssPeak, rss);
  return {
    pid: process.pid,
    moduleEntryRssBytes,
    rssBytes: rss,
    rssPeakBytes: rssPeak,
    rssMeanBytes: rssSamples ? rssTotal / rssSamples : rss,
    rssSampleIntervalMs,
    cpuMicros: cpu.user + cpu.system,
    ...metrics,
    ...runtimeTelemetry.sample(),
    persistenceSpans: persistenceSpans.splice(0),
    persistenceDroppedEntries,
  };
}

process.on('message', async (message: any) => {
  if (!authenticated(message)) {
    process.send?.({ id: message?.id, error: 'Resource fixture authentication failed' });
    return;
  }
  try {
    let result: unknown;
    if (message.command === 'sample') result = sample();
    else if (message.command === 'stats') {
      const stats = relay.getStats();
      result = {
        sample: sample(),
        relay: stats,
        leasedActivePublications: stats.leased_active_publications,
        disk: diskAccounting.snapshot(),
        diskEvents: diskAccounting.events(),
      };
    }
    else if (message.command === 'stop') {
      clearInterval(sampler);
      await relay.stop({ graceful: false });
      result = { ...sample(), disk: diskAccounting.snapshot(), diskEvents: diskAccounting.events() };
    }
    else if (message.command === 'exit') process.exit(0);
    else throw new Error('Unknown resource fixture command');
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({ id: message.id, error: String(error) });
  }
});

try {
  await relay.start();
  process.send?.({ event: 'ready', descriptor: relay.getRelayDescriptor(), port: relay.getListeningPort(), sample: sample() });
} catch (error) {
  process.send?.({ event: 'failed', error: String(error) });
  process.exit(1);
}
