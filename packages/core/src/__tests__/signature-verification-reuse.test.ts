import { beforeEach, expect, it, vi } from 'vitest';
import { verify as primitiveVerify } from 'node:crypto';
import { generateSigningKeyPair, sign, verify, withSuccessfulEd25519VerificationReuse, type SuccessfulEd25519VerificationUsage } from '../crypto.js';
const controls = vi.hoisted(() => ({ collide: false }));
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, verify: vi.fn(actual.verify), createHash: (...args: Parameters<typeof actual.createHash>) => controls.collide
    ? { update() { return this; }, digest() { return 'same-index'; } } : actual.createHash(...args) };
});
beforeEach(() => { vi.mocked(primitiveVerify).mockClear(); controls.collide = false; });
const check = () => {};
const key = generateSigningKeyPair(), other = generateSigningKeyPair();
const message = Buffer.from('resonance:domain:a\ncomplete payload'), signature = sign(message, key.secretKey);

it('reuses only exact successful bytes within its owner, and reports actual primitive work', async () => {
  let read!: () => Readonly<SuccessfulEd25519VerificationUsage>;
  await withSuccessfulEd25519VerificationReuse({ check }, usage => {
    read = usage;
    expect(verify(message, signature, key.publicKey)).toBe(true);
    expect(verify(Buffer.from(message), Uint8Array.from(signature), Uint8Array.from(key.publicKey))).toBe(true);
    expect(usage()).toMatchObject({ attempts: 2, primitiveCalls: 1, hits: 1, entries: 1 });
    expect(Object.isFrozen(usage())).toBe(true);
  });
  expect(read()).toMatchObject({ entries: 0, retainedBytes: 0 });
  expect(verify(message, signature, key.publicKey)).toBe(true);
  await withSuccessfulEd25519VerificationReuse({ check }, () => expect(verify(message, signature, key.publicKey)).toBe(true));
  expect(primitiveVerify).toHaveBeenCalledTimes(3);
});

it('captures mutable inputs and refuses changed message/domain/key/signature on every occurrence', async () => {
  await withSuccessfulEd25519VerificationReuse({ check }, usage => {
    const m = Buffer.from(message), s = Uint8Array.from(signature), p = Uint8Array.from(key.publicKey);
    expect(verify(m, s, p)).toBe(true);
    for (const input of [m, s, p]) {
      input[0] ^= 1; expect(verify(m, s, p)).toBe(false); input[0] ^= 1;
      expect(verify(m, s, p)).toBe(true);
    }
    expect(verify(Buffer.from(message.toString().replace('domain:a', 'domain:b')), s, p)).toBe(false);
    expect(verify(m, s, other.publicKey)).toBe(false);
    expect(usage()).toMatchObject({ primitiveCalls: 6, hits: 3, entries: 1 });
  });
});

it('does not admit rejected signatures or malformed inputs', async () => {
  const wrong = Uint8Array.from(signature); wrong[0] ^= 1;
  await withSuccessfulEd25519VerificationReuse({ check }, usage => {
    expect(verify(message, wrong, key.publicKey)).toBe(false);
    expect(verify(message, wrong, key.publicKey)).toBe(false);
    expect(verify(message, signature.subarray(1), key.publicKey)).toBe(false);
    expect(verify(message, signature, key.publicKey.subarray(1))).toBe(false);
    expect(usage()).toMatchObject({ primitiveCalls: 2, hits: 0, entries: 0 });
    expect(verify(message, signature, key.publicKey)).toBe(true);
  });
  expect(primitiveVerify).toHaveBeenCalledTimes(3);
});

it('compares complete bytes even when the index digest collides', async () => {
  controls.collide = true;
  await withSuccessfulEd25519VerificationReuse({ check }, usage => {
    expect(verify(message, signature, key.publicKey)).toBe(true);
    expect(verify(Buffer.from('different'), signature, key.publicKey)).toBe(false);
    expect(verify(message, signature, other.publicKey)).toBe(false);
    const m = Buffer.from('different'), s = sign(m, key.secretKey);
    expect(verify(m, s, key.publicKey)).toBe(true);
    expect(verify(m, s, key.publicKey)).toBe(true);
    expect(usage()).toMatchObject({ primitiveCalls: 4, hits: 1, entries: 2 });
  });
});

