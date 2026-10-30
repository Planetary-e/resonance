import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';

export interface LabTrafficRecord {
  messageId: string;
  responseTo?: string;
  source: string;
  destination: string;
  direction: 'outbound' | 'inbound';
  purpose: string;
  transport: 'websocket-loopback';
  payloadBytes: number;
  frameBytes: number;
  outcome: 'sent' | 'received' | 'received-refused' | 'failed';
}

export interface LabEndpoint {
  role: string;
  endpoint: string;
}

interface Envelope {
  version: 1;
  messageId: string;
  responseTo?: string;
  sender: string;
  recipient: string;
  purpose: string;
  payload?: unknown;
  error?: string;
  auth: string;
}

const secrets = new Map<string, Buffer>();
const traffic: LabTrafficRecord[] = [];

function secretBytes(secret: string): Buffer {
  const cached = secrets.get(secret);
  if (cached) return cached;
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32) throw new Error('Laboratory authentication key must be 32 bytes');
  secrets.set(secret, bytes);
  return bytes;
}

function body(envelope: Envelope): string {
  const { auth: _auth, ...unsigned } = envelope;
  return JSON.stringify(unsigned);
}

function authentication(envelope: Envelope, secret: string): string {
  return createHmac('sha256', secretBytes(secret)).update(body(envelope)).digest('base64url');
}

function seal(envelope: Omit<Envelope, 'auth'>, secret: string): Envelope {
  const unsigned = { ...envelope, auth: '' } as Envelope;
  return { ...envelope, auth: authentication(unsigned, secret) };
}

function openEnvelope(value: unknown, secret: string): Envelope {
  if (!value || typeof value !== 'object') throw new Error('Invalid laboratory envelope');
  const envelope = value as Envelope;
  if (envelope.version !== 1 || typeof envelope.messageId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(envelope.messageId)
    || typeof envelope.sender !== 'string' || typeof envelope.recipient !== 'string' || typeof envelope.purpose !== 'string'
    || typeof envelope.auth !== 'string') throw new Error('Invalid laboratory envelope fields');
  const expected = Buffer.from(authentication(envelope, secret));
  const actual = Buffer.from(envelope.auth);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Unauthenticated laboratory envelope');
  return envelope;
}

function frameBytes(payloadBytes: number, masked: boolean): number {
  const extended = payloadBytes < 126 ? 0 : payloadBytes <= 65535 ? 2 : 8;
  return payloadBytes + 2 + extended + (masked ? 4 : 0);
}

export function recordLabTraffic(record: LabTrafficRecord): void {
  traffic.push({ ...record });
}

export function labTrafficSnapshot(): LabTrafficRecord[] {
  return traffic.map(record => ({ ...record }));
}

export function labPayloadDigest(payload: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex')}`;
}

