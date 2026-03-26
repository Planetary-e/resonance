import WebSocket from 'ws';
import type { BenchmarkResult } from '@resonance/core';
import {
  generateIdentity,
  createMessage,
  serializeMessage,
  parseMessage,
  verifyMessage,
  MessageTypes,
  normalize,
  type Identity,
  type Message,
  type AckPayload,
  type MatchPayload,
  type PublishPayload,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '@resonance/relay';
import { timeAsync, formatMs, generateRandomUnitVector } from '../utils.js';

const PORT = 29090 + Math.floor(Math.random() * 1000);

function similarVector(base: Float32Array, noise = 0.03): number[] {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) v[i] = base[i] + (Math.random() - 0.5) * noise;
  return Array.from(normalize(v));
}

function connectAndAuth(port: number, identity: Identity): Promise<{ ws: WebSocket; messages: Message[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const messages: Message[] = [];
    ws.on('open', () => {
      ws.send(serializeMessage(createMessage(MessageTypes.AUTH, {}, identity)));
    });
    ws.on('message', (data: Buffer) => {
      const msg = parseMessage(data.toString('utf-8'));
      messages.push(msg);
      if (msg.type === MessageTypes.ACK && (msg.payload as AckPayload).ref === 'auth') {
        resolve({ ws, messages });
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

function waitForType(messages: Message[], type: string, timeout = 5000): Promise<Message> {
  return new Promise((resolve, reject) => {
    const existing = messages.find(m => m.type === type);
    if (existing) return resolve(existing);
    const start = Date.now();
    const i = setInterval(() => {
      const found = messages.find(m => m.type === type);
      if (found) { clearInterval(i); resolve(found); }
      else if (Date.now() - start > timeout) { clearInterval(i); reject(new Error(`timeout: ${type}`)); }
    }, 5);
  });
}

export async function benchmarkRelayServer(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const port = PORT;

  const server = createRelayServer({
    port,
    host: '127.0.0.1',
    persistDir: `/tmp/resonance-eval-relay-${Date.now()}`,
    maxAuthAttemptsPerMin: 100,
    persistIntervalMs: 999_999,
  });
  await server.start();

  try {
    // --- Auth + publish round-trip ---
    {
      const identity = generateIdentity();
      const { durationMs } = await timeAsync(async () => {
        const conn = await connectAndAuth(port, identity);
        const vec = generateRandomUnitVector(768);
        conn.ws.send(serializeMessage(createMessage<PublishPayload>(MessageTypes.PUBLISH, {
          itemId: 'bench-1', vector: Array.from(vec), itemType: 'offer', ttl: 86400,
        }, identity)));
        await waitForType(conn.messages, MessageTypes.ACK);
        conn.ws.close();
      });

      results.push({
        name: 'Relay auth + publish round-trip',
        target: '<200ms',
        actual: formatMs(durationMs),
        value: durationMs,
        passed: durationMs < 200,
      });
    }

    // --- Match notification latency ---
    {
      const alice = generateIdentity();
      const bob = generateIdentity();
      const aliceConn = await connectAndAuth(port, alice);
      const bobConn = await connectAndAuth(port, bob);

      // Alice publishes an offer
      const offerVec = generateRandomUnitVector(768);
      aliceConn.ws.send(serializeMessage(createMessage<PublishPayload>(MessageTypes.PUBLISH, {
        itemId: 'match-offer', vector: Array.from(offerVec), itemType: 'offer', ttl: 86400,
      }, alice)));
      await waitForType(aliceConn.messages, MessageTypes.ACK);

      // Measure: Bob publishes complementary need → time to MATCH notification
      const needVec = similarVector(offerVec, 0.03);
      const { durationMs } = await timeAsync(async () => {
        bobConn.ws.send(serializeMessage(createMessage<PublishPayload>(MessageTypes.PUBLISH, {
          itemId: 'match-need', vector: needVec, itemType: 'need', ttl: 86400,
        }, bob)));
        await waitForType(bobConn.messages, MessageTypes.MATCH);
      });

      results.push({
        name: 'Match notification latency',
        target: '<100ms',
        actual: formatMs(durationMs),
        value: durationMs,
        passed: durationMs < 100,
      });

      aliceConn.ws.close();
      bobConn.ws.close();
    }

    // --- Persistence save/load ---
    {
      const { MatchingEngine } = await import('@resonance/relay');
      const engine = new MatchingEngine({ maxElements: 10_000 });
      engine.initialize();

      // Insert 1000 vectors
      for (let i = 0; i < 1000; i++) {
        const vec = generateRandomUnitVector(768);
        engine.insertAndMatch(Array.from(vec), {
          did: `did:key:bench-${i}`,
          itemType: i % 2 === 0 ? 'need' : 'offer',
          itemId: `item-${i}`,
        }, 1, 0.99); // high threshold to skip matching
      }

      const dir = `/tmp/resonance-eval-persist-${Date.now()}`;

      const { durationMs: saveMs } = await timeAsync(async () => {
        engine.save(dir);
      });

      const engine2 = new MatchingEngine({ maxElements: 10_000 });
      engine2.initialize();
      const { durationMs: loadMs } = await timeAsync(async () => {
        engine2.load(dir);
      });

      results.push({
        name: 'Index save (1K vectors)',
        target: '<1s',
        actual: formatMs(saveMs),
        value: saveMs,
        passed: saveMs < 1000,
      });

      results.push({
        name: 'Index load (1K vectors)',
        target: '<2s',
        actual: formatMs(loadMs),
        value: loadMs,
        passed: loadMs < 2000,
      });

      // Cleanup
      const { rmSync } = await import('node:fs');
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }

  } finally {
    await server.stop();
  }

  return results;
}
