/** Pluggable verification boundary for anonymous one-use capabilities. */

import type {
  AdmissionCapabilityV2,
  RelayAdmissionActionV2,
} from '@resonance/core';

export interface AdmissionVerificationContextV2 {
  action: RelayAdmissionActionV2;
  /** Canonical digest of the exact request and action. */
  requestBinding: string;
  now: number;
}

export type AdmissionDecisionV2 =
  | { status: 'accepted' }
  | { status: 'replay' }
  | { status: 'rejected'; reason?: string };

/**
 * Implementations must verify the opaque proof and atomically record a token
 * spend. A retry with the same action and request binding returns `replay` and
 * is allowed; reuse for different content returns `rejected`.
 */
export interface AdmissionCapabilityVerifierV2 {
  verifyAndSpend(
    capability: AdmissionCapabilityV2,
    context: AdmissionVerificationContextV2,
  ): AdmissionDecisionV2;
}
