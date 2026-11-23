import {
  createLeasedIndexGenerationIdV1,
  decodeBase64,
  isLeasedIndexActiveV1,
  parseLeasedIndexOperationV1,
  verifyLeasedIndexV1,
  type LeasedIndexSearchRequestV1,
  type LeasedIndexV1,
} from '@resonance/core';

export type FixturePublicationStatus = 'active' | 'conflict' | 'withdrawn';

interface FixturePublication {
  operation: LeasedIndexV1;
  generationId: string;
  status: FixturePublicationStatus;
}

export class ActiveFixtureState {
  private publications = new Map<string, FixturePublication>();
  private pendingUncertainty = new Set<string>();

  constructor(operations: readonly LeasedIndexV1[] = []) {
    for (const operation of operations) this.accept(operation);
  }

  accept(operation: LeasedIndexV1): void {
    const generationId = createLeasedIndexGenerationIdV1(operation);
    const current = this.publications.get(operation.publicationId);
    if (current && operation.leaseSequence < current.operation.leaseSequence) return;
    if (current?.generationId === generationId) return;
    const status = current && operation.leaseSequence === current.operation.leaseSequence
      ? 'conflict'
      : 'active';
    this.publications.delete(operation.publicationId);
    this.publications.set(operation.publicationId, { operation, generationId, status });
  }

  mark(publicationId: string, status: Exclude<FixturePublicationStatus, 'active'>): void {
    const current = this.publications.get(publicationId);
    if (!current) throw new Error('Unknown fixture publication');
    this.publications.set(publicationId, { ...current, status });
  }

  markUncertain(publicationId: string): void {
    this.pendingUncertainty.add(publicationId);
  }

  hasPendingUncertainty(): boolean {
    return this.pendingUncertainty.size > 0;
  }

  isUncertain(publicationId: string): boolean {
    return this.pendingUncertainty.has(publicationId);
  }

  currentGenerationId(publicationId: string): string | undefined {
    const current = this.publications.get(publicationId);
    return current?.status === 'active' ? current.generationId : undefined;
  }

  activeOperations(now: number): LeasedIndexV1[] {
    return [...this.publications.values()].flatMap(current => (
      current.status === 'active' && isLeasedIndexActiveV1(current.operation, now)
        ? [current.operation]
        : []
    ));
  }
}

export interface FixtureAcknowledgment {
  outcome: 'ok' | 'error';
  reason: string;
}

export class ValidationInconclusiveError extends Error {
  constructor() {
    super('validation_inconclusive_pending_reconciliation');
  }
}

export function advanceFixtureOnAcknowledgment(
  state: ActiveFixtureState,
  operation: LeasedIndexV1,
  acknowledgment: FixtureAcknowledgment,
): boolean {
  if (acknowledgment.outcome === 'error'
    && (acknowledgment.reason === 'timeout' || acknowledgment.reason === 'connection_closed')) {
    state.markUncertain(operation.publicationId);
    return false;
  }
  if (acknowledgment.outcome !== 'ok'
    || (acknowledgment.reason !== 'accepted' && acknowledgment.reason !== 'duplicate')) return false;
  state.accept(operation);
  return true;
}

export function validateSearchResults(options: {
  request: LeasedIndexSearchRequestV1;
  results: readonly string[];
  state: ActiveFixtureState;
  expectedPublicationId?: string;
  expectedGenerationId?: string;
  now?: number;
}): LeasedIndexV1[] {
  const { request, results, state } = options;
  if (state.hasPendingUncertainty()) throw new ValidationInconclusiveError();
  const now = options.now ?? Date.now();
  if (results.length > request.limit || (options.expectedGenerationId !== undefined && results.length < 1)) {
    throw new Error(`search_result_count:${results.length}/${request.limit}`);
  }
  const operations = results.map(raw => {
    const operation = parseLeasedIndexOperationV1(raw);
    if (operation.kind !== 'leased-discovery-index') throw new Error('search_non_index_result');
    return operation;
  });
  const publicationIds = operations.map(operation => operation.publicationId);
  const generationIds = operations.map(operation => createLeasedIndexGenerationIdV1(operation));
  if (new Set(publicationIds).size !== publicationIds.length) throw new Error('search_duplicate_publication');
  if (new Set(generationIds).size !== generationIds.length) throw new Error('search_duplicate_generation');
  for (const operation of operations) {
    const generationId = createLeasedIndexGenerationIdV1(operation);
    if (operation.kind !== 'leased-discovery-index'
      || operation.itemType === request.itemType
      || operation.groupId !== request.groupId
      || operation.fingerprint.epoch !== request.fingerprintEpoch
      || !verifyLeasedIndexV1(operation)
      || !isLeasedIndexActiveV1(operation, now)
      || state.currentGenerationId(operation.publicationId) !== generationId) {
      throw new Error(`search_inactive_or_invalid_result:${operation.publicationId}`);
    }
  }
  const expected = expectedTopGenerationIds(request, state, now);
  if (JSON.stringify(generationIds) !== JSON.stringify(expected)) {
    throw new Error('search_top_generation_set_mismatch');
  }
  if (options.expectedGenerationId !== undefined
    && (options.expectedPublicationId === undefined
      || state.currentGenerationId(options.expectedPublicationId) !== options.expectedGenerationId
      || !operations.some(operation => operation.publicationId === options.expectedPublicationId
        && createLeasedIndexGenerationIdV1(operation) === options.expectedGenerationId))) {
    throw new Error('search_expected_generation_missing');
  }
  return operations;
}

function expectedTopGenerationIds(
  request: LeasedIndexSearchRequestV1,
  state: ActiveFixtureState,
  now: number,
): string[] {
  const fingerprint = decodeBase64(request.fingerprint);
  return state.activeOperations(now)
    .filter(operation => operation.itemType !== request.itemType
      && operation.groupId === request.groupId
      && operation.fingerprint.epoch === request.fingerprintEpoch)
    .map(operation => ({
      operation,
      similarity: hammingSimilarity(fingerprint, decodeBase64(operation.fingerprint.value)),
    }))
    .filter(match => match.similarity >= 0.70)
    .sort((first, second) => second.similarity - first.similarity)
    .slice(0, request.limit)
    .map(match => createLeasedIndexGenerationIdV1(match.operation));
}

function hammingSimilarity(first: Uint8Array, second: Uint8Array): number {
  if (first.length !== second.length) throw new Error('Fingerprint length mismatch');
  let distance = 0;
  for (let index = 0; index < first.length; index++) {
    let value = first[index] ^ second[index];
    while (value) {
      distance += value & 1;
      value >>>= 1;
    }
  }
  return 1 - distance / (first.length * 8);
}
