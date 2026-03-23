import { describe, it, expect } from 'vitest';
import { generateIdentity } from '../crypto.js';
import {
  createMessage,
  verifyMessage,
  parseMessage,
  serializeMessage,
  MessageTypes,
  type PublishPayload,
  type MatchPayload,
  type SearchPayload,
} from '../protocol.js';

describe('createMessage', () => {
  it('creates a signed message envelope', () => {
    const id = generateIdentity();
    const payload: PublishPayload = {
      itemId: 'test-123',
      vector: [0.1, 0.2, 0.3],
      itemType: 'offer',
      ttl: 604800,
    };

    const msg = createMessage(MessageTypes.PUBLISH, payload, id);

    expect(msg.type).toBe('publish');
    expect(msg.from).toBe(id.did);
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(msg.signature).toBeTruthy();
    expect(msg.payload).toEqual(payload);
  });

  it('signature is a base64 string', () => {
    const id = generateIdentity();
    const msg = createMessage('test', { data: 'hello' }, id);
    // Base64 regex
    expect(msg.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('verifyMessage', () => {
  it('verifies a valid message', () => {
    const id = generateIdentity();
    const msg = createMessage(MessageTypes.SEARCH, { vector: [1, 2, 3], k: 5, threshold: 0.5 } satisfies SearchPayload, id);
    expect(verifyMessage(msg)).toBe(true);
  });

  it('rejects tampered payload', () => {
    const id = generateIdentity();
    const msg = createMessage('test', { value: 'original' }, id);
    msg.payload = { value: 'tampered' };
    expect(verifyMessage(msg)).toBe(false);
  });

  it('rejects tampered type', () => {
    const id = generateIdentity();
    const msg = createMessage('publish', { itemId: 'x' }, id);
    msg.type = 'withdraw';
    expect(verifyMessage(msg)).toBe(false);
  });

  it('rejects tampered timestamp', () => {
    const id = generateIdentity();
    const msg = createMessage('test', {}, id);
    msg.timestamp = msg.timestamp + 1;
    expect(verifyMessage(msg)).toBe(false);
  });

  it('rejects wrong sender DID', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const msg = createMessage('test', {}, a);
    msg.from = b.did; // Claim to be B but signed by A
    expect(verifyMessage(msg)).toBe(false);
  });

  it('accepts with explicit public key', () => {
    const id = generateIdentity();
    const msg = createMessage('test', {}, id);
    expect(verifyMessage(msg, id.publicKey)).toBe(true);
  });
});

describe('parseMessage', () => {
  it('parses a valid message JSON', () => {
    const id = generateIdentity();
    const msg = createMessage(MessageTypes.MATCH, {
      matchId: 'm-1',
      partnerDID: 'did:key:z6Mktest',
      similarity: 0.85,
      yourItemId: 'item-1',
      partnerItemType: 'offer',
      expiry: Date.now() + 86400000,
    } satisfies MatchPayload, id);

    const raw = serializeMessage(msg);
    const parsed = parseMessage(raw);

    expect(parsed.type).toBe('match');
    expect(parsed.from).toBe(id.did);
    expect(parsed.payload).toEqual(msg.payload);
  });

  it('rejects missing type', () => {
    expect(() => parseMessage('{"from":"x","timestamp":1,"signature":"x","payload":{}}')).toThrow('type');
  });

  it('rejects missing from', () => {
    expect(() => parseMessage('{"type":"x","timestamp":1,"signature":"x","payload":{}}')).toThrow('from');
  });

  it('rejects missing timestamp', () => {
    expect(() => parseMessage('{"type":"x","from":"x","signature":"x","payload":{}}')).toThrow('timestamp');
  });

  it('rejects missing signature', () => {
    expect(() => parseMessage('{"type":"x","from":"x","timestamp":1,"payload":{}}')).toThrow('signature');
  });

  it('rejects missing payload', () => {
    expect(() => parseMessage('{"type":"x","from":"x","timestamp":1,"signature":"x"}')).toThrow('payload');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseMessage('not json')).toThrow();
  });
});

describe('serializeMessage', () => {
  it('produces valid JSON', () => {
    const id = generateIdentity();
    const msg = createMessage('test', { key: 'value' }, id);
    const json = serializeMessage(msg);
    expect(JSON.parse(json)).toEqual(msg);
  });
});

describe('MessageTypes', () => {
  it('has all expected types', () => {
    expect(MessageTypes.PUBLISH).toBe('publish');
    expect(MessageTypes.SEARCH).toBe('search');
    expect(MessageTypes.CONSENT).toBe('consent');
    expect(MessageTypes.WITHDRAW).toBe('withdraw');
    expect(MessageTypes.MATCH).toBe('match');
    expect(MessageTypes.SEARCH_RESULTS).toBe('search_results');
    expect(MessageTypes.CONSENT_FORWARD).toBe('consent_forward');
    expect(MessageTypes.ACK).toBe('ack');
    expect(MessageTypes.CONFIRM_EMBEDDING).toBe('confirm_embedding');
    expect(MessageTypes.CONFIRM_RESULT).toBe('confirm_result');
    expect(MessageTypes.DISCLOSURE).toBe('disclosure');
    expect(MessageTypes.ACCEPT).toBe('accept');
    expect(MessageTypes.REJECT).toBe('reject');
    expect(MessageTypes.CLOSE).toBe('close');
  });
});
