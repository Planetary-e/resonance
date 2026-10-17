/** Operator-selected pins for reopening a prepared history. This file never authorizes initialization. */
import { dirname, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { parseHistoryBridgeContact } from './history-bridge-config.js';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import { parseHistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { exchangeHistoryCheckpoint } from './history-checkpoint-exchange.js';
import type { AdmissionHistoryProtection } from './protected-admission-history.js';
import { readOperatorJson, readOperatorSigningKey } from './admission-operator-files.js';

export function parseAdmissionHistoryArchiveLimits(value: unknown) {
  if (!exactWitnessFields(value, ['archiveBytes', 'archiveBlocks']) || !Number.isSafeInteger(value.archiveBytes)
    || (value.archiveBytes as number) < 1 || (value.archiveBytes as number) > HISTORY_RECOVERY_MAX_BYTES
    || !Number.isSafeInteger(value.archiveBlocks) || (value.archiveBlocks as number) < 1
    || (value.archiveBlocks as number) > HISTORY_RECOVERY_MAX_BLOCKS) throw new Error('Invalid owner history archive limits');
  return { archiveBytes: value.archiveBytes as number, archiveBlocks: value.archiveBlocks as number };
}
export function parseAdmissionHistoryConfiguration(value: unknown) {
  const hasLimits = value !== null && typeof value === 'object' && Object.hasOwn(value, 'limits');
  if (!exactWitnessFields(value, ['version', 'context', 'members', 'ownerKeyFile', ...(hasLimits ? ['limits'] : [])]) || value.version !== 1
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
  return { version: 1 as const, context, members, ownerKeyFile: value.ownerKeyFile, ...(hasLimits ? { limits: parseAdmissionHistoryArchiveLimits(value.limits) } : {}) };
}

/** Caller clears the returned signingKey.secretKey after the protected ledger has copied it. */
export function loadAdmissionHistoryProtectionFile(path: string, onTransportSocket?: (socket: Socket) => void): AdmissionHistoryProtection {
  const { context, members, ownerKeyFile, limits } = parseAdmissionHistoryConfiguration(readOperatorJson(path, 64 * 1024));
  const signingKey = readOperatorSigningKey(resolve(dirname(resolve(path)), ownerKeyFile));
  try {
    if (Buffer.from(signingKey.publicKey).toString('base64url') !== context.owner) throw new Error('Admission history owner key differs from its pinned context');
    return { context, members, signingKey, ...(limits ? { maxArchiveBytes: limits.archiveBytes, maxArchiveBlocks: limits.archiveBlocks } : {}),
      transport: (member, frame, signal) => exchangeHistoryCheckpoint(member, frame, signal, onTransportSocket) };
  } catch (error) { signingKey.secretKey.fill(0); throw error; }
}

/** Optional reverse-link routing. It can neither select a new member nor initialize history. */
export function readAdmissionHistoryLinksFile(path: string, context: AdmissionHistoryProtection['context']) {
  const value = readOperatorJson(path, 64 * 1024);
  const bridged = value && typeof value === 'object' && 'version' in value && value.version === 2;
  if (!exactWitnessFields(value, bridged ? ['version', 'members', 'bridge'] : ['version', 'members'])
    || value.version !== (bridged ? 2 : 1) || !Array.isArray(value.members) || value.members.length !== 5) throw new Error('Invalid admission history relay links');
  const members = value.members.map(member => {
    if (!exactWitnessFields(member, ['publicKey', 'relayId']) || typeof member.publicKey !== 'string'
      || !context.members.includes(member.publicKey) || typeof member.relayId !== 'string'
      || !/^did:key:z[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(member.relayId)) throw new Error('Invalid admission history relay pin');
    return { publicKey: member.publicKey, relayId: member.relayId };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.relayId)).size !== 5) {
    throw new Error('Admission history relay pins must be distinct');
  }
  const contact = bridged ? parseHistoryBridgeContact(value.bridge) : undefined;
  if (contact && members.some(m => m.relayId === contact.expectedRelayId)) throw new Error('History bridge must differ from its target members');
  return { members: members.map(m => ({ ...m, ...(contact ? { viaRelayId: contact.expectedRelayId! } : {}) })), contacts: contact ? [contact] : [] };
}
