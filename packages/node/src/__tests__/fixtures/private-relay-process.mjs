// Isolated relay process used by the network-observation integration test.
import WebSocket, { WebSocketServer } from 'ws';
import { createRelayServer } from '@resonance/relay';

const report = value => process.send?.(value);
const serverEmit = WebSocketServer.prototype.emit;
WebSocketServer.prototype.emit = function (event, ...args) {
  if (event === 'connection') {
    const [socket, request] = args;
    socket.once('message', data => report({
      event: 'inbound',
      remoteAddress: request.socket.remoteAddress,
      remotePort: request.socket.remotePort,
      raw: data.toString('utf8'),
    }));
  }
  return serverEmit.call(this, event, ...args);
};

const clientEmit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (event, ...args) {
  if (event === 'upgrade') report({
    event: 'outbound',
    localPort: args[0].socket.localPort,
    url: this.url,
  });
  return clientEmit.call(this, event, ...args);
};

const { port, host, endpoint, persistDir } = JSON.parse(process.env.RESONANCE_TEST_RELAY_CONFIG);
const relay = createRelayServer({
  port, host, persistDir,
  relayDiscovery: {
    endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'],
    storage: { capacityBytes: 1_000_000, availableBytes: 900_000 },
    maxKnownRelays: 8,
  },
});

process.on('message', async message => {
  try {
    let result;
    if (message.command === 'observe') result = relay.observeRelayDescriptor(message.descriptor);
    else if (message.command === 'stats') result = relay.getStats();
    else if (message.command === 'stop') {
      await relay.stop();
      result = true;
    } else throw new Error('Unknown fixture command');
    report({ id: message.id, result });
    if (message.command === 'stop') process.exit(0);
  } catch (error) {
    report({ id: message.id, error: String(error) });
  }
});

try {
  await relay.start();
  report({ event: 'ready', descriptor: relay.getRelayDescriptor() });
} catch (error) {
  report({ event: 'failed', error: String(error) });
  process.exit(1);
}
