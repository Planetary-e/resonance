/** Exact offline component screen, not a prediction of actual service availability. */
import { independentQuorumProbability } from './witness-availability.js';

export interface ServiceAvailabilityAssumptions {
  requiredCohorts: number;
  /** Identical members have one shared availability event, regardless of history count. */
  cohortDependence: 'independent' | 'identical-members';
  /** Applies to each physical cohort; identical-member cohorts share the same withholder. */
  permanentlyWithholdingPerCohort?: 0 | 1;
  commonOutageFraction?: number;
  /** Success conditional on all required cohorts being available and no common outage. */
  conditionalOperationSuccess?: number;
}
type Assumptions = Required<ServiceAvailabilityAssumptions>;
export type AvailabilityFeasibility = {
  target: number;
  maximumServiceAvailability: number;
} & ({ feasible: true; minimumPerVolunteerAvailability: number; reason: null }
  | { feasible: false; minimumPerVolunteerAvailability: null; reason: 'target_exceeds_model_ceiling' });

export const FEASIBILITY_WINDOW_DAYS = 14;
const MINUTES_PER_DAY = 24 * 60;
const FIELDS = new Set(['requiredCohorts', 'cohortDependence', 'permanentlyWithholdingPerCohort',
  'commonOutageFraction', 'conditionalOperationSuccess']);
function probability(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid ${name}`);
}
function assumptions(value: ServiceAvailabilityAssumptions): Assumptions {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !FIELDS.has(field))
    || !Number.isSafeInteger(value.requiredCohorts) || value.requiredCohorts < 1
    || !['independent', 'identical-members'].includes(value.cohortDependence)) throw new Error('Invalid cohort assumptions');
  const withheld = value.permanentlyWithholdingPerCohort === undefined ? 0 : value.permanentlyWithholdingPerCohort;
  if (withheld !== 0 && withheld !== 1) throw new Error('Only zero or one withholding member per cohort is modeled');
  const common = value.commonOutageFraction === undefined ? 0 : value.commonOutageFraction;
  const success = value.conditionalOperationSuccess === undefined ? 1 : value.conditionalOperationSuccess;
  probability(common, 'common outage fraction'); probability(success, 'conditional operation success');
  return { requiredCohorts: value.requiredCohorts, cohortDependence: value.cohortDependence,
    permanentlyWithholdingPerCohort: withheld, commonOutageFraction: common, conditionalOperationSuccess: success };
}
function cohortAvailability(p: number, model: Assumptions) {
  // Bound floating-point rounding at the endpoints, without changing the exact model.
  return Math.max(0, Math.min(1, independentQuorumProbability(p, model.permanentlyWithholdingPerCohort)));
}
function service(p: number, model: Assumptions) {
  const q = cohortAvailability(p, model), required = model.cohortDependence === 'independent' ? q ** model.requiredCohorts : q;
  return (1 - model.commonOutageFraction) * required * model.conditionalOperationSuccess;
}

/** p is conditional volunteer availability outside the common outage. Four
 * responsive volunteers must exist simultaneously; partial replies do not accumulate. */
export function serviceAvailabilityProbability(p: number, input: ServiceAvailabilityAssumptions): number {
  probability(p, 'per-volunteer availability'); return service(p, assumptions(input));
}

/** Expected total unavailable time from a stationary marginal probability.
 * This says nothing about outage duration, clustering, retry windows or latency. */
export function expectedUnavailableMinutes(availability: number, days = FEASIBILITY_WINDOW_DAYS): number {
  probability(availability, 'service availability');
  if (!Number.isFinite(days) || days < 0 || !Number.isFinite(days * MINUTES_PER_DAY)) throw new Error('Invalid observation days');
  return (1 - availability) * days * MINUTES_PER_DAY;
}

/** Bounded bisection returns the feasible upper endpoint. A model ceiling below
 * target is explicit, rather than pretending that a per-volunteer p exists. */
export function minimumVolunteerAvailability(target: number, input: ServiceAvailabilityAssumptions): AvailabilityFeasibility {
  probability(target, 'availability target'); const model = assumptions(input), maximumServiceAvailability = service(1, model);
  if (target > maximumServiceAvailability) return { target, maximumServiceAvailability, feasible: false,
    minimumPerVolunteerAvailability: null, reason: 'target_exceeds_model_ceiling' };
  if (target === 0 || target === maximumServiceAvailability) return { target, maximumServiceAvailability, feasible: true,
    minimumPerVolunteerAvailability: target === 0 ? 0 : 1, reason: null };
  let lower = 0, upper = 1;
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = (lower + upper) / 2;
    if (service(middle, model) >= target) upper = middle; else lower = middle;
  }
  return { target, maximumServiceAvailability, feasible: true, minimumPerVolunteerAvailability: upper, reason: null };
}

/** Small deterministic JSON-ready grid. The fixture topology is context only:
 * its real joint availability and operation success have not been calibrated. */
export function serviceAvailabilityFeasibilityScenarios() {
  const probabilities = [0.8, 0.9, 0.95, 0.97, 0.99], target = 0.99;
  const placements: ServiceAvailabilityAssumptions[] = [
    { requiredCohorts: 1, cohortDependence: 'independent' },
    { requiredCohorts: 2, cohortDependence: 'independent' },
    { requiredCohorts: 2, cohortDependence: 'identical-members' },
  ];
  const scenarios = placements.flatMap(placement => ([0, 1] as const).flatMap(permanentlyWithholdingPerCohort =>
    [0, 0.01].map(commonOutageFraction => {
      const model = assumptions({ ...placement, permanentlyWithholdingPerCohort, commonOutageFraction, conditionalOperationSuccess: 1 });
      return { assumptions: model, targetFeasibility: minimumVolunteerAvailability(target, model), points: probabilities.map(p => {
        const q = cohortAvailability(p, model), modeledServiceAvailability = service(p, model);
        return { perVolunteerAvailability: p, perCohortAvailability: q, modeledServiceAvailability,
          expectedUnavailableMinutes14Days: expectedUnavailableMinutes(modeledServiceAvailability) };
      }) };
    })));
  return { model: 'five-member-four-reply-offline-feasibility-v1', cohortMembers: 5, requiredReplies: 4,
    windowDays: FEASIBILITY_WINDOW_DAYS, target, assumptions: [
      'p is a stationary per-volunteer responsive probability conditional on no common outage.',
      'Honest volunteers are independent within each physical cohort; independent cohorts also have independent members.',
      'Identical-member co-hosted histories share one quorum event; history count does not create independent cohorts.',
      'The permanent withholding count applies to each physical cohort, including one per group in independent multi-cohort cases.',
      'The common outage fraction is applied once to the joint event; operation success is conditional and applied once.',
      'Other required owners, witnesses and routes are assumed always available; generated scenarios set conditional operation success to one.',
    ], limitations: [
      'Optimistic component screen, not predicted actual availability or a calibrated model of the real topology.',
      'The real fixture shares 55 histories across two sets of five volunteer endpoints; histories are not 55 independent cohorts.',
      'No inference about real volunteer uptime, other correlated failures, outage durations, latency, retries or complete-service readiness.',
    ], fixtureContext: { histories: 55, volunteerEndpointSets: 2, endpointsPerSet: 5, calibrated: false }, scenarios };
}
