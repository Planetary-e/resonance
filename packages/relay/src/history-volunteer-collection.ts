/** Several independently enrolled histories share one bounded relay transport.
 * The context selector is only routing data; each store authenticates the full
 * owner request and its pinned genesis/generation before accessing evidence. */
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { historyCheckpointContextId, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { readOperatorFile } from './admission-operator-files.js';
import { historySetupContains } from './admission-history-setup.js';
import { parseHistoryVolunteerConfiguration, openConfiguredHistoryVolunteerStore } from './history-volunteer-config.js';
import { HistoryRelayRouter } from './history-relay-router.js';
import { HISTORY_ROLE_LIMITS, type HistoryRoleMethod } from './history-relay-link.js';
import type { HistoryRelayMemberRoute, HistoryRelayBridgeRoute } from './history-relay-bridge.js';
import type { HistoryVolunteerHealth } from './history-health.js';

export const HISTORY_VOLUNTEER_MAX_HISTORIES = 8;
export const HISTORY_VOLUNTEER_COLLECTION_MAX_BYTES = 512 * 1024;
export function parseHistoryVolunteerCollection(raw: unknown, base: string) {
  if (!exactWitnessFields(raw, ['version', 'kind', 'histories', 'controllers']) || raw.version !== 1 || raw.kind !== 'history-volunteer-collection'
    || !Array.isArray(raw.histories) || !raw.histories.length || raw.histories.length > HISTORY_VOLUNTEER_MAX_HISTORIES) {
    throw new Error('Invalid volunteer history collection');
  }
  const controllers = raw.controllers;
  const histories = raw.histories.map(value => {
    if (!exactWitnessFields(value, ['context', 'genesisId', 'directory', 'signingKeyFile', 'storageKeyFile', 'limits'])) throw new Error('Invalid enrolled history in collection');
    return parseHistoryVolunteerConfiguration({ ...value, version: 1, controllers }, base);
  });
  const contextIds = histories.map(history => historyCheckpointContextId(history.context));
  if (new Set(contextIds).size !== histories.length) throw new Error('Duplicate volunteer history context');
  // All roles share this exact infrastructure controller set. No per-role
  // authorization can accidentally widen through a union of controller pins.
  return { histories, contacts: histories[0].contacts };
}
export function readHistoryVolunteerCollectionFile(path: string) {
  const bytes = readOperatorFile(path, HISTORY_VOLUNTEER_COLLECTION_MAX_BYTES);
  try {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Volunteer history collection must be valid UTF-8 JSON'); }
    return parseHistoryVolunteerCollection(value, dirname(resolve(path)));
  } finally { bytes.fill(0); }
}
/** Extract no payload and trust no selector. Unrecognized frame shapes refuse
 * before a store is called; matching shapes still need full signed validation. */
export function historyCollectionContext(method: HistoryRoleMethod, value: unknown): string {
  if (!Object.hasOwn(HISTORY_ROLE_LIMITS, method)) throw new Error('Unknown history collection operation');
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  let request: unknown;
  if (object(value)) {
    if (method === 'provision' || method === 'compaction' && value.kind === 'history-frontier-request') request = value;
    else if (method === 'transfer') request = object(value.authorization) ? value.authorization.request : undefined;
    else if (method === 'compaction' && value.kind === 'history-compaction-proposal') request = value;
    else request = value.request;
  }
  if (!object(request) || !isHistoryDigest(request.contextId)) throw new Error('Missing bounded history context selector');
  return request.contextId;
}

export function openConfiguredHistoryVolunteerCollection(config: ReturnType<typeof readHistoryVolunteerCollectionFile>, acceptNew?: (bytes: number) => boolean,
  ownerMembers?: readonly HistoryRelayMemberRoute[], bridgeRoutes?: readonly HistoryRelayBridgeRoute[]) {
  if (!Array.isArray(config.histories) || !config.histories.length || config.histories.length > HISTORY_VOLUNTEER_MAX_HISTORIES) throw new Error('Invalid history collection capacity');
  const directories = config.histories.map(history => realpathSync(history.directory));
  for (let i = 0; i < directories.length; i++) {
    if (directories.some((path, j) => i !== j && (historySetupContains(path, directories[i]) || historySetupContains(directories[i], path)))) {
      throw new Error('Volunteer history directories must be distinct and non-overlapping');
    }
  }
  const stores = new Map<string, ReturnType<typeof openConfiguredHistoryVolunteerStore>>();
  let router: HistoryRelayRouter | undefined, requestBytes = 0, closed = false;
  function close() {
    if (closed) return; closed = true;
    const errors: unknown[] = [];
    try { router?.close(); } catch (error) { errors.push(error); }
    for (const store of stores.values()) { try { store.close(); } catch (error) { errors.push(error); } }
    stores.clear(); if (errors.length) throw new AggregateError(errors, 'Failed to close all volunteer histories');
  }
  try {
    for (let i = 0; i < config.histories.length; i++) {
      const history = config.histories[i], id = historyCheckpointContextId(history.context);
      if (stores.has(id)) throw new Error('Duplicate volunteer history context');
      stores.set(id, openConfiguredHistoryVolunteerStore({ ...history, directory: directories[i] }, acceptNew ? () => acceptNew(requestBytes) : undefined));
    }
    const handle = (method: HistoryRoleMethod, value: unknown) => {
      if (closed) throw new Error('Volunteer history collection is closed');
      const store = stores.get(historyCollectionContext(method, value));
      if (!store) throw new Error('History context is not enrolled in this collection');
      requestBytes = Buffer.byteLength(JSON.stringify(value));
      if (requestBytes > HISTORY_ROLE_LIMITS[method][0]) { requestBytes = 0; throw new Error('History collection request exceeds its bound'); }
      try { return method === 'agreement' ? store.exchange(value) : store[method](value); }
      finally { requestBytes = 0; }
    };
    router = new HistoryRelayRouter({ members: ownerMembers, bridgeRoutes, acceptForward: acceptNew,
      waitForConnection: !!ownerMembers || !!bridgeRoutes, acceptedRelayIds: config.contacts.map(c => c.expectedRelayId!), handler: handle });
    return { router, handle, close,
      health(): HistoryVolunteerHealth & { histories: number } {
        if (closed) throw new Error('Volunteer history collection is closed');
        const all = [...stores.values()].map(store => store.health()), total = { ...all[0] };
        for (const health of all.slice(1)) for (const key of Object.keys(total) as Array<keyof HistoryVolunteerHealth>) {
          if (key !== 'histories') total[key] += health[key];
        }
        return { ...total, histories: all.length };
      } };
  } catch (error) { try { close(); } catch (closing) { throw new AggregateError([error, closing], 'Volunteer collection startup and cleanup failed'); } throw error; }
}
