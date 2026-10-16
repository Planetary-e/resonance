/** Operator-selected pins for reopening a prepared history. This file never authorizes initialization. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from '@resonance/core/admission-witness';
import { parseHistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { exchangeHistoryCheckpoint } from './history-checkpoint-exchange.js';
import type { AdmissionHistoryProtection } from './protected-admission-history.js';

/** Read through one descriptor, reject devices/directories, and bound a file that grows during the read. */
function jsonFile(path: string, maximum: number): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK), bytes = Buffer.alloc(maximum + 1);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Admission history input must be a bounded regular file');
    let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
    if (used > maximum) throw new Error('Admission history input exceeds its size limit');
    try { return JSON.parse(bytes.toString('utf8', 0, used)); }
    catch { throw new Error('Admission history input is not valid JSON'); }
  } finally { bytes.fill(0); closeSync(fd); }
}

/** Caller clears the returned signingKey.secretKey after the protected ledger has copied it. */
export function loadAdmissionHistoryProtectionFile(path: string, onTransportSocket?: (socket: Socket) => void): AdmissionHistoryProtection {
  const value = jsonFile(path, 64 * 1024);
  if (!exactWitnessFields(value, ['version', 'context', 'members', 'ownerKeyFile']) || value.version !== 1
    || typeof value.ownerKeyFile !== 'string' || !value.ownerKeyFile.length || value.ownerKeyFile.length > 4096
    || !Array.isArray(value.members) || value.members.length !== 5) throw new Error('Invalid admission history configuration');
  const context = parseHistoryCheckpointContext(value.context);
  const members = value.members.map(member => {
    if (!exactWitnessFields(member, ['publicKey', 'endpoint']) || typeof member.publicKey !== 'string'
      || !context.members.includes(member.publicKey) || typeof member.endpoint !== 'string') throw new Error('Invalid pinned history member');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('Admission history requires five distinct pinned members and endpoints');
  }
  const encoded = jsonFile(resolve(dirname(resolve(path)), value.ownerKeyFile), 4096);
  if (!exactWitnessFields(encoded, ['publicKey', 'secretKey']) || !witnessBytes(encoded.publicKey, 32)
    || !witnessBytes(encoded.secretKey, 64)) throw new Error('Invalid admission history owner key');
  const secretKey = Buffer.from(encoded.secretKey, 'base64url');
  let signingKey: AdmissionHistoryProtection['signingKey'] | undefined;
  try {
    signingKey = copyAdmissionSigningKey({ publicKey: Buffer.from(encoded.publicKey, 'base64url'), secretKey });
    if (encoded.publicKey !== context.owner) throw new Error('Admission history owner key differs from its pinned context');
    return { context, members, signingKey,
      transport: (member, frame, signal) => exchangeHistoryCheckpoint(member, frame, signal, onTransportSocket) };
  } catch (error) { signingKey?.secretKey.fill(0); throw error; }
  finally { secretKey.fill(0); encoded.secretKey = ''; }
}
