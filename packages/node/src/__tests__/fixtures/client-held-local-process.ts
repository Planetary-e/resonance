import { createHash, timingSafeEqual } from 'node:crypto';
import { OfflineRequestStore } from '../../offline-request-store.js';
import { ContentGrantStore } from '../../content-grant-store.js';

const config = JSON.parse(process.env.RESONANCE_TEST_CLIENT_HELD_LOCAL!);
const controlToken = Buffer.from(process.env.RESONANCE_TEST_CONTROL_TOKEN!, 'base64url');
const store: any = config.kind === 'offline'
  ? OfflineRequestStore.open({ path: config.path, encryptionKey: Buffer.from(config.key, 'base64url') })
  : ContentGrantStore.open({ path: config.path, encryptionKey: Buffer.from(config.key, 'base64url') });
let armed: { barrier: string; binding: string; recordId?: string } | undefined;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function authenticated(message: any): boolean {
  if (typeof message?.token !== 'string') return false;
  const supplied = Buffer.from(message.token, 'base64url');
  return supplied.length === controlToken.length && timingSafeEqual(supplied, controlToken);
}

const write = store.snapshot.write;
store.snapshot.write = function (next: any) {
  const before = store.snapshot.read();
  const result = write.call(this, next);
  if (!armed) return result;
  let committed = false;
  if (armed.barrier === 'inbox-commit') committed = next.inbox.length > before.inbox.length;
  if (armed.barrier === 'offline-ack-commit') {
    committed = next.pendingAcks.length > before.pendingAcks.length;
  }
  if (armed.barrier === 'content-request-commit') {
    committed = next.requests.some((item: any) => item.requestBytes
      && JSON.parse(item.requestBytes).requestId === armed?.recordId
      && item.pendingOperationBytes
      && !before.requests.find((prior: any) => prior.requestBytes === item.requestBytes)?.pendingOperationBytes);
  }
  if (armed.barrier === 'content-response-commit') {
    committed = next.grants.some((item: any) => JSON.parse(item.grantBytes).grantId === armed?.recordId
      && item.pendingOperationBytes
      && !before.grants.find((prior: any) => prior.grantBytes === item.grantBytes)?.pendingOperationBytes);
  }
  if (armed.barrier === 'content-receive-commit') {
    committed = next.receivedOperations.length > before.receivedOperations.length;
  }
  if (committed) {
    armed = undefined;
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};

process.on('message', async (message: any) => {
  if (!authenticated(message)) {
    process.send?.({ id: message?.id, error: 'Fixture control authentication failed' });
    return;
  }
  try {
    if (message.command === 'stop') {
      store.close();
      process.send?.({ id: message.id, result: true });
      process.exit(0);
      return;
    }
    if (message.command !== 'run') throw new Error('Unknown fixture command');
    const source = message.raw ?? message.recordId;
    if (typeof source !== 'string' || digest(source) !== message.binding) {
      throw new Error('Fixture barrier is not bound to the requested operation');
    }
    armed = { barrier: message.barrier, binding: message.binding, recordId: message.recordId };
    let result: unknown;
    if (config.kind === 'offline') result = store.receive(message.raw, message.now);
    else if (message.barrier === 'content-request-commit') result = store.prepareRequest(message.recordId);
    else if (message.barrier === 'content-response-commit') result = store.prepareResponse(message.recordId);
    else if (message.barrier === 'content-receive-commit') result = store.receiveResponse(message.raw, message.now);
    else throw new Error('Unsupported local fixture barrier');
    armed = undefined;
    process.send?.({ id: message.id, result });
  } catch (error) {
    armed = undefined;
    process.send?.({ id: message.id, error: String(error) });
  }
});

process.send?.({ event: 'ready' });