it('keeps nested and concurrent scopes independent without resetting the outer work', async () => {
  await withSuccessfulEd25519VerificationReuse({ check }, async outer => {
    expect(verify(message, signature, key.publicKey)).toBe(true);
    await withSuccessfulEd25519VerificationReuse({ check }, inner => {
      expect(verify(message, signature, key.publicKey)).toBe(true);
      expect(inner()).toMatchObject({ primitiveCalls: 1, hits: 0 });
    });
    expect(verify(message, signature, key.publicKey)).toBe(true);
    expect(outer()).toMatchObject({ primitiveCalls: 1, hits: 1 });
  });
  await Promise.all([1, 2].map(() => withSuccessfulEd25519VerificationReuse({ check }, async usage => {
    expect(verify(message, signature, key.publicKey)).toBe(true); await Promise.resolve();
    expect(verify(message, signature, key.publicKey)).toBe(true);
    expect(usage()).toMatchObject({ primitiveCalls: 1, hits: 1 });
  })));
  expect(primitiveVerify).toHaveBeenCalledTimes(4);
});

it.each(['resolve', 'reject'] as const)('closes %s scopes for detached child tasks and clears retained memory', async outcome => {
  let release!: () => void, child!: Promise<boolean>, read!: () => Readonly<SuccessfulEd25519VerificationUsage>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const operation = withSuccessfulEd25519VerificationReuse({ check }, usage => {
    read = usage; expect(verify(message, signature, key.publicKey)).toBe(true);
    child = (async () => { await gate; return verify(message, signature, key.publicKey); })();
    if (outcome === 'reject') throw new Error('failed operation');
  });
  if (outcome === 'reject') await expect(operation).rejects.toThrow('failed operation'); else await operation;
  expect(read()).toMatchObject({ entries: 0, retainedBytes: 0 }); release(); expect(await child).toBe(true);
  expect(primitiveVerify).toHaveBeenCalledTimes(2);
});

it('checks existing cancellation/deadline on hits, and clears failed owners', async () => {
  const abort = new AbortController(); let read!: () => Readonly<SuccessfulEd25519VerificationUsage>;
  await expect(withSuccessfulEd25519VerificationReuse({ check: () => { if (abort.signal.aborted) throw new Error('cancelled'); } }, usage => {
    read = usage; expect(verify(message, signature, key.publicKey)).toBe(true); abort.abort(); verify(message, signature, key.publicKey);
  })).rejects.toThrow('cancelled');
  expect(read()).toMatchObject({ entries: 0, retainedBytes: 0 });
  let expired = false;
  await expect(withSuccessfulEd25519VerificationReuse({ check: () => { if (expired) throw new Error('deadline'); } }, () => {
    expect(verify(message, signature, key.publicKey)).toBe(true); expired = true;
  })).rejects.toThrow('deadline');
  expect(primitiveVerify).toHaveBeenCalledTimes(2);
});

it.each([{ maxEntries: 1 }, { maxBytes: 96 + message.byteLength + 1024 }])('falls back safely on entry/byte saturation: %j', async limits => {
  const m = Buffer.from('second payload'), s = sign(m, key.secretKey);
  await withSuccessfulEd25519VerificationReuse({ check, ...limits }, usage => {
    expect(verify(message, signature, key.publicKey)).toBe(true);
    expect(verify(m, s, key.publicKey)).toBe(true); expect(verify(m, s, key.publicKey)).toBe(true);
    expect(verify(message, signature, key.publicKey)).toBe(true);
    expect(usage()).toMatchObject({ primitiveCalls: 3, hits: 1, entries: 1 });
    expect(usage().retainedBytes).toBeLessThanOrEqual(limits.maxBytes ?? 8 * 1024 * 1024);
  });
});

it('does no retention/copy admission for oversized messages or zero caps, and rejects expanded caps', async () => {
  await withSuccessfulEd25519VerificationReuse({ check, maxBytes: 0 }, usage => {
    expect(verify(message, signature, key.publicKey)).toBe(true); expect(verify(message, signature, key.publicKey)).toBe(true);
    expect(usage()).toMatchObject({ primitiveCalls: 2, hits: 0, entries: 0, retainedBytes: 0 });
  });
  await expect(withSuccessfulEd25519VerificationReuse({ check, maxBytes: 8 * 1024 * 1024 + 1 }, () => {})).rejects.toThrow('bounds');
  await expect(withSuccessfulEd25519VerificationReuse({ check, maxEntries: 4097 }, () => {})).rejects.toThrow('bounds');
});
