import {
  createLeasedIndexGenerationIdV1,
  parseLeasedIndexOperationV1,
  serializeLeasedIndexOperationV1,
  type LeasedIndexV1,
} from '@resonance/core';
import { LeasedIndexStore } from '@resonance/relay';
import { ActiveFixtureState } from './client-held-search-validation.js';

export interface OracleReconstructionDiagnostics {
  publicationCount: number;
  historyEntryCount: number;
  conflictEntryCount: number;
  operationBytes: number;
  generationCount: number;
  persistedByteCount: number;
  canonicalOperationCount: number;
  activeOperationCount: number;
  matching: { needs: number; offers: number; total: number };
}

export function reconstructRelayFixtureState(
  directory: string,
  fixtureOperations: readonly LeasedIndexV1[],
  now = Date.now,
  canonicalOperations = new Map<string, LeasedIndexV1>(),
  diagnostics?: Partial<OracleReconstructionDiagnostics>,
): ActiveFixtureState {
  for (const operation of fixtureOperations) {
    const generationId = createLeasedIndexGenerationIdV1(operation);
    if (!canonicalOperations.has(generationId)) canonicalOperations.set(generationId, operation);
  }
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
        if (operation.kind !== 'leased-discovery-index') continue;
        const canonical = canonicalOperations.get(match.generationId);
        if (canonical && JSON.stringify(canonical) !== bytes
          && serializeLeasedIndexOperationV1(canonical) !== bytes) {
          throw new Error('Canonical fixture operation differs from relay evidence');
        }
        const retained = canonical ?? operation;
        canonicalOperations.set(match.generationId, retained);
        state.accept(retained);
      }
    }
  }
  if (diagnostics) {
    const states = [...(store as any).publications.values()] as Array<{
      history: Array<{ bytes: string }>;
      conflicts: Array<{ bytes: string }>;
    }>;
    Object.assign(diagnostics, {
      publicationCount: states.length,
      historyEntryCount: states.reduce((sum, state) => sum + state.history.length, 0),
      conflictEntryCount: states.reduce((sum, state) => sum + state.conflicts.length, 0),
      operationBytes: states.reduce((sum, state) => (
        sum + [...state.history, ...state.conflicts].reduce((bytes, item) => bytes + Buffer.byteLength(item.bytes), 0)
      ), 0),
      generationCount: (store as any).generations.size,
      persistedByteCount: (store as any).persistedBytes.size,
      canonicalOperationCount: canonicalOperations.size,
      activeOperationCount: state.activeOperations(now()).length,
      matching: store.matching.getStats(),
    });
  }
  return state;
}

export function reconcileFixtureWithCurrent(
  state: ActiveFixtureState,
  operation: LeasedIndexV1,
  now: number,
  directory?: string,
) {
  const generationId = createLeasedIndexGenerationIdV1(operation);
  const prior = state.operationForPublication(operation.publicationId);
  const store = new LeasedIndexStore();
  if (prior) store.apply(serializeLeasedIndexOperationV1(prior), prior.createdAt);
  const result = store.apply(serializeLeasedIndexOperationV1(operation), now);
  const activeBytes = store.getActiveExactBytes(operation.publicationId, generationId, now);
  const proven = ['accepted', 'duplicate'].includes(result.status)
    && activeBytes === serializeLeasedIndexOperationV1(operation);
  let applied = false;
  if (proven && directory) {
    state.replaceWith(reconstructRelayFixtureState(
      directory, [...state.allOperations(), operation], () => now, new Map(),
    ));
    applied = true;
  } else if (proven) {
    applied = state.acceptReconciled(operation);
  }
  if (applied) state.resolveUncertainty(operation.publicationId);
  return {
    publicationId: operation.publicationId,
    priorGenerationId: prior ? createLeasedIndexGenerationIdV1(prior) : null,
    currentGenerationId: generationId,
    productionApplyStatus: result.status,
    activeExactMatch: activeBytes === serializeLeasedIndexOperationV1(operation),
    status: applied ? 'reconciled' : 'unresolved',
    proof: 'current lookup followed by production-order LeasedIndexStore replay and active exact-byte comparison',
  } as const;
}
