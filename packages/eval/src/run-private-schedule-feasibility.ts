/** Frozen offline scheduling screen; no network, cryptography or power measurement. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluatePrivateSchedule, CAPTURED_SCHEDULE_PAYLOAD, type PrivateScheduleInput } from './private-schedule-feasibility.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
if (!values.out) throw new Error('Provide --out with a new JSON report path');
const profiles = [
  { slotMs: 500, wireBytes: 4096, usefulBytes: 3072 },
  { slotMs: 250, wireBytes: 2048, usefulBytes: 1536 },
  { slotMs: 125, wireBytes: 1024, usefulBytes: 768 },
];
const processingDelaysMs = [0, 250, 500, 1000, 1125, 1250, 2000];
const enrolled = (id: string, endMs = 15000) => ({ id, enrollment: [{ startMs: 0, endMs }] });
const submission = (id: string, clientId: string, atMs: number, processingMs = 1000) => ({ id, clientId, atMs, processingMs });
function percentile(values: Array<number | null>, q: number) {
  const sorted = values.map(value => value ?? Infinity).sort((a, b) => a - b);
  const value = sorted[Math.ceil(sorted.length * q) - 1];
  return Number.isFinite(value) ? value : null;
}
const rows = profiles.map(profile => {
  // Fixed before running: 100 deterministic phase offsets, no best-seed selection.
  const phaseOffsetsMs = Array.from({ length: 100 }, (_, index) => Math.floor(index * profile.slotMs / 100));
  const phases = processingDelaysMs.map(processingMs => {
    const outcomes = phaseOffsetsMs.map(atMs => evaluatePrivateSchedule({ durationMs: 15000, profile,
      clients: [enrolled('a')], submissions: [submission('op', 'a', atMs, processingMs)] }).operations[0]);
    const latencyMs = outcomes.map(op => op.latencyMs), p95 = percentile(latencyMs, .95), p99 = percentile(latencyMs, .99);
    const completed = outcomes.filter(op => op.status === 'completed').length;
    return { processingMs, submitted: outcomes.length, completed, latenciesMs: latencyMs,
      failedPhases: outcomes.flatMap((op, index) => op.infiniteLatency ? [{ index, reason: op.reason }] : []),
      p50Ms: percentile(latencyMs, .5), p95Ms: p95, p99Ms: p99,
      localLatencyScreen: completed === outcomes.length && p95 !== null && p95 <= 6000 && p99 !== null && p99 <= 10000,
      eightSecondLatencyScreen: completed === outcomes.length && p95 !== null && p95 <= 8000 && p99 !== null && p99 <= 10000 };
  });
  const run = (extra: Partial<PrivateScheduleInput>) => evaluatePrivateSchedule({ durationMs: 15000, profile,
    clients: [enrolled('a')], submissions: [], ...extra });
  const scenarios = {
    idleHour: run({ durationMs: 3600000, clients: [enrolled('a', 3600000)] }),
    sparseHour: run({ durationMs: 3600000, clients: [enrolled('a', 3600000)], submissions: [submission('sparse', 'a', 120123)] }),
    twoClientsOneOperationEach: run({ clients: [enrolled('a'), enrolled('b')],
      submissions: [submission('a1', 'a', 123), submission('b1', 'b', 123)] }),
    eightRequestBurst: run({ maxPendingPerClient: 2,
      submissions: Array.from({ length: 8 }, (_, index) => submission(`burst${index}`, 'a', 123)) }),
    sleepAndReconnect: run({ clients: [{ id: 'a', enrollment: [{ startMs: 0, endMs: 2000 }, { startMs: 6000, endMs: 15000 }] }],
      submissions: [submission('interrupted', 'a', 1751), submission('asleep', 'a', 3000), submission('reconnected', 'a', 6123)] }),
    syntheticLoss: run({ submissions: [submission('loss', 'a', 0)],
      droppedCells: [{ clientId: 'a', tick: 0, lane: 0 }, { clientId: 'a', tick: 1, lane: 0 }] }),
    overBudgetStartup: run({ clients: [{ ...enrolled('a'), startupAccessBytes: 64 * 1024 ** 2, startupAllBytes: 256 * 1024 ** 2 }],
      submissions: [submission('budget', 'a', 123)] }),
  };
  const feasible = phases.filter(row => row.localLatencyScreen);
  return { profile, phaseOffsetsMs, phases, largestTestedLocalProcessingMs: feasible.length ? feasible.at(-1)!.processingMs : null,
    scenarios };
});
const sources = ['packages/eval/src/private-schedule-feasibility.ts', 'packages/eval/src/run-private-schedule-feasibility.ts'];
const report = { generatedAt: new Date().toISOString(), sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
  classification: 'offline-capacity-screen-only', k1Status: 'not-qualified', k6Status: 'not-qualified', k7Status: 'not-qualified',
  historicalExamplePayload: CAPTURED_SCHEDULE_PAYLOAD,
  interpretation: ['The two-client sample is not a closed-loop nominal qualification; 100 arrival phases are a deterministic grid, not deployment statistics.',
    'The eight-second column applies only a latency threshold; it does not simulate the reference impaired network.',
    'Processing delay is an explicit hypothetical input after request delivery, not a measured full-application latency.',
    'A wire-byte allocation and 25% overhead reserve are assumptions, not measured TCP behavior or guaranteed physical padding.',
    'Reserved other-edge bandwidth is charged but its protocol, schedule, payload and computation rounds are unknown.',
    'Caps are report-only infeasibility indicators, not a runtime controller; an over-budget row cannot qualify even if modeled delivery completes.',
    'An equal idle/active byte count does not establish indistinguishable packet timing, sources, destinations or ciphertexts.',
    'No AUC, cryptographic security, device power, real packet loss or independent volunteer availability is established.'],
  rows };
const output = resolve(values.out); mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ report: output, classification: report.classification, profiles: rows.map(row => ({
  slotMs: row.profile.slotMs, largestTestedLocalProcessingMs: row.largestTestedLocalProcessingMs,
  idleAccessBytesPerHour: row.scenarios.idleHour.totals.accessBytes, idleAllBytesPerHour: row.scenarios.idleHour.totals.allBytes,
  burstCompleted: row.scenarios.eightRequestBurst.completed, burstRejected: row.scenarios.eightRequestBurst.rejected,
})) }));
