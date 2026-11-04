/** Shared strict issuer configuration; legacy version-one files remain valid. */
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { parseHistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { parseAdmissionHistoryArchiveLimits } from '../../relay/src/admission-history-config.js';
import { parseHistoryAncestrySelection } from '../../relay/src/history-ancestry-source.js';
export function parseProtectedIssuerConfiguration(value: unknown) {
  const optional = ['limits', 'ancestry'].filter(name => value !== null && typeof value === 'object' && Object.hasOwn(value, name));
  if (!exactWitnessFields(value, ['version', 'context', 'members', 'ownerKeyFile', ...optional]) || value.version !== 1
    || typeof value.ownerKeyFile !== 'string' || !value.ownerKeyFile.length || value.ownerKeyFile.length > 4096
    || !Array.isArray(value.members) || value.members.length !== 5) throw new Error('Invalid protected issuer configuration');
  const context = parseHistoryCheckpointContext(value.context);
  if (context.role !== 'admission-issuer') throw new Error('Protected issuer requires its admission-issuer role');
  const members = value.members.map(member => {
    if (!exactWitnessFields(member, ['publicKey', 'endpoint']) || typeof member.publicKey !== 'string' || !context.members.includes(member.publicKey)
      || typeof member.endpoint !== 'string') throw new Error('Invalid pinned issuer history member');
    assertSecureRelayTransportEndpoint(member.endpoint); return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) throw new Error('Issuer requires five distinct pinned members and endpoints');
  return { version: 1 as const, context, members, ownerKeyFile: value.ownerKeyFile,
    limits: parseAdmissionHistoryArchiveLimits(optional.includes('limits') ? value.limits : { archiveBytes: 64 * 1024 * 1024, archiveBlocks: 10001 }),
    ...(optional.includes('ancestry') ? { ancestry: parseHistoryAncestrySelection(value.ancestry) } : {}) };
}
