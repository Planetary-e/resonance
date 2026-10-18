import { expect, it } from 'vitest';
import { expectedUnavailableMinutes, minimumVolunteerAvailability, serviceAvailabilityFeasibilityScenarios,
  serviceAvailabilityProbability, type ServiceAvailabilityAssumptions } from '../service-availability-feasibility.js';

const single: ServiceAvailabilityAssumptions = { requiredCohorts: 1, cohortDependence: 'independent' };
const independent = { ...single, requiredCohorts: 2 };
const cohosted: ServiceAvailabilityAssumptions = { requiredCohorts: 2, cohortDependence: 'identical-members' };

it('matches counted equiprobable states: six of 32 single-cohort states and 36 of 1024 independent pairs', () => {
  expect(serviceAvailabilityProbability(0.5, single)).toBe(6 / 32);
  expect(serviceAvailabilityProbability(0.5, independent)).toBe(36 / 1024);
  expect(serviceAvailabilityProbability(0.5, { ...single, permanentlyWithholdingPerCohort: 1 })).toBe(1 / 16);
  expect(serviceAvailabilityProbability(0.9, single)).toBeCloseTo(0.91854, 12);
  expect(serviceAvailabilityProbability(0.8, single)).toBeCloseTo(0.73728, 12);
});

it('does not invent independent failure events for identical-member co-hosted histories', () => {
  expect(serviceAvailabilityProbability(0.5, cohosted)).toBe(6 / 32);
  expect(serviceAvailabilityProbability(0.5, { ...cohosted, requiredCohorts: 55 })).toBe(6 / 32);
  expect(serviceAvailabilityProbability(0.9, cohosted)).toBeGreaterThan(serviceAvailabilityProbability(0.9, independent));
  expect(serviceAvailabilityProbability(0.5, { ...cohosted, permanentlyWithholdingPerCohort: 1 })).toBe(1 / 16);
  expect(serviceAvailabilityProbability(0.5, { ...independent, permanentlyWithholdingPerCohort: 1 })).toBe(1 / 256);
});

it('applies a common outage and conditional success once to the joint event, including identical membership', () => {
  const factors = { commonOutageFraction: 0.01, conditionalOperationSuccess: 0.8 };
  expect(serviceAvailabilityProbability(1, { ...independent, ...factors })).toBeCloseTo(0.792, 15);
  expect(serviceAvailabilityProbability(0.5, { ...independent, ...factors })).toBeCloseTo((36 / 1024) * 0.99 * 0.8, 15);
  expect(serviceAvailabilityProbability(0.5, { ...cohosted, ...factors })).toBeCloseTo((6 / 32) * 0.99 * 0.8, 15);
});

it('has the correct degenerate endpoints and zero conditional-success ceiling', () => {
  for (const model of [single, independent, cohosted]) for (const permanentlyWithholdingPerCohort of [0, 1] as const) {
    expect(serviceAvailabilityProbability(0, { ...model, permanentlyWithholdingPerCohort })).toBe(0);
    expect(serviceAvailabilityProbability(1, { ...model, permanentlyWithholdingPerCohort })).toBe(1);
    expect(serviceAvailabilityProbability(1, { ...model, permanentlyWithholdingPerCohort, commonOutageFraction: 1 })).toBe(0);
    expect(serviceAvailabilityProbability(1, { ...model, permanentlyWithholdingPerCohort, conditionalOperationSuccess: 0 })).toBe(0);
  }
});

it('is monotone in volunteer availability and worsens with independent requirements or withheld votes', () => {
  for (const model of [single, independent, cohosted]) {
    const values = [0, 0.1, 0.5, 0.8, 0.9, 0.97, 0.99, 1].map(p => serviceAvailabilityProbability(p, model));
    expect(values.every((value, i) => !i || value > values[i - 1])).toBe(true);
  }
  for (const p of [0.2, 0.8, 0.95, 0.99]) {
    expect(serviceAvailabilityProbability(p, independent)).toBeLessThan(serviceAvailabilityProbability(p, single));
    expect(serviceAvailabilityProbability(p, { ...single, permanentlyWithholdingPerCohort: 1 })).toBeLessThan(serviceAvailabilityProbability(p, single));
  }
});

it('finds analytical target roots with a permanently withheld member and applies conditional factors outside the exponent', () => {
  for (const model of [single, independent, cohosted]) {
    const result = minimumVolunteerAvailability(0.99, { ...model, permanentlyWithholdingPerCohort: 1 });
    expect(result.feasible).toBe(true);
    expect(result.minimumPerVolunteerAvailability).toBeCloseTo(0.99 ** (model === independent ? 1 / 8 : 1 / 4), 13);
  }
  const result = minimumVolunteerAvailability(0.8, { ...independent, permanentlyWithholdingPerCohort: 1,
    commonOutageFraction: 0.05, conditionalOperationSuccess: 0.9 });
  expect(result.minimumPerVolunteerAvailability).toBeCloseTo((0.8 / (0.95 * 0.9)) ** (1 / 8), 13);
});

