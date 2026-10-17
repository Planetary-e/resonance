/** Isolated eval process; injected lost/delayed replies never enter production. */
import WebSocket from 'ws';
import { createConfiguredAdmissionVerifier, createRelayServer } from '@resonance/relay';
import { seededRandom } from '../witness-availability.js';

const directory = process.argv[2];
let verifier: Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>> | undefined;
let port = 0, mode = 'normal', random = seededRandom(1), running = false;
let voteCalls = 0, replyPayloadBytes = 0, droppedReplyBytes = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
const originalSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (data, ...args) {
  if (typeof data !== 'string' || JSON.parse(data).kind !== 'admission-witness-vote') {
    return Reflect.apply(originalSend, this, [data, ...args]);
  }
  if (mode === 'drop-reply') { droppedReplyBytes += Buffer.byteLength(data); return; }
  const send = () => {
    if (this.readyState === WebSocket.OPEN) {
      replyPayloadBytes += Buffer.byteLength(data);
      Reflect.apply(originalSend, this, [data, ...args]);
    }
  };
  if (mode !== 'delayed') return send();
  const timer = setTimeout(() => { timers.delete(timer); send(); }, 80 + Math.floor(random() * 81));
  timers.add(timer);
  this.once('close', () => { clearTimeout(timer); timers.delete(timer); });
};

function createServer() {
  return createRelayServer({ host: '127.0.0.1', port, persistDir: directory, maxPeerRequestsPerMin: 10000,
    admissionWitness: {
      vote(request, acceptNew) {
        if (!verifier?.witness) throw new Error('Eval witness is not configured');
        const vote = verifier.witness.vote(request, acceptNew); voteCalls++; return vote;
      }, close() {},
    },
    relayDiscovery: { endpoints: [`ws://127.0.0.1:${port}/`], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1000000, availableBytes: 900000 }, maxKnownRelays: 8 },
  });
}
let relay = createServer();
process.on('message', async (message: any) => {
  try {
    let result: unknown = true;
    if (message.command === 'configure') {
      verifier = await createConfiguredAdmissionVerifier({ directory, authority: message.authority, policy: message.policy,
        encryptionKey: Buffer.from(message.encryptionKey, 'base64'), initialize: true,
        witnessKey: { publicKey: Buffer.from(message.publicKey, 'base64'), secretKey: Buffer.from(message.secretKey, 'base64') } });
    } else if (message.command === 'profile') {
      if (!['normal', 'delayed', 'drop-reply', 'offline'].includes(message.mode)) throw new Error('Invalid eval profile');
      mode = message.mode; random = seededRandom(message.seed);
      if (mode === 'offline' && running) { await relay.stop(); running = false; }
      if (mode !== 'offline' && !running) { relay = createServer(); await relay.start(); running = true; }
    } else if (message.command === 'snapshot') {
      const cpu = process.cpuUsage();
      result = { cpuMicros: cpu.user + cpu.system, voteCalls, replyPayloadBytes, droppedReplyBytes };
    } else if (message.command === 'stop') {
      if (running) await relay.stop();
      verifier?.close(); for (const timer of timers) clearTimeout(timer);
    } else throw new Error('Unknown witness eval command');
    process.send?.({ id: message.id, result }, () => { if (message.command === 'stop') process.exit(0); });
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.on('disconnect', () => process.exit(1));
await relay.start(); running = true;
const endpoint = relay.getRelayDescriptor()!.endpoints[0];
port = Number(new URL(endpoint).port);
process.send?.({ event: 'ready', endpoint });
