import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  serializeOfflineDiscoveryAckV1,
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
} from '@resonance/core';
import {
  createRelayServer,
  LeasedIndexStore,
  MailboxGenerationStore,
} from '@resonance/relay';

const config = JSON.parse(process.env.RESONANCE_TEST_CLIENT_HELD_RELAY!);
const controlToken = Buffer.from(process.env.RESONANCE_TEST_CONTROL_TOKEN!, 'base64url');
const spendPath = join(config.persistDir, 'fixture-admission-spends.json');
const spent = new Map<string, string>();
let armed: { barrier: string; binding: string } | undefined;
let lastIndexBinding = '';

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url');
}

function authenticated(message: any): boolean {
  if (typeof message?.token !== 'string') return false;
  const supplied = Buffer.from(message.token, 'base64url');
  return supplied.length === controlToken.length && timingSafeEqual(supplied, controlToken);
}

function crashAt(barrier: string, binding: string): void {
  if (armed?.barrier !== barrier || armed.binding !== binding) return;
  armed = undefined;
  process.kill(process.pid, 'SIGKILL');
}

const applyIndex = LeasedIndexStore.prototype.apply;
LeasedIndexStore.prototype.apply = function (raw, ...args) {
  const result = applyIndex.call(this, raw, ...args);
  lastIndexBinding = digest(raw);
  return result;
};
const saveIndexes = LeasedIndexStore.prototype.save;
LeasedIndexStore.prototype.save = function (...args) {
  const result = saveIndexes.apply(this, args);
  crashAt('index-save', lastIndexBinding);
  return result;
};

const appendMailbox = (MailboxGenerationStore.prototype as any).append;
(MailboxGenerationStore.prototype as any).append = function (entry: any) {
  const result = appendMailbox.call(this, entry);
  if (entry.kind === 'deposit') crashAt('deposit-append', digest(entry.record.depositBytes));
  if (entry.kind === 'ack') {
    crashAt('ack-append', digest(serializeOfflineDiscoveryAckV1(entry.ack)));
  }
  return result;
};

function loadSpends(): void {
  mkdirSync(config.persistDir, { recursive: true });
  if (!existsSync(spendPath)) return;
  const records = JSON.parse(readFileSync(spendPath, 'utf8')) as Array<[string, string]>;
  for (const [token, binding] of records) spent.set(token, binding);
}

function saveSpends(): void {
  const temporary = `${spendPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify([...spent]), { mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, spendPath);
  if (process.platform !== 'win32') {
    const directoryFd = openSync(config.persistDir, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  rmSync(temporary, { force: true });
}

loadSpends();
const relay = createRelayServer({
  port: 0,
  host: '127.0.0.1',
  persistDir: config.persistDir,
  inboundReplicaTargetIds: config.approvedRelays,
  privateEntryMix: false,
  privateReplyMix: false,
  relayDiscovery: {
    endpoints: ['ws://127.0.0.1:0/'],
    reachability: 'direct',
    supportedGroups: ['public'],
    storage: { capacityBytes: 32 * 1024 * 1024, availableBytes: 16 * 1024 * 1024 },
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
      saveSpends();
      return { status: 'accepted' as const };
    },
  },
});

process.on('message', async (message: any) => {
  if (!authenticated(message)) {
    process.send?.({ id: message?.id, error: 'Fixture control authentication failed' });
    return;
  }
  try {
    let result: unknown;
    if (message.command === 'arm') {
      if (!['index-save', 'deposit-append', 'ack-append'].includes(message.barrier)
        || typeof message.binding !== 'string') throw new Error('Invalid fixture barrier');
      armed = { barrier: message.barrier, binding: message.binding };
      result = true;
    } else if (message.command === 'stats') {
      result = { authenticatedSpends: spent.size };
    } else if (message.command === 'stop') {
      await relay.stop({ graceful: false });
      result = true;
    } else {
      throw new Error('Unknown fixture command');
    }
    process.send?.({ id: message.id, result });
    if (message.command === 'stop') process.exit(0);
  } catch (error) {
    process.send?.({ id: message.id, error: String(error) });
  }
});

try {
  await relay.start();
  process.send?.({ event: 'ready', descriptor: relay.getRelayDescriptor() });
} catch (error) {
  process.send?.({ event: 'failed', error: String(error) });
  process.exit(1);
}