export async function listenLabWorker(options: {
  role: string;
  secret: string | ((sender: string, purpose: string) => string);
  maxPayloadBytes?: number;
  handler: (purpose: string, payload: unknown, sender: string) => Promise<unknown>;
}): Promise<LabEndpoint & { close(): Promise<void> }> {
  const seen = new Set<string>();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false, maxPayload: options.maxPayloadBytes ?? 64 * 1024 ** 2 });
  wss.on('error', error => console.error(`Laboratory listener error ${options.role}: ${error.message.slice(0, 256)}`));
  wss.on('connection', ws => {
    ws.on('error', error => console.error(`Laboratory socket error ${options.role}: ${error.message.slice(0, 256)}`));
    ws.on('close', (code, reason) => console.error(`Laboratory socket close ${options.role}: ${code} ${String(reason).slice(0, 128)}`));
    ws.once('message', data => {
      void (async () => {
        let request: Envelope | undefined, channelSecret: string | undefined, parsedEnvelope: Envelope | undefined, text = '';
        try {
          text = data.toString(); parsedEnvelope = JSON.parse(text) as Envelope;
          channelSecret = typeof options.secret === 'function' ? options.secret(parsedEnvelope.sender, parsedEnvelope.purpose) : options.secret;
          request = openEnvelope(parsedEnvelope, channelSecret);
          recordLabTraffic({ messageId: request.messageId, source: request.sender, destination: request.recipient,
            direction: 'inbound', purpose: request.purpose, transport: 'websocket-loopback', payloadBytes: Buffer.byteLength(text),
            frameBytes: frameBytes(Buffer.byteLength(text), true), outcome: 'received' });
          if (request.recipient !== options.role || request.responseTo || seen.has(request.messageId)) throw new Error('Invalid laboratory request');
          seen.add(request.messageId);
          const payload = await options.handler(request.purpose, request.payload, request.sender);
          const response = seal({ version: 1, messageId: randomBytes(16).toString('base64url'), responseTo: request.messageId,
            sender: options.role, recipient: request.sender, purpose: request.purpose, payload }, channelSecret);
          const encoded = JSON.stringify(response);
          ws.send(encoded, error => {
            recordLabTraffic({ messageId: response.messageId, responseTo: response.responseTo, source: response.sender, destination: response.recipient,
              direction: 'outbound', purpose: response.purpose, transport: 'websocket-loopback', payloadBytes: Buffer.byteLength(encoded),
              frameBytes: frameBytes(Buffer.byteLength(encoded), false), outcome: error ? 'failed' : 'sent' });
            ws.close(error ? 1011 : 1000);
          });
        } catch (error) {
          const reason = (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 384);
          console.error(`Laboratory channel refusal ${options.role}: ${reason}`);
          if (!request && parsedEnvelope && typeof parsedEnvelope.messageId === 'string') {
            recordLabTraffic({ messageId: parsedEnvelope.messageId, source: parsedEnvelope.sender, destination: parsedEnvelope.recipient,
              direction: 'inbound', purpose: parsedEnvelope.purpose, transport: 'websocket-loopback', payloadBytes: Buffer.byteLength(text),
              frameBytes: frameBytes(Buffer.byteLength(text), true), outcome: 'received-refused' });
          }
          if (request && channelSecret) {
            const response = seal({ version: 1, messageId: randomBytes(16).toString('base64url'), responseTo: request.messageId,
              sender: options.role, recipient: request.sender, purpose: request.purpose, error: `Laboratory request refused: ${reason}` }, channelSecret);
            const encoded = JSON.stringify(response);
            ws.send(encoded, () => {
              recordLabTraffic({ messageId: response.messageId, responseTo: response.responseTo, source: response.sender, destination: response.recipient,
                direction: 'outbound', purpose: response.purpose, transport: 'websocket-loopback', payloadBytes: Buffer.byteLength(encoded),
                frameBytes: frameBytes(Buffer.byteLength(encoded), false), outcome: 'sent' });
              ws.close(4003, 'refused');
            });
          } else ws.close(4003, 'refused');
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => { wss.removeListener('error', reject); resolve(); });
  });
  return {
    role: options.role,
    endpoint: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/lab`,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    },
  };
}

export async function callLabWorker<T>(options: {
  sender: string;
  target: LabEndpoint;
  secret: string;
  purpose: string;
  payload?: unknown;
  timeoutMs?: number;
  expectRefusal?: boolean;
}): Promise<T> {
  const request = seal({ version: 1, messageId: randomBytes(16).toString('base64url'), sender: options.sender,
    recipient: options.target.role, purpose: options.purpose, ...(options.payload === undefined ? {} : { payload: options.payload }) }, options.secret);
  const encoded = JSON.stringify(request), payloadBytes = Buffer.byteLength(encoded);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(options.target.endpoint, { perMessageDeflate: false, handshakeTimeout: 10_000,
      maxPayload: 64 * 1024 ** 2, followRedirects: false });
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      if (error && options.expectRefusal) recordLabTraffic({ messageId: request.messageId, responseTo: request.messageId,
        source: request.recipient, destination: request.sender, direction: 'inbound', purpose: request.purpose,
        transport: 'websocket-loopback', payloadBytes: 0, frameBytes: 0, outcome: 'received-refused' });
      settled = true; clearTimeout(timer); ws.terminate();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`Laboratory request timed out: ${options.purpose}`)), options.timeoutMs ?? 120_000);
    ws.on('error', error => finish(error));
    ws.on('open', () => {
      ws.send(encoded, error => {
        recordLabTraffic({ messageId: request.messageId, source: request.sender, destination: request.recipient,
          direction: 'outbound', purpose: request.purpose, transport: 'websocket-loopback', payloadBytes,
          frameBytes: frameBytes(payloadBytes, true), outcome: error ? 'failed' : 'sent' });
        if (error) finish(error);
      });
    });
    ws.on('message', data => {
      try {
        const text = data.toString(), response = openEnvelope(JSON.parse(text), options.secret);
        recordLabTraffic({ messageId: response.messageId, responseTo: response.responseTo, source: response.sender, destination: response.recipient,
          direction: 'inbound', purpose: response.purpose, transport: 'websocket-loopback', payloadBytes: Buffer.byteLength(text),
          frameBytes: frameBytes(Buffer.byteLength(text), false), outcome: 'received' });
        if (response.responseTo !== request.messageId || response.sender !== options.target.role
          || response.recipient !== options.sender || response.purpose !== options.purpose) throw new Error('Laboratory response identity differs');
        if (response.error) throw new Error(`${response.error}: ${options.purpose}`);
        finish(undefined, response.payload as T);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    ws.on('close', (code, reason) => { if (!settled) finish(new Error(`Laboratory connection closed: ${options.purpose} (${code} ${String(reason).slice(0, 128)})`)); });
  });
}

export function clearLabTrafficForTests(): void {
  traffic.length = 0;
}
