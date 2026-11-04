/** Offline cost/sensitivity calculation; no network traffic or anonymity simulation. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const input = 'docs/evals/private-reply-2026-09-29T14-30-17-612Z.json';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const output = values.out ? resolve(values.out) : resolve(root, 'docs/evals/quiet-period-budgets-2026-09-29');
const source = readFileSync(resolve(root, input));
const experiment = JSON.parse(source.toString('utf8')) as {
  results: Array<{ traces: Array<{ bytes: number; replyBytes: number }> }>;
};
const traces = experiment.results.flatMap(result => result.traces);
if (traces.length !== 192 || traces.some(trace => !Number.isSafeInteger(trace.bytes) || trace.bytes <= 0
  || !Number.isSafeInteger(trace.replyBytes) || trace.replyBytes <= 0)
  || new Set(traces.map(trace => trace.bytes)).size !== 1
  || new Set(traces.map(trace => trace.replyBytes)).size !== 1) {
  throw new Error('Expected 192 complete equal-size request/reply traces');
}
const requestBytes = traces[0].bytes;
const replyBytes = traces[0].replyBytes;
const exchangeBytes = requestBytes + replyBytes;
const round = (value: number, places = 3) => Number(value.toFixed(places));

// Illustrative empty slots; real messages would replace cover, not add to it.
const cadence = [1, 10, 60, 300].map(intervalSeconds => ({
  intervalSeconds,
  exchangesPerConnectedHour: 3_600 / intervalSeconds,
  clientPayloadMBPerHour: round(exchangeBytes * 3_600 / intervalSeconds / 1_000_000),
  clientPayloadMBPer8Hours: round(exchangeBytes * 28_800 / intervalSeconds / 1_000_000),
  clientPayloadMBPer24Hours: round(exchangeBytes * 86_400 / intervalSeconds / 1_000_000),
  uniformArrivalMeanWaitSeconds: intervalSeconds / 2,
  uniformArrivalP95WaitSeconds: intervalSeconds * 0.95,
}));

// Hypothetical homogeneous Poisson arrivals from OTHER compatible real work.
// This says nothing about independent users, Sybils, or attacker success.
const opportunities = [60, 600, 3_600].flatMap(meanOtherArrivalSeconds =>
  [0.75, 2, 5, 30, 60, 300, 900].map(waitSeconds => ({
    meanOtherArrivalSeconds, waitSeconds,
    probabilityAtLeastOneOtherArrival: -Math.expm1(-waitSeconds / meanOtherArrivalSeconds),
  })));
const report = {
  generatedAt: new Date().toISOString(),
  sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  input, inputSha256: createHash('sha256').update(source).digest('hex'),
  requestBytes, replyBytes, exchangeBytes, cadence, opportunities,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${output}.md`, [
  '# Quiet-period budget calculations', '',
  `Generated ${report.generatedAt}; source base ${report.sourceBase}. Input: [192-search traces](${basename(input)}), SHA-256 \`${report.inputSha256}\`.`, '',
  '## Scope', '',
  `This is an offline calculator, not a new network test or a privacy/energy measurement. All 192 captured small-search traces have a ${requestBytes}-byte client request and a ${replyBytes}-byte encrypted reply: ${exchangeBytes} bytes per client exchange. Larger payload buckets cost more.`, '',
  '## Hypothetical scheduled traffic', '',
  'Assume a continuously connected client sends one exchange every interval, replacing empty slots with real work when available. Decimal MB count upload plus download of application frames only. TCP, TLS, WebSocket framing, discovery, retransmissions, other relay links, and server CPU costs are excluded. Slot counts are not measurements of radio wakeups or energy. The waiting model assumes one operation fits in a slot, uniform arrival within an interval, no backlog, and no extra burst slots; network and mixing time are additional. These are examples, not chosen rates.', '',
  '| Interval (s) | Exchanges / connected hour | MB / hour | MB / 8 h | MB / 24 h | Mean / p95 slot wait (s) |',
  '|---:|---:|---:|---:|---:|---:|',
  ...cadence.map(row => `| ${row.intervalSeconds} | ${row.exchangesPerConnectedHour} | ${row.clientPayloadMBPerHour} | ${row.clientPayloadMBPer8Hours} | ${row.clientPayloadMBPer24Hours} | ${row.uniformArrivalMeanWaitSeconds} / ${row.uniformArrivalP95WaitSeconds} |`), '',
  'Formula: client payload MB = (request bytes + reply bytes) × connected seconds / interval seconds / 1,000,000. Mean scheduled wait = interval / 2; p95 = 0.95 × interval. A delay longer than the current 30-second private-envelope lifetime would have to occur locally before creating the envelope; pending signed operations may have their own expiry.', '',
  '## Does waiting find another request?', '',
  'For illustrative Poisson arrivals at rate λ from other compatible real work, P(at least one other arrival within W) = 1 − exp(−λW). Compatibility includes the relevant route, size, and observation window; whole-network packet counts overstate it. These rates are hypothetical, not inferred from the eight-client experiment. An arrival is not proof of a different person or honest participant, and these probabilities are not anonymity scores. Correlated arrivals, partitions, or adversarial traffic can invalidate the model.', '',
  '| Wait (s) | Other work: 1/min | Other work: 1/10 min | Other work: 1/hour |',
  '|---:|---:|---:|---:|',
  ...[0.75, 2, 5, 30, 60, 300, 900].map(wait => `| ${wait} | ${[60, 600, 3_600].map(mean =>
    `${(100 * opportunities.find(row => row.waitSeconds === wait && row.meanOtherArrivalSeconds === mean)!.probabilityAtLeastOneOtherArrival).toFixed(2)}%`).join(' | ')} |`), '',
  'When no other compatible work arrives, additional waiting supplies no other request to mix with. Even a 15-minute wait has only a 22.12% opportunity under the illustrative one-per-hour assumption. A timer or relay-reported queue size therefore cannot certify safe release.', '',
  '## Reproduce', '', '```sh', 'npm run eval:quiet-budgets', '```', '',
  `[Machine-readable calculations](${basename(output)}.json). The production client and relay settings are unchanged.`, '',
].join('\n'));
console.log(JSON.stringify({ report: `${output}.md`, exchangeBytes, cadence }, null, 2));
