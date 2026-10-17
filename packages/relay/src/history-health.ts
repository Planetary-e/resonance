/** Local aggregate telemetry. None of these observations establishes a live quorum. */
export interface HistoryOwnerHealth {
  initialized: boolean; busy: boolean; pending: boolean;
  retainedBlocks: number; retainedCiphertextBytes: number;
  maximumBlocks: number; maximumCiphertextBytes: number;
}
export interface HistoryVolunteerHealth {
  generations: number; maximumGenerations: number;
  retainedBlocks: number; stagedBlocks: number; retainedCiphertextBytes: number;
  manifestReserveBytes: number; reservedBytes: number;
  currentGenerationReservedBytes: number; currentGenerationBlocks: number;
  maximumGenerationBytes: number; maximumGenerationBlocks: number; maximumAncestryBytes: number;
}
export interface HistoryTransportHealth {
  configuredMembers: number; connectedDirectMembers: number;
  configuredOwnerBridges: number; connectedOwnerBridges: number;
  configuredBridgeRoutes: number; connectedBridgeTargets: number;
  configuredControllers: number; connectedControllers: number;
  operations: number; maximumOperations: number; bufferBytes: number; maximumBufferBytes: number;
}
export type HistoryRoleHealth<T> = { state: 'available'; usage: T } | { state: 'starting' | 'unavailable' };
export interface RelayHistoryHealth {
  owner: HistoryRoleHealth<HistoryOwnerHealth> | null;
  volunteer: HistoryRoleHealth<HistoryVolunteerHealth> | null;
  transport: HistoryRoleHealth<HistoryTransportHealth> | null;
}
function observe<T>(configured: boolean, read?: () => T): HistoryRoleHealth<T> | null {
  if (!configured) return null;
  if (!read) return { state: 'starting' };
  try { return { state: 'available', usage: read() }; }
  catch { return { state: 'unavailable' }; }
}
/** Never return errors, pins, roots, payloads, keys, request bindings or peer lists. */
export function readRelayHistoryHealth(options: {
  ownerConfigured: boolean; owner?: () => HistoryOwnerHealth;
  volunteer?: () => HistoryVolunteerHealth; transport?: () => HistoryTransportHealth;
}): RelayHistoryHealth {
  return parseRelayHistoryHealth({ owner: observe(options.ownerConfigured, options.owner), volunteer: observe(!!options.volunteer, options.volunteer),
    transport: observe(!!options.transport, options.transport) })!;
}

/** Project an untrusted stats response onto the public aggregate fields only. */
export function parseRelayHistoryHealth(value: unknown): RelayHistoryHealth | null {
  const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw);
  if (!object(value)) return null;
  function role<T>(raw: unknown, numbers: string[], booleans: string[] = []): HistoryRoleHealth<T> | null {
    if (raw === null) return null;
    if (!object(raw)) return { state: 'unavailable' };
    if (raw.state === 'starting' || raw.state === 'unavailable') return { state: raw.state };
    if (raw.state !== 'available' || !object(raw.usage)) return { state: 'unavailable' };
    const usage: Record<string, number | boolean> = {};
    for (const key of numbers) {
      const n = raw.usage[key];
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return { state: 'unavailable' };
      usage[key] = n;
    }
    for (const key of booleans) {
      const b = raw.usage[key]; if (typeof b !== 'boolean') return { state: 'unavailable' }; usage[key] = b;
    }
    return { state: 'available', usage: usage as T };
  }
  return {
    owner: role(value.owner, ['retainedBlocks', 'retainedCiphertextBytes', 'maximumBlocks', 'maximumCiphertextBytes'], ['initialized', 'busy', 'pending']),
    volunteer: role(value.volunteer, ['generations', 'maximumGenerations', 'retainedBlocks', 'stagedBlocks', 'retainedCiphertextBytes',
      'manifestReserveBytes', 'reservedBytes', 'currentGenerationReservedBytes', 'currentGenerationBlocks', 'maximumGenerationBytes', 'maximumGenerationBlocks', 'maximumAncestryBytes']),
    transport: role(value.transport, ['configuredMembers', 'connectedDirectMembers', 'configuredOwnerBridges', 'connectedOwnerBridges',
      'configuredBridgeRoutes', 'connectedBridgeTargets', 'configuredControllers', 'connectedControllers', 'operations', 'maximumOperations', 'bufferBytes', 'maximumBufferBytes']),
  };
}
