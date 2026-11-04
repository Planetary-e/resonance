import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const powerReason = 'powermetrics requires superuser; no calibrated external AC meter authorized';
const manifestPath = 'delivery/results/econ-dec11-baseline-manifest.json';
const executionPath = 'delivery/results/econ-dec11-baseline-execution.json';
const manifest = json(manifestPath), execution = json(executionPath);
if (manifest.authorization_id !== 'DEC-011' || execution.authorization_id !== 'DEC-011'
  || manifest.baseline_windows.length !== 2 || execution.completed.length !== 2
  || execution.matrix_runs_executed !== 0 || execution.sustained_windows_executed !== true
  || execution.acceptance_evaluation !== 'not_run') throw new Error('DEC-011 scope invalid');
for (const [path, expected] of Object.entries(manifest.source_hashes)) if (sha256(path) !== expected) throw new Error(`Source mismatch: ${path}`);
const pathsFor = runId => ({
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
  finalization: `delivery/results/econ-finalization-${runId}.json`,
});
const rows = [];
for (const [index, result] of execution.completed.entries()) {
  const definition = manifest.baseline_windows[index], runId = definition.run_id, kind = definition.kind, paths = pathsFor(runId);
  if (result.run_id !== runId || result.scenario !== 'full-smoke' || result.outcome !== 'passed'
    || result.workers !== 52 || result.clean_stops !== 52) throw new Error(`Execution invalid: ${runId}`);
  const summary = json(paths.summary), processes = json(paths.process), disk = json(paths.disk), network = json(paths.network), work = json(paths.work);
  const cleanup = json(paths.cleanup), authorization = json(paths.authorization), owner = json(paths.owner), decision = json(paths.decision);
  const power = json(paths.power), finalization = json(paths.finalization);
  if (summary.run_id !== runId || summary.outcome !== 'passed' || summary.diagnostic_only !== true || summary.failure_error !== null
    || summary.source_manifest !== manifestPath || summary.window.kind !== kind || summary.window.runId !== runId
    || summary.window.seed !== definition.seed || summary.window.durationMs !== definition.duration_ms
    || summary.window.warmupMs !== definition.warmup_ms || summary.window.cooldownMs !== definition.cooldown_ms
    || summary.acceptance_evaluation !== 'not_run') throw new Error(`Summary invalid: ${runId}`);
  if (processes.run_id !== runId || processes.authorization_id !== 'DEC-011' || processes.status !== 'complete'
    || processes.worker_count !== 52 || processes.roles.length !== 52 || processes.clean_stops !== 52
    || processes.roles.some(role => role.lifecycle.at(-1)?.event !== 'exit' || role.lifecycle.at(-1)?.code !== 0)
    || cleanup.run_id !== runId || cleanup.remaining_live_workers !== 0 || cleanup.graceful_or_escalated_stops.length !== 52
    || cleanup.graceful_or_escalated_stops.some(role => role.exit_code !== 0)) throw new Error(`Process/cleanup invalid: ${runId}`);
  if (authorization.run_id !== runId || authorization.forged_cross_runtime_role_refused !== true
    || authorization.privileged_replica_runtime_read_refused !== true) throw new Error(`Authorization invalid: ${runId}`);
  if (work.run_id !== runId || work.roles.length !== 52 || work.roles.reduce((sum, role) => sum + role.used_bytes, 0) !== work.total_work_bytes
    || summary.work_bytes_separate_metric !== work.total_work_bytes) throw new Error(`Work invalid: ${runId}`);
  if (network.run_id !== runId || network.status !== 'complete' || !network.reconciliation.exact || !network.reconciliation.edge_envelopes_match
    || network.edges.reduce((sum, edge) => sum + edge.messages, 0) !== network.message_count
    || network.edges.reduce((sum, edge) => sum + edge.payload_bytes, 0) !== network.total_payload_bytes
    || network.edges.reduce((sum, edge) => sum + edge.websocket_frame_bytes, 0) !== network.total_frame_bytes
    || result.messages !== network.message_count || result.frame_bytes !== network.total_frame_bytes) throw new Error(`Network invalid: ${runId}`);
  if (power.run_id !== runId || power.status !== 'blocked' || power.reason !== powerReason || power.samples.length !== 0
    || power.energy_joules !== null || power.energy_kwh !== null
    || readFileSync(paths.powerCsv, 'utf8') !== `status,reason\nblocked,"${powerReason}"\n`) throw new Error(`Power invalid: ${runId}`);
  if (owner.run_id !== runId || owner.status !== 'pending' || owner.affordability_verdict !== 'pending'
    || decision.run_id !== runId || decision.run_status !== 'baseline_window_complete'
    || decision.E1 !== 'complete_for_local_planning_only' || decision.E2 !== 'blocked'
    || decision.E3 !== 'pending_separate_owner_authorization' || decision.D4 !== 'prototype-only'
    || decision.economic_affordability !== 'pending' || decision.acceptance_evaluation !== 'not_run') throw new Error(`Decision invalid: ${runId}`);
  const phases = summary.window.phases;
  if (phases.length !== 3 || phases.map(phase => phase.phase).join(',') !== 'warmup,baseline,cooldown'
    || phases.some(phase => !Number.isFinite(phase.monotonic_ms) || !Number.isFinite(Date.parse(phase.at)))) throw new Error(`Phases invalid: ${runId}`);
  const [warmup, baseline, cooldown] = phases;
  const monotonicWarmup = baseline.monotonic_ms - warmup.monotonic_ms;
  const monotonicBaseline = cooldown.monotonic_ms - baseline.monotonic_ms;
  const cooldownAt = Date.parse(cooldown.at);
  const stopRequested = processes.roles.map(role => Date.parse(role.lifecycle.find(event => event.event === 'stop-requested')?.at))
    .filter(at => Number.isFinite(at) && at >= cooldownAt);
  const cooldownWall = stopRequested.length ? Math.min(...stopRequested) - cooldownAt : Number.NEGATIVE_INFINITY;
  if (monotonicWarmup < definition.warmup_ms || monotonicBaseline < definition.duration_ms || cooldownWall < definition.cooldown_ms) {
    throw new Error(`Duration invalid: ${runId}; warmup=${monotonicWarmup}, baseline=${monotonicBaseline}, cooldown=${cooldownWall}`);
  }
  const finalPhaseNames = finalization.phases.map(phase => phase.phase);
  for (const required of ['metrics', 'host-tools', 'stop-workers', 'network-evidence', 'artifacts', 'summary', 'cleanup']) {
    if (!finalPhaseNames.includes(required)) throw new Error(`Finalization phase missing: ${runId}: ${required}`);
  }
  if (finalization.run_id !== runId || finalization.status !== 'complete' || finalization.phase !== 'cleanup' || finalization.error !== null) {
    throw new Error(`Finalization invalid: ${runId}`);
  }
  const operations = summary.window.sustained_operations;
  if (kind === 'idle' && (operations.reads !== 0 || operations.retries !== 0 || summary.post_new_view_durable_readiness !== null
    || existsSync(paths.readiness))) throw new Error(`Idle behavior invalid: ${runId}`);
  if (kind === 'sustained') {
    if (operations.reads <= 0 || operations.retries <= 0 || summary.recovered_proofs <= 0 || summary.logical_process_held_copy_audits <= 0
      || !existsSync(paths.readiness)) throw new Error(`Sustained behavior invalid: ${runId}`);
    const readiness = json(paths.readiness);
    if (readiness.run_id !== runId || !readiness.post_new_view_startup_complete || !readiness.durable_serving_readiness) {
      throw new Error(`Readiness invalid: ${runId}`);
    }
  }
  rows.push({
    run_id: runId, scenario: kind, seed: definition.seed, duration_ms: definition.duration_ms,
    warmup_ms: definition.warmup_ms, cooldown_ms: definition.cooldown_ms,
    measured_warmup_monotonic_ms: monotonicWarmup, measured_baseline_monotonic_ms: monotonicBaseline, measured_cooldown_wall_ms: cooldownWall,
    work_bytes: work.total_work_bytes, per_role_work_bytes: Object.fromEntries(work.roles.map(role => [role.role, role.used_bytes])),
    messages: network.message_count, payload_bytes: network.total_payload_bytes, frame_bytes: network.total_frame_bytes,
    user_cpu_micros: processes.roles.reduce((sum, role) => sum + role.cpu.userMicros, 0),
    system_cpu_micros: processes.roles.reduce((sum, role) => sum + role.cpu.systemMicros, 0),
    maximum_tree_rss_bytes: Math.max(...processes.roles.map(role => role.peak_tree_rss_bytes)),
    clean_stops: 52, remaining_live_workers: 0, sustained_operations: operations, phases,
    recovered_proofs: summary.recovered_proofs, logical_copy_audits: summary.logical_process_held_copy_audits,
    finalization_phases: finalPhaseNames,
    sample_limitations: { process: processes.isolation_limitations, disk: disk.limitations,
      per_process_disk: disk.process_disk_counters, iostat: disk.iostat, nettop: network.nettop, network: network.limitations },
    paths,
  });
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
const baselinePath = 'delivery/results/econ-dec11-baseline-baseline.json';
const baseline = {
  schema_version: 1, authorization_id: 'DEC-011', outcome: 'passed_diagnostic_windows', run_count: 2,
  command: 'node scripts/rso5-dec11-baseline.mjs', execution_artifact: executionPath, manifest_artifact: manifestPath,
  runs: rows, aggregate, E1: 'complete_for_local_planning_only', E2: 'blocked', E2_reasons: ['Physical power blocked'],
  E3: 'pending_separate_owner_authorization', D4: 'prototype-only', economic_affordability: 'pending', acceptance_evaluation: 'not_run',
  independent_budget_review: 'may_proceed', revised_budget_approval: 'pending_separate_owner_approval', production_approval: 'not_granted',
};
writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const decisionPath = 'delivery/results/econ-dec11-budget-review-decision.json';
writeFileSync(decisionPath, `${JSON.stringify({ schema_version: 1, authorization_id: 'DEC-011', status: 'diagnostic_evidence_complete',
  baseline_artifact: baselinePath, dec010_blocked_artifact: 'delivery/results/econ-production-baseline-baseline.json',
  unified_matrix_artifact: 'delivery/results/econ-unified-baseline-final.json', independent_budget_review: 'may_proceed',
  required_analysis: ['mandatory measured maxima', 'complete failure history', 'uncertainty margins', 'owner prices/budget/value'],
  revised_budget_approval: 'pending_separate_owner_approval', E2: 'blocked', E2_reasons: ['Physical power blocked'],
  E3: 'pending_separate_owner_authorization', D4: 'prototype-only', economic_affordability: 'pending',
  production_approval: 'not_granted', deployment: 'not_run', acceptance_evaluation: 'not_run' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const smokePaths = Object.values(pathsFor('dec11-finalization-smoke'));
const hashPaths = [manifestPath, executionPath, baselinePath, decisionPath,
  'delivery/results/econ-production-baseline-hashes.json', 'delivery/results/econ-production-evaluation-decision.json',
  'docs/evals/v04-production-evaluation-baseline-2026-10-30.md', 'docs/evals/v04-recovery-economic-baseline-windows-2026-10-30.md',
  'scripts/rso5-dec11-baseline.mjs', 'scripts/rso5-dec11-baseline-manifest.mjs', 'scripts/rso5-dec11-baseline-evidence.mjs',
  'packages/relay/src/__tests__/sustainable-rso5-dec11-finalization.integration.test.ts', ...smokePaths];
for (const row of rows) hashPaths.push(...Object.values(row.paths).filter(path => existsSync(path)));
const hashes = Object.fromEntries([...new Set(hashPaths)].sort().map(path => [path, sha256(path)]));
const hashesPath = 'delivery/results/econ-dec11-baseline-hashes.json';
writeFileSync(hashesPath, `${JSON.stringify({ schema_version: 1, authorization_id: 'DEC-011', run_count: 2,
  artifact_count: Object.keys(hashes).length, hashes }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ baseline: baselinePath, decision: decisionPath, hashes: hashesPath,
  artifact_count: Object.keys(hashes).length, aggregate }, null, 2));
