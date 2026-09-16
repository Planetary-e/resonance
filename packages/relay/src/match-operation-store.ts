/** Materialized view of relay-signed protocol v2 match decisions. */

import {
  verifyMatchOperationV2,
  type MatchOperationV2,
  type MatchPublicationReferenceV2,
} from '@resonance/core';

export type MatchOperationApplyStatus =
  | 'accepted'
  | 'attestation'
  | 'duplicate'
  | 'stale'
  | 'conflict'
  | 'invalid';

export interface MatchOperationApplyResult {
  status: MatchOperationApplyStatus;
  current?: MatchOperationV2;
}

export class MatchOperationStore {
  private operations = new Map<string, MatchOperationV2>();
  private currentByMatch = new Map<string, MatchOperationV2>();

  evaluate(operation: unknown): MatchOperationApplyResult {
    if (!verifyMatchOperationV2(operation)) return { status: 'invalid' };
    if (this.operations.has(operation.operationId)) {
      return { status: 'duplicate', current: this.currentByMatch.get(operation.matchId) };
    }
    const current = this.currentByMatch.get(operation.matchId);
    if (!current) return { status: 'accepted', current: operation };

    const comparison = compareGenerations(operation.publications, current.publications);
    if (comparison === 'same') return { status: 'attestation', current };
    if (comparison === 'newer') return { status: 'accepted', current: operation };
    return { status: comparison, current };
  }

  apply(operation: unknown): MatchOperationApplyResult {
    const result = this.evaluate(operation);
    if (!verifyMatchOperationV2(operation)) return result;
    if (result.status === 'duplicate' || result.status === 'stale'
      || result.status === 'conflict' || result.status === 'invalid') return result;

    this.operations.set(operation.operationId, operation);
    if (result.status === 'accepted') this.currentByMatch.set(operation.matchId, operation);
    return result;
  }

  get(matchId: string): MatchOperationV2 | undefined {
    return this.currentByMatch.get(matchId);
  }

  hasGeneration(operation: MatchOperationV2): boolean {
    const current = this.currentByMatch.get(operation.matchId);
    return current !== undefined
      && compareGenerations(operation.publications, current.publications) === 'same';
  }

  get size(): number {
    return this.currentByMatch.size;
  }

  get operationCount(): number {
    return this.operations.size;
  }
}

function compareGenerations(
  candidate: MatchOperationV2['publications'],
  current: MatchOperationV2['publications'],
): 'same' | 'newer' | 'stale' | 'conflict' {
  const candidateById = new Map(candidate.map(reference => [reference.publicationId, reference]));
  const currentById = new Map(current.map(reference => [reference.publicationId, reference]));
  if (candidateById.size !== currentById.size
    || Array.from(candidateById.keys()).some(id => !currentById.has(id))) return 'conflict';

  let advanced = false;
  for (const [id, candidateReference] of candidateById) {
    const currentReference = currentById.get(id) as MatchPublicationReferenceV2;
    if (candidateReference.sequence < currentReference.sequence) return 'stale';
    if (candidateReference.sequence === currentReference.sequence
      && candidateReference.publicationSignature !== currentReference.publicationSignature) return 'conflict';
    if (candidateReference.sequence > currentReference.sequence) advanced = true;
  }
  return advanced ? 'newer' : 'same';
}
