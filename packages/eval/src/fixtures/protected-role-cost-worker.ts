/** Disposable benchmark worker; inputs are generated private fixtures over IPC. */
import { openProtectedAdmissionSpendHistory } from '../../../relay/src/protected-admission-history.js';
import { openHistoryCheckpointStore } from '../../../relay/src/history-checkpoint-store.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica } from '../../../relay/src/history-checkpoint-exchange.js';
import type { HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import type { SignedAdmissionPolicy } from '@resonance/core/admission-policy';

export interface RoleCostWorkerInput {
  role: 'volunteer' | 'reader'; directory: string; key: string; context: HistoryCheckpointContext;
  signingKey: { publicKey: string; secretKey: string }; rootId: string;
  members: Array<{ publicKey: string; endpoint: string }>; policy: SignedAdmissionPolicy; time: number;
}
let close = async () => {};
process.on('disconnect', () => { void close(); });
process.once('message', async (message: { init: RoleCostWorkerInput }) => {
  const input = message.init, key = Buffer.from(input.key, 'base64url');
  const signingKey = { publicKey: Buffer.from(input.signingKey.publicKey, 'base64url'), secretKey: Buffer.from(input.signingKey.secretKey, 'base64url') };
  try {
    if (input.role === 'reader') {
      let requestBytes = 0, replyBytes = 0;
      const cpu = process.cpuUsage(), started = performance.now();
      const history = await openProtectedAdmissionSpendHistory({ directory: input.directory, encryptionKey: key, authority: input.context.authority,
        policy: input.policy, now: () => input.time, protection: { context: input.context, signingKey, members: input.members,
          transport: async (member, frame, signal) => {
            requestBytes += Buffer.byteLength(JSON.stringify(frame)); const result = await exchangeHistoryCheckpoint(member, frame, signal);
            replyBytes += Buffer.byteLength(JSON.stringify(result)); return result;
          } } });
      close = async () => { history.close(); };
      const opened = performance.now(); await history.ready(); const completed = performance.now(), usage = process.cpuUsage(cpu);
      const result = { openMs: opened - started, readinessMs: completed - opened, wallMs: completed - started,
        cpuMs: (usage.user + usage.system) / 1000, rssMiB: process.memoryUsage().rss / 1048576,
        peakRssMiB: process.resourceUsage().maxRSS / 1024, requestBytes, replyBytes };
      await close(); process.send!({ ready: true, result }, () => process.disconnect!());
    } else {
      const store = openHistoryCheckpointStore({ directory: input.directory, localKey: key, context: input.context, rootId: input.rootId,
        generation: 0, replica: input.signingKey.publicKey });
      const replica = createHistoryCheckpointReplica({ context: input.context, store, signingKey });
      let receivedBytes = 0, sentBytes = 0, exchanges = 0, closed = false;
      const listener = await listenHistoryCheckpointReplica({ close() {}, exchange(frame) {
        receivedBytes += Buffer.byteLength(JSON.stringify(frame)); exchanges++;
        const result = replica.exchange(frame); sentBytes += Buffer.byteLength(JSON.stringify(result)); return result;
      } }, { port: 0 });
      close = async () => { if (closed) return; closed = true; await listener.close(); replica.close(); store.close(); key.fill(0); signingKey.secretKey.fill(0); };
      process.on('message', async (request: { id?: number; operation?: string }) => {
        if (!request.id) return;
        try {
          if (request.operation === 'snapshot') {
            const cpu = process.cpuUsage(); process.send!({ id: request.id, result: { cpuMicros: cpu.user + cpu.system, receivedBytes, sentBytes, exchanges,
              rssMiB: process.memoryUsage().rss / 1048576, peakRssMiB: process.resourceUsage().maxRSS / 1024 } });
          } else if (request.operation === 'close') { await close(); process.send!({ id: request.id, result: null }, () => process.disconnect!()); }
          else throw new Error('Unknown benchmark operation');
        } catch (error) { process.send!({ id: request.id, error: error instanceof Error ? error.message : 'Benchmark command failed' }); }
      });
      process.send!({ ready: true, endpoint: listener.endpoint });
    }
  } catch (error) {
    await close(); process.send!({ error: error instanceof Error ? error.message : 'Benchmark startup failed' }, () => process.disconnect!());
  } finally { if (input.role === 'reader') { key.fill(0); signingKey.secretKey.fill(0); } }
});
