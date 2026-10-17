/** Synthetic availability only: no inference about real volunteer uptime. */
export const STEP_MINUTES = 5;

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function independentQuorumProbability(p: number, unavailable = 0): number {
  if (!Number.isFinite(p) || p < 0 || p > 1 || !Number.isInteger(unavailable) || unavailable < 0 || unavailable > 5) {
    throw new Error('Invalid availability assumptions');
  }
  return unavailable > 1 ? 0 : unavailable === 1 ? p ** 4 : p ** 4 * (5 - 4 * p);
}

/** Independent two-state continuous-time chains, sampled every five minutes.
 * Mean online session is six hours; offline rate gives stationary probability p.
 * These are exact sampled transition probabilities, not independent redraws.
 */
export function independentTrace(p: number, steps: number, seed: number, unavailable = 0): boolean[][] {
  independentQuorumProbability(p, unavailable);
  const random = seededRandom(seed), states = Array.from({ length: 5 }, () => random() < p);
  const change = p === 0 || p === 1 ? 0 : -Math.expm1(-STEP_MINUTES / (360 * (1 - p)));
  return Array.from({ length: steps }, () => states.map((online, i) => {
    if (i < unavailable) return states[i] = false;
    if (random() < (online ? 1 - p : p) * change) states[i] = !online;
    return states[i];
  }));
}

export function scheduledTrace(startHours: number[], steps: number): boolean[][] {
  if (startHours.length !== 5) throw new Error('Exactly five schedules required');
  return Array.from({ length: steps }, (_, step) => startHours.map(start =>
    ((step * STEP_MINUTES / 60 - start) % 24 + 24) % 24 < 8));
}

/** Uniform hypothetical request arrivals, including zero-minute successes.
 * Tail observations prevent right-censoring requests near the reporting boundary.
 * Every retry needs four witnesses in that attempt; partial votes do not accumulate.
 */
export function summarizeAvailability(trace: boolean[][], arrivals: number, windows = [0, 15, 60]) {
  if (!Number.isInteger(arrivals) || arrivals < 1 || !windows.length
    || windows.some(w => !Number.isInteger(w) || w < 0 || w % STEP_MINUTES !== 0)
    || trace.length < arrivals + Math.max(...windows) / STEP_MINUTES
    || trace.some(row => row.length !== 5 || row.some(value => typeof value !== 'boolean'))) {
    throw new Error('Invalid trace or missing retry tail');
  }
  const quorum = trace.map(row => row.filter(Boolean).length >= 4);
  return windows.map(windowMinutes => {
    const waits: number[] = [];
    for (let start = 0; start < arrivals; start++) {
      for (let delay = 0; delay <= windowMinutes / STEP_MINUTES; delay++) {
        if (quorum[start + delay]) { waits.push(delay * STEP_MINUTES); break; }
      }
    }
    return { windowMinutes, arrivals, accepted: waits.length, refused: arrivals - waits.length,
      availability: waits.length / arrivals, acceptedWaitP50Minutes: percentile(waits, 0.5), acceptedWaitP95Minutes: percentile(waits, 0.95) };
  });
}

export function availabilityScenarios(seed = 20261001) {
  const arrivals = 90 * 24 * 60 / STEP_MINUTES, warmup = 7 * 24 * 60 / STEP_MINUTES;
  const steps = arrivals + warmup + 60 / STEP_MINUTES;
  const independent = [0.5, 0.75, 0.9, 0.95].map((p, i) => ({
    name: `independent-${p}`, p, permanentlyUnavailable: 0,
    exactInstantAvailability: independentQuorumProbability(p),
    windows: summarizeAvailability(independentTrace(p, steps, seed + i).slice(warmup), arrivals),
  }));
  return { seed, days: 90, warmupDays: 7, stepMinutes: STEP_MINUTES, meanOnlineSessionHours: 6,
    scenarios: [...independent, {
      name: 'one-unavailable-others-90-percent', p: 0.9, permanentlyUnavailable: 1,
      exactInstantAvailability: independentQuorumProbability(0.9, 1),
      windows: summarizeAvailability(independentTrace(0.9, steps, seed + 4, 1).slice(warmup), arrivals),
    }, ...[{ name: 'shared-eight-hour-schedule', starts: [17, 17, 17, 17, 17] },
      { name: 'staggered-eight-hour-schedules', starts: [0, 5, 10, 15, 20] }].map(({ name, starts }) => ({
      name, starts, windows: summarizeAvailability(scheduledTrace(starts, arrivals + 12), arrivals),
    }))] };
}