it('brackets the no-withholder 99% root and raises the requirement for independent cohorts', () => {
  const a = minimumVolunteerAvailability(0.99, single), b = minimumVolunteerAvailability(0.99, independent);
  expect(a.minimumPerVolunteerAvailability!).toBeGreaterThan(0.96); expect(a.minimumPerVolunteerAvailability!).toBeLessThan(0.97);
  expect(b.minimumPerVolunteerAvailability!).toBeGreaterThan(0.97); expect(b.minimumPerVolunteerAvailability!).toBeLessThan(0.98);
  for (const [result, model] of [[a, single], [b, independent]] as const) {
    expect(serviceAvailabilityProbability(result.minimumPerVolunteerAvailability!, model)).toBeGreaterThanOrEqual(0.99);
    expect(serviceAvailabilityProbability(result.minimumPerVolunteerAvailability! - 1e-8, model)).toBeLessThan(0.99);
  }
});

it('reports infeasible targets explicitly and handles exact model ceilings without a rounding-created p below one', () => {
  expect(minimumVolunteerAvailability(0.99, { ...single, commonOutageFraction: 0.02 })).toEqual({ target: 0.99,
    maximumServiceAvailability: 0.98, feasible: false, minimumPerVolunteerAvailability: null, reason: 'target_exceeds_model_ceiling' });
  expect(minimumVolunteerAvailability(0.99, { ...independent, commonOutageFraction: 0.01 }).minimumPerVolunteerAvailability).toBe(1);
  expect(minimumVolunteerAvailability(1, single).minimumPerVolunteerAvailability).toBe(1);
  expect(minimumVolunteerAvailability(0, single).minimumPerVolunteerAvailability).toBe(0);
  expect(minimumVolunteerAvailability(0, { ...single, conditionalOperationSuccess: 0 }).minimumPerVolunteerAvailability).toBe(0);
  expect(minimumVolunteerAvailability(0.01, { ...single, conditionalOperationSuccess: 0 }).feasible).toBe(false);
});

it('computes expected total unavailable minutes over 14 days without a simulated time series', () => {
  expect(expectedUnavailableMinutes(1)).toBe(0); expect(expectedUnavailableMinutes(0)).toBe(20160);
  expect(expectedUnavailableMinutes(0.99)).toBeCloseTo(201.6, 10);
  expect(expectedUnavailableMinutes(0.5, 2)).toBe(1440); expect(expectedUnavailableMinutes(0, 0)).toBe(0);
});

it('returns the complete deterministic JSON-ready grid with explicit optimistic fixture limitations', () => {
  const report = serviceAvailabilityFeasibilityScenarios(), parsed = JSON.parse(JSON.stringify(report));
  expect(parsed).toEqual(report); expect(report.scenarios).toHaveLength(12);
  expect(report.scenarios.flatMap(scenario => scenario.points)).toHaveLength(60);
  expect(report.scenarios[0].points.map(point => point.perVolunteerAvailability)).toEqual([0.8, 0.9, 0.95, 0.97, 0.99]);
  expect(report.fixtureContext).toEqual({ histories: 55, volunteerEndpointSets: 2, endpointsPerSet: 5, calibrated: false });
  expect(report.limitations.join(' ')).toContain('Optimistic component screen');
  expect(report.assumptions.join(' ')).toContain('assumed always available');
});

it('rejects malformed probabilities, cohort assumptions, targets and observation windows', () => {
  for (const p of [-0.1, 1.1, NaN, Infinity]) {
    expect(() => serviceAvailabilityProbability(p, single)).toThrow();
    expect(() => minimumVolunteerAvailability(p, single)).toThrow();
    expect(() => expectedUnavailableMinutes(p)).toThrow();
  }
  for (const changes of [{ requiredCohorts: 0 }, { requiredCohorts: 1.5 }, { requiredCohorts: Infinity },
    { cohortDependence: 'partly-correlated' }, { permanentlyWithholdingPerCohort: 2 }, { permanentlyWithholdingPerCohort: null },
    { commonOutageFraction: -0.01 }, { commonOutageFraction: NaN }, { commonOutageFraction: null }, { conditionalOperationSuccess: 1.1 },
    { conditionalOperationSuccess: '0.9' }, { conditionalOperationSuccess: null }, { ignoredTypo: 1 }]) {
    const malformed = { ...single, ...changes } as ServiceAvailabilityAssumptions;
    expect(() => serviceAvailabilityProbability(0.9, malformed)).toThrow();
    expect(() => minimumVolunteerAvailability(0.99, malformed)).toThrow();
  }
  for (const malformed of [null, [], 'independent']) expect(() => serviceAvailabilityProbability(0.9, malformed as unknown as ServiceAvailabilityAssumptions)).toThrow();
  for (const days of [-1, Infinity, NaN, Number.MAX_VALUE]) expect(() => expectedUnavailableMinutes(0.9, days)).toThrow();
});
