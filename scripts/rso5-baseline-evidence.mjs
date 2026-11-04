import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const powerReason = 'powermetrics requires superuser; no calibrated external AC meter authorized';
const executionPath = 'delivery/results/econ-baseline-windows-execution.json';
const manifestPath = 'delivery/results/econ-baseline-windows-manifest-v6.json';
const execution = json(executionPath), manifest = json(manifestPath);
if (execution.completed.length !== 2 || execution.matrix_runs_executed !== 0 || execution.sustained_windows_executed !== true
  || execution.acceptance_evaluation !== 'not_run') throw new Error('Both baseline-only windows are required');
if (manifest.baseline_windows.length !== 2) throw new Error('Frozen baseline inventory invalid');
for (const [path, expected] of Object.entries(manifest.source_hashes)) {
  const actual = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  if (actual !== expected) throw new Error(`Frozen source hash mismatch: ${path}`);
}
const rows = [];
for (const [index, result] of execution.completed.entries()) {
  const definition = manifest.baseline_windows[index], runId = definition.run_id, kind = definition.kind;
  if (result.run_id !== runId || result.scenario !== 'full-smoke' || result.outcome !== 'passed'
    || result.workers !== 52 || result.clean_stops !== 52) throw new Error(`Execution identity invalid: ${runId}`);
  const paths = {
    summary: `delivery/results/econ-lab-summary-${runId}.json`,
    process: `delivery/results/econ-process-${runId}.json`,
    disk: `delivery/results/econ-disk-${runId}.json`,
    network: `delivery/results/econ-network-${runId}.json`,
    work: `delivery/results/econ-work-${runId}.json`,
    cleanup: `delivery/results/econ-cleanup-${runId}.json`,
    authorization: `delivery/results/econ-authorization-${runId}.json`,
    owner: `delivery/results/econ-owner-assumptions-${runId}.json`,
    decision: `delivery/results/econ-decision-${runId}.json`,
    power: `delivery/results/econ-power-${runId}.json`,
    powerCsv: `delivery/results/econ-power-${runId}.csv`,
    readiness: `delivery/results/econ-new-view-readiness-${runId}.json`,
  };
  const summary = json(paths.summary), processes = json(paths.process), disk = json(paths.disk), network = json(paths.network), work = json(paths.work);
  const cleanup = json(paths.cleanup), authorization = json(paths.authorization), owner = json(paths.owner);
  const power = json(paths.power), decision = json(paths.decision);
  if (summary.run_id !== runId || summary.outcome !== 'passed' || summary.diagnostic_only !== true
    || summary.window.kind !== kind || summary.window.runId !== runId || summary.window.seed !== definition.seed
    || summary.window.durationMs !== definition.duration_ms || summary.window.warmupMs !== definition.warmup_ms
    || summary.window.cooldownMs !== definition.cooldown_ms || summary.acceptance_evaluation !== 'not_run') throw new Error(`Window summary invalid: ${runId}`);
  if (processes.run_id !== runId || processes.worker_count !== 52 || processes.roles.length !== 52 || processes.clean_stops !== 52
    || processes.roles.some(role => role.lifecycle.at(-1)?.event !== 'exit' || role.lifecycle.at(-1)?.code !== 0)
    || cleanup.run_id !== runId || cleanup.remaining_live_workers !== 0 || cleanup.graceful_or_escalated_stops.length !== 52
    || cleanup.graceful_or_escalated_stops.some(role => role.exit_code !== 0)
    || !network.reconciliation.exact || !network.reconciliation.edge_envelopes_match) throw new Error(`Window gates invalid: ${runId}`);
  if (work.run_id !== runId || work.roles.length !== 52
    || work.roles.reduce((sum, role) => sum + role.used_bytes, 0) !== work.total_work_bytes
    || summary.work_bytes_separate_metric !== work.total_work_bytes) throw new Error(`Window work sum invalid: ${runId}`);
  if (network.run_id !== runId || network.edges.reduce((sum, edge) => sum + edge.messages, 0) !== network.message_count
    || network.edges.reduce((sum, edge) => sum + edge.payload_bytes, 0) !== network.total_payload_bytes
    || network.edges.reduce((sum, edge) => sum + edge.websocket_frame_bytes, 0) !== network.total_frame_bytes
    || result.messages !== network.message_count || result.frame_bytes !== network.total_frame_bytes) throw new Error(`Window network totals invalid: ${runId}`);
  const expectedPowerCsv = `status,reason\nblocked,"${powerReason}"\n`;
  if (power.run_id !== runId || power.status !== 'blocked' || power.reason !== powerReason || power.samples.length !== 0
    || power.energy_joules !== null || power.energy_kwh !== null || readFileSync(paths.powerCsv, 'utf8') !== expectedPowerCsv) throw new Error(`Power blocker invalid: ${runId}`);
  if (owner.run_id !== runId || owner.status !== 'pending' || owner.affordability_verdict !== 'pending'
    || decision.run_id !== runId || decision.run_status !== 'baseline_window_complete'
    || decision.E1 !== 'complete_for_local_planning_only' || decision.E2 !== 'blocked'
    || decision.E3 !== 'pending_separate_owner_authorization' || decision.D4 !== 'prototype-only'
    || decision.economic_affordability !== 'pending' || decision.acceptance_evaluation !== 'not_run'
    || authorization.run_id !== runId || authorization.forged_cross_runtime_role_refused !== true
    || authorization.privileged_replica_runtime_read_refused !== true) throw new Error(`Window decision invalid: ${runId}`);
  const phases = summary.window.phases;
  if (phases.length !== 3 || phases.map(phase => phase.phase).join(',') !== 'warmup,baseline,cooldown') throw new Error(`Window phases invalid: ${runId}`);
  const [warmupStart, baselineStart, cooldownStart] = phases.map(phase => Date.parse(phase.at));
  const stopRequested = processes.roles.map(role => Date.parse(role.lifecycle.find(event => event.event === 'stop-requested')?.at));
  if (![warmupStart, baselineStart, cooldownStart, ...stopRequested].every(Number.isFinite)
    || baselineStart - warmupStart < definition.warmup_ms || cooldownStart - baselineStart < definition.duration_ms
    || Math.min(...stopRequested) - cooldownStart < definition.cooldown_ms) throw new Error(`Window duration invalid: ${runId}`);
  const operations = summary.window.sustained_operations;
  if (kind === 'idle' && (operations.reads !== 0 || operations.retries !== 0 || summary.post_new_view_durable_readiness !== null
    || existsSync(paths.readiness))) throw new Error(`Idle window behavior invalid: ${runId}`);
  if (kind === 'sustained') {
    if (operations.reads <= 0 || operations.retries <= 0 || !existsSync(paths.readiness)) throw new Error(`Sustained work missing: ${runId}`);
    const readiness = json(paths.readiness);
    if (readiness.run_id !== runId || !readiness.post_new_view_startup_complete || !readiness.durable_serving_readiness) throw new Error(`Sustained readiness invalid: ${runId}`);
  }
  rows.push({ run_id: runId, scenario: kind, seed: definition.seed, duration_ms: definition.duration_ms,
    warmup_ms: definition.warmup_ms, cooldown_ms: definition.cooldown_ms,
    work_bytes: work.total_work_bytes, per_role_work_bytes: Object.fromEntries(work.roles.map(role => [role.role, role.used_bytes])),
    messages: network.message_count, payload_bytes: network.total_payload_bytes, frame_bytes: network.total_frame_bytes,
    user_cpu_micros: processes.roles.reduce((sum, role) => sum + role.cpu.userMicros, 0),
    system_cpu_micros: processes.roles.reduce((sum, role) => sum + role.cpu.systemMicros, 0),
    maximum_tree_rss_bytes: Math.max(...processes.roles.map(role => role.peak_tree_rss_bytes)),
    clean_stops: processes.clean_stops, remaining_live_workers: cleanup.remaining_live_workers,
    sustained_operations: operations, phases,
    sample_limitations: { process: processes.isolation_limitations, disk: disk.limitations,
      per_process_disk: disk.process_disk_counters, iostat: disk.iostat, nettop: network.nettop, network: network.limitations },
    paths });
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
const baselinePath = 'delivery/results/econ-baseline-windows-baseline.json';
const baseline = { schema_version: 1, outcome: 'passed_diagnostic_windows', run_count: 2,
  command: 'node scripts/rso5-baseline-windows.mjs', execution_artifact: executionPath, manifest_artifact: manifestPath,
  runs: rows, aggregate, E1: 'complete_for_local_planning_only', E2: 'blocked', E2_reasons: ['Physical power blocked'],
  E3: 'pending_separate_owner_authorization', D4: 'prototype-only', economic_affordability: 'pending', acceptance_evaluation: 'not_run' };
writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const resultNames = readdirSync('delivery/results');
const invalidHistory = resultNames.filter(name => /^econ-baseline-windows-failure-\d+\.json$/.test(name)
  || /^econ-(?:lab-summary|process|disk|network|work|cleanup|authorization|owner-assumptions|decision|power)-undefined\.(?:json|csv)$/.test(name)
  || /^econ-(?:lab-summary|process|disk|network|work|cleanup|authorization|owner-assumptions|decision|power|new-view-readiness)-(?:idle-baseline-final|sustained-max-envelope-final)\.(?:json|csv)$/.test(name));
const hashPaths = [executionPath, 'delivery/results/econ-baseline-windows-manifest.json',
  'delivery/results/econ-baseline-windows-manifest-v2.json', 'delivery/results/econ-baseline-windows-manifest-v3.json',
  'delivery/results/econ-baseline-windows-manifest-v4.json', 'delivery/results/econ-baseline-windows-manifest-v5.json',
  'delivery/results/econ-baseline-windows-cleanup-v3-invalid.json', 'delivery/results/econ-authorization-idle-baseline.json',
  'delivery/results/econ-cleanup-idle-baseline.json', manifestPath, baselinePath, 'scripts/rso5-baseline-evidence.mjs',
  ...invalidHistory.map(name => `delivery/results/${name}`)];
for (const row of rows) hashPaths.push(...Object.entries(row.paths).flatMap(([name, path]) => name === 'readiness' && !existsSync(path) ? [] : [path]));
const hashes = Object.fromEntries([...new Set(hashPaths)].sort().map(path => [path, `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`]));
const hashPath = 'delivery/results/econ-baseline-windows-hashes.json';
writeFileSync(hashPath, `${JSON.stringify({ schema_version: 1, run_count: 2, artifact_count: Object.keys(hashes).length, hashes }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ baseline: baselinePath, hashes: hashPath, artifact_count: Object.keys(hashes).length, aggregate }, null, 2));
