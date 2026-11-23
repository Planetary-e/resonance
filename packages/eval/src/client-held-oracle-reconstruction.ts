import {
  parseLeasedIndexOperationV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { LeasedIndexStore } from '@resonance/relay';
import { ActiveFixtureState } from './client-held-search-validation.js';

export function reconstructRelayFixtureState(
  directory: string,
  fixtureOperations: readonly LeasedIndexV1[],
  now = Date.now,
): ActiveFixtureState {
  const store = new LeasedIndexStore();
  store.load(directory);
  const state = new ActiveFixtureState();
  const scopes = new Set(fixtureOperations.map(operation => (
    `${operation.groupId}\n${operation.fingerprint.epoch}`
  )));
  for (const scope of scopes) {
    for (const queryType of ['offer', 'need'] as const) {
      const matches = store.matching.leasedEntriesInInsertionOrder(queryType)
        .filter(metadata => metadata.scope === scope);
      for (const match of matches) {
        if (!match.generationId) continue;
        const bytes = store.getActiveExactBytes(match.itemId, match.generationId, now());
        if (!bytes) continue;
        const operation = parseLeasedIndexOperationV1(bytes);
        if (operation.kind === 'leased-discovery-index') state.accept(operation);
      }
    }
  }
  return state;
}
