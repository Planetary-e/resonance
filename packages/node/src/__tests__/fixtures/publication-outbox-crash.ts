import { join } from 'node:path';
import { createPublicationRecord, generatePublicationKeyMaterial } from '@resonance/core';
import { openPublicationOutbox } from '../../publication-outbox.js';
const [directory, key, mode] = process.argv.slice(2);
const box = openPublicationOutbox({ path: join(directory, 'outbox'), encryptionKey: Buffer.from(key, 'hex') });
const at = Date.now();
const held = box.hold(createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
  fingerprint: new Uint8Array(64).fill(0xab), itemType: 'offer', createdAt: at, expiresAt: at + 86_400_000,
}, generatePublicationKeyMaterial()), { relayUrl: 'ws://[::1]:1/', fallbackUrls: [], privateEntryUrls: ['ws://127.0.0.1:1/'] });
process.on('message', () => {}); // Keep the holding process open without timers or network polling.
if (mode === 'sending') void box.release(held.id).catch(() => {});
process.send?.(held.id);
