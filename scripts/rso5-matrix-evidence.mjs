import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const executionArg = process.argv.indexOf('--execution');
const executionPath = executionArg >= 0 ? process.argv[executionArg + 1] : 'delivery/results/econ-matrix-execution.json';
const execution = json(executionPath);
const identityPrefix = execution.identity_prefix ?? 'matrix';
if (execution.matrix_runs_executed !== 20 || execution.results.length !== 20) throw new Error('Matrix is not complete');
const plan = json('delivery/results/econ-matrix-execution-plan.json');
const rows = [];
for (const [index, result] of execution.results.entries()) {
  const runId = result.executionRunId;
  if (!new RegExp(`^${identityPrefix}-${result.runId}(-retry-\\d+)?$`).test(runId) || result.orderIndex !== index) throw new Error(`Run identity/order differs: ${runId}`);
  if (result.scenario !== plan.runs[index].scenario || result.seed !== plan.runs[index].seed) throw new Error(`Frozen scenario/seed differs: ${runId}`);
  const paths = {
    manifest: `delivery/results/econ-lab-manifest-${runId}.json`,
    summary: `delivery/results/econ-lab-summary-${runId}.json`,
    process: `delivery/results/econ-process-${runId}.json`,
    network: `delivery/results/econ-network-${runId}.json`,
    work: `delivery/results/econ-work-${runId}.json`,
    cleanup: `delivery/results/econ-cleanup-${runId}.json`,
    power: `delivery/results/econ-power-${runId}.json`,
    powerCsv: `delivery/results/econ-power-${runId}.csv`,
    disk: `delivery/results/econ-disk-${runId}.json`,
    authorization: `delivery/results/econ-authorization-${runId}.json`,
    owner: `delivery/results/econ-owner-assumptions-${runId}.json`,
    decision: `delivery/results/econ-decision-${runId}.json`,
    readiness: `delivery/results/econ-new-view-readiness-${runId}.json`,
  };
  const manifest = json(paths.manifest), summary = json(paths.summary), processes = json(paths.process), network = json(paths.network);
  const work = json(paths.work), cleanup = json(paths.cleanup), power = json(paths.power), decision = json(paths.decision);
  json(paths.disk); json(paths.authorization); json(paths.owner);
  if (!readFileSync(paths.powerCsv, 'utf8').includes('blocked')) throw new Error(`Power CSV missing/blocked status invalid: ${runId}`);
  if (summary.run_id !== runId || summary.scenario !== result.scenario || summary.outcome !== 'passed') throw new Error(`Run summary invalid: ${runId}`);
  if (manifest.execution_scope.active_run_id !== runId || manifest.execution_scope.active_seed !== result.seed) throw new Error(`Run manifest identity invalid: ${runId}`);
  if (manifest.randomness?.deterministic !== false || manifest.randomness?.exact_business_replay !== false) throw new Error(`Randomness preregistration invalid: ${runId}`);
  if (work.roles.reduce((sum, role) => sum + role.used_bytes, 0) !== work.total_work_bytes) throw new Error(`Work sum invalid: ${runId}`);
  if (!network.reconciliation.exact || !network.reconciliation.edge_envelopes_match || cleanup.remaining_live_workers !== 0 || processes.clean_stops !== 52) throw new Error(`Run gates invalid: ${runId}`);
  const edgeMessages = network.edges.reduce((sum, edge) => sum + edge.messages, 0);
  const edgePayload = network.edges.reduce((sum, edge) => sum + edge.payload_bytes, 0);
  const edgeFrames = network.edges.reduce((sum, edge) => sum + edge.websocket_frame_bytes, 0);
  if (edgeMessages !== network.message_count || edgePayload !== network.total_payload_bytes || edgeFrames !== network.total_frame_bytes
    || network.message_count !== network.reconciliation.sent_messages + network.reconciliation.received_messages) throw new Error(`Network semantic mismatch: ${runId}`);
  if (power.status !== 'blocked' || power.samples.length !== 0 || decision.run_status !== 'matrix_run_complete' || decision.E2 !== 'blocked') throw new Error(`Run status invalid: ${runId}`);
  if (result.scenario === 'new-view') {
    const readiness = json(paths.readiness);
    if (!readiness.post_new_view_startup_complete || !readiness.durable_serving_readiness || readiness.groups.length === 0) throw new Error(`New-view readiness invalid: ${runId}`);
  }
  rows.push({ run_id: runId, scenario: result.scenario, seed: result.seed, order_index: index,
    work_bytes: work.total_work_bytes, messages: network.message_count, payload_bytes: network.total_payload_bytes,
    frame_bytes: network.total_frame_bytes, user_cpu_micros: processes.roles.reduce((sum, role) => sum + role.cpu.userMicros, 0),
    system_cpu_micros: processes.roles.reduce((sum, role) => sum + role.cpu.systemMicros, 0),
    maximum_tree_rss_bytes: Math.max(...processes.roles.map(role => role.peak_tree_rss_bytes)),
    recovered_proofs: summary.recovered_proofs, logical_copy_audits: summary.logical_process_held_copy_audits,
    post_new_view_startup_groups: summary.post_new_view_startup_groups, paths });
}
const aggregate = {
  work_bytes: rows.reduce((sum, row) => sum + row.work_bytes, 0),
  messages: rows.reduce((sum, row) => sum + row.messages, 0),
  payload_bytes: rows.reduce((sum, row) => sum + row.payload_bytes, 0),
  frame_bytes: rows.reduce((sum, row) => sum + row.frame_bytes, 0),
  user_cpu_seconds: rows.reduce((sum, row) => sum + row.user_cpu_micros, 0) / 1e6,
  system_cpu_seconds: rows.reduce((sum, row) => sum + row.system_cpu_micros, 0) / 1e6,
  maximum_tree_rss_bytes: Math.max(...rows.map(row => row.maximum_tree_rss_bytes)),
};
const unified = identityPrefix === 'unified';
const baselinePath = unified ? `delivery/results/econ-unified-baseline${process.argv.includes('--final') ? '-final' : ''}.json`
  : `delivery/results/econ-matrix-baseline${process.argv.includes('--final') ? '-final' : ''}.json`;
const baseline = { schema_version: 1, outcome: 'passed_diagnostic_matrix', run_count: 20,
  command: execution.command, execution_artifact: executionPath,
  runs: rows, aggregate, E2: 'blocked', E2_reasons: ['30-minute windows not executed', 'Physical power blocked'],
  sustained_windows_executed: false, power: 'blocked', economic_affordability: 'pending', acceptance_evaluation: 'not_run' };
writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const hashPaths = [executionPath, 'delivery/results/econ-matrix-execution-plan.json', 'delivery/results/econ-lab-manifest.json', baselinePath];
for (const row of rows) hashPaths.push(...Object.entries(row.paths).flatMap(([name, path]) =>
  name === 'readiness' && !existsSync(path) ? [] : [path]));
const hashes = Object.fromEntries(hashPaths.map(path => [path, `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`]));
const hashPath = unified ? `delivery/results/econ-unified-evidence-hashes${process.argv.includes('--final') ? '-final' : ''}.json`
  : `delivery/results/econ-matrix-evidence-hashes${process.argv.includes('--final') ? '-final' : ''}.json`;
writeFileSync(hashPath, `${JSON.stringify({ schema_version: 1, run_count: 20, hashes }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ baseline: baselinePath, hashes: hashPath, aggregate }, null, 2));
