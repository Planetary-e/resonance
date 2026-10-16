/** Operator-selected pins for reopening a prepared history. This file never authorizes initialization. */
import { dirname, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { parseHistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { exchangeHistoryCheckpoint } from './history-checkpoint-exchange.js';
import type { AdmissionHistoryProtection } from './protected-admission-history.js';
import { readOperatorJson, readOperatorSigningKey } from './admission-operator-files.js';

export function parseAdmissionHistoryConfiguration(value: unknown) {
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
  return { version: 1 as const, context, members, ownerKeyFile: value.ownerKeyFile };
}

/** Caller clears the returned signingKey.secretKey after the protected ledger has copied it. */
export function loadAdmissionHistoryProtectionFile(path: string, onTransportSocket?: (socket: Socket) => void): AdmissionHistoryProtection {
  const { context, members, ownerKeyFile } = parseAdmissionHistoryConfiguration(readOperatorJson(path, 64 * 1024));
  const signingKey = readOperatorSigningKey(resolve(dirname(resolve(path)), ownerKeyFile));
  try {
    if (Buffer.from(signingKey.publicKey).toString('base64url') !== context.owner) throw new Error('Admission history owner key differs from its pinned context');
    return { context, members, signingKey,
      transport: (member, frame, signal) => exchangeHistoryCheckpoint(member, frame, signal, onTransportSocket) };
  } catch (error) { signingKey.secretKey.fill(0); throw error; }
}
