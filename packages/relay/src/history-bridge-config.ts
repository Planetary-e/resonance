/** Explicit opt-in forwarding permissions. No storage/key initialization or peer
 * advertisement can add a route to this table. */
import { assertSecureRelayTransportEndpoint, createRelayContactHintV1 } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { readOperatorJson } from './admission-operator-files.js';
import { isHistoryRelayId } from './history-relay-bridge.js';

export function parseHistoryBridgeContact(value: unknown) {
  if (!exactWitnessFields(value, ['relayId', 'endpoint']) || !isHistoryRelayId(value.relayId)
    || typeof value.endpoint !== 'string' || !value.endpoint.length || value.endpoint.length > 2048) throw new Error('Invalid history bridge contact');
  assertSecureRelayTransportEndpoint(value.endpoint);
  return createRelayContactHintV1('configured', value.endpoint, value.relayId);
}
export function readHistoryBridgeConfigurationFile(path: string) {
  const value = readOperatorJson(path, 64 * 1024);
  if (!exactWitnessFields(value, ['version', 'routes']) || value.version !== 1 || !Array.isArray(value.routes)
    || value.routes.length < 1 || value.routes.length > 32) throw new Error('Invalid history bridge configuration');
  const routes = value.routes.map(route => {
    if (!exactWitnessFields(route, ['controllerRelayId', 'targetRelayId']) || !isHistoryRelayId(route.controllerRelayId)
      || !isHistoryRelayId(route.targetRelayId) || route.controllerRelayId === route.targetRelayId) throw new Error('Invalid history bridge route');
    return { controllerRelayId: route.controllerRelayId, targetRelayId: route.targetRelayId };
  });
  if (new Set(routes.map(r => `${r.controllerRelayId}:${r.targetRelayId}`)).size !== routes.length
    || new Set(routes.flatMap(r => [r.controllerRelayId, r.targetRelayId])).size > 32) throw new Error('History bridge routes must be distinct and bounded');
  return { routes };
}
