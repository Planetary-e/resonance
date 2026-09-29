import { WebSocketServer } from 'ws';
import { createRelayServer, type RelayConfig } from '@resonance/relay';
import { RELAY_PRIVATE_FORWARD_FRAME_TYPE } from '@resonance/core';
import { simulateFrameDelay, timingNow } from './timing-delay.js';

interface Observation { phase: 'request' | 'reply'; requestId: string; atMs: number; bytes: number }
const config = JSON.parse(process.env.RESONANCE_TIMING_RELAY_CONFIG!) as Partial<RelayConfig>;
let observations: Observation[] = [];
const record = (value: Observation) => {
  if (observations.length >= 512) throw new Error('Timing fixture observation capacity exceeded');
  observations.push(value);
};
const delay = simulateFrameDelay((_socket, data) => {
  if (typeof data !== 'string') return;
  const frame = JSON.parse(data);
  if (frame.type === 'private_response') record({ phase: 'reply', requestId: frame.requestId,
    atMs: timingNow(), bytes: Buffer.byteLength(data) });
});
const emit = WebSocketServer.prototype.emit;
WebSocketServer.prototype.emit = function (event, ...args) {
  if (event === 'connection') {
    args[0].once('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8'));
      const requestId = frame.stage === 'entry' ? frame.requestId
        : frame.type === RELAY_PRIVATE_FORWARD_FRAME_TYPE ? frame.destination.requestId : undefined;
      if (requestId) record({ phase: 'request', requestId, atMs: timingNow(), bytes: data.length });
    });
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
const relay = createRelayServer(config);
process.on('message', async (message: any) => {
  try {
    let result: unknown;
    if (message.command === 'observe') result = relay.observeRelayDescriptor(message.descriptor);
    else if (message.command === 'reset') {
      observations = []; delay.configure(message.delay, message.seed); result = true;
    } else if (message.command === 'snapshot') result = observations;
    else if (message.command === 'stop') {
      await relay.stop(); delay.restore(); result = true;
    } else throw new Error('Unknown timing fixture command');
    process.send?.({ id: message.id, result });
    if (message.command === 'stop') process.exit(0);
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
await relay.start();
process.send?.({ event: 'ready', descriptor: relay.getRelayDescriptor(), pid: process.pid });
