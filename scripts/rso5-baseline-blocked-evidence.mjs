import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const number = value => value.toLocaleString('en-US');
const powerReason = 'powermetrics requires superuser; no calibrated external AC meter authorized';
const manifestPath = 'delivery/results/econ-baseline-windows-manifest-v6.json';
const idleId = 'idle-baseline-complete', sustainedId = 'sustained-max-envelope-complete';
const manifest = json(manifestPath);
for (const [path, expected] of Object.entries(manifest.source_hashes)) {
  if (sha256(path) !== expected) throw new Error(`Frozen source hash mismatch: ${path}`);
}
for (const file of ['delivery/results/econ-unified-evidence-hashes-final.json', 'delivery/results/econ-unified-review-hashes.json']) {
  const evidence = json(file);
  for (const [path, expected] of Object.entries(evidence.hashes)) if (sha256(path) !== expected) throw new Error(`Unified evidence changed: ${path}`);
}
const artifactPaths = id => ({
  summary: `delivery/results/econ-lab-summary-${id}.json`,
  process: `delivery/results/econ-process-${id}.json`,
  disk: `delivery/results/econ-disk-${id}.json`,
  network: `delivery/results/econ-network-${id}.json`,
  work: `delivery/results/econ-work-${id}.json`,
  cleanup: `delivery/results/econ-cleanup-${id}.json`,
  authorization: `delivery/results/econ-authorization-${id}.json`,
  owner: `delivery/results/econ-owner-assumptions-${id}.json`,
  decision: `delivery/results/econ-decision-${id}.json`,
  power: `delivery/results/econ-power-${id}.json`,
  powerCsv: `delivery/results/econ-power-${id}.csv`,
  readiness: `delivery/results/econ-new-view-readiness-${id}.json`,
});
const idlePaths = artifactPaths(idleId), sustainedPaths = artifactPaths(sustainedId);
const summary = json(idlePaths.summary), processes = json(idlePaths.process), network = json(idlePaths.network), work = json(idlePaths.work);
const cleanup = json(idlePaths.cleanup), power = json(idlePaths.power), owner = json(idlePaths.owner), decision = json(idlePaths.decision);
if (summary.run_id !== idleId || summary.outcome !== 'passed' || summary.window.kind !== 'idle'
  || summary.window.durationMs !== 1800000 || summary.window.warmupMs !== 60000 || summary.window.cooldownMs !== 60000
  || summary.window.sustained_operations.reads !== 0 || summary.window.sustained_operations.retries !== 0
  || processes.clean_stops !== 52 || processes.roles.length !== 52 || cleanup.remaining_live_workers !== 0
  || !network.reconciliation.exact || !network.reconciliation.edge_envelopes_match
  || work.roles.reduce((sum, role) => sum + role.used_bytes, 0) !== work.total_work_bytes
  || network.edges.reduce((sum, edge) => sum + edge.messages, 0) !== network.message_count
  || network.edges.reduce((sum, edge) => sum + edge.payload_bytes, 0) !== network.total_payload_bytes
  || network.edges.reduce((sum, edge) => sum + edge.websocket_frame_bytes, 0) !== network.total_frame_bytes
  || power.status !== 'blocked' || power.reason !== powerReason || power.samples.length !== 0
  || readFileSync(idlePaths.powerCsv, 'utf8') !== `status,reason\nblocked,"${powerReason}"\n`
  || owner.status !== 'pending' || decision.E2 !== 'blocked' || decision.E3 !== 'pending_separate_owner_authorization'
  || decision.D4 !== 'prototype-only') throw new Error('Completed idle evidence failed validation');
const [warmup, baselineStart, cooldown] = summary.window.phases.map(phase => Date.parse(phase.at));
const firstStop = Math.min(...processes.roles.map(role => Date.parse(role.lifecycle.find(event => event.event === 'stop-requested').at)));
const idleTimingGatePassed = baselineStart - warmup >= 60000 && cooldown - baselineStart >= 1800000 && firstStop - cooldown >= 60000;
const idleBaselineShortfallMs = Math.max(0, 1800000 - (cooldown - baselineStart));
const missingSustained = Object.entries(sustainedPaths).filter(([name, path]) => name !== 'authorization' && name !== 'readiness' && existsSync(path));
if (missingSustained.length || !existsSync(sustainedPaths.authorization)) throw new Error('Unexpected sustained artifact state');
const timeoutCleanupPath = 'delivery/results/econ-baseline-windows-cleanup-v6-timeout.json', timeoutCleanup = json(timeoutCleanupPath);
if (timeoutCleanup.status !== 'complete' || timeoutCleanup.remaining_live_workers !== 0 || timeoutCleanup.orphan_pid !== 98966) throw new Error('Timeout orphan cleanup invalid');
const executionPath = 'delivery/results/econ-baseline-windows-execution.json';
const execution = {
  schema_version: 1,
  outcome: 'blocked_incomplete_sustained_window',
  command: 'node scripts/rso5-baseline-windows.mjs',
  source_manifest: manifestPath,
  recorded_at: new Date().toISOString(),
  terminal_reason: 'The 4,500,000 ms Vitest/background deadline interrupted sustained finalization before process, network, work, summary and cleanup artifacts were written; the triggering finalization error, if any, is unavailable.',
  completed: [{ run_id: idleId, scenario: 'full-smoke', kind: 'idle', outcome: 'artifact_complete_window_short', workers: 52, clean_stops: 52,
    window_30min_gate_passed: idleTimingGatePassed, baseline_shortfall_ms: idleBaselineShortfallMs,
    messages: network.message_count, frame_bytes: network.total_frame_bytes }],
  incomplete: { run_id: sustainedId, scenario: 'full-smoke', kind: 'sustained', present_artifacts: [sustainedPaths.authorization, timeoutCleanupPath],
    missing_required_artifacts: Object.entries(sustainedPaths).filter(([name]) => !['authorization', 'readiness'].includes(name)).map(([, path]) => path) },
  matrix_runs_executed: 0,
  sustained_windows_executed: false,
  acceptance_evaluation: 'not_run',
};
writeFileSync(executionPath, `${JSON.stringify(execution, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const idle = {
  run_id: idleId, scenario: 'idle', seed: '0xE007B001', duration_ms: 1800000, warmup_ms: 60000, cooldown_ms: 60000,
  measured_warmup_ms: baselineStart - warmup, measured_baseline_ms: cooldown - baselineStart, measured_cooldown_to_first_stop_ms: firstStop - cooldown,
  window_30min_gate_passed: idleTimingGatePassed, baseline_shortfall_ms: idleBaselineShortfallMs,
  work_bytes: work.total_work_bytes, per_role_work_bytes: Object.fromEntries(work.roles.map(role => [role.role, role.used_bytes])),
  messages: network.message_count, payload_bytes: network.total_payload_bytes, frame_bytes: network.total_frame_bytes,
  user_cpu_micros: processes.roles.reduce((sum, role) => sum + role.cpu.userMicros, 0),
  system_cpu_micros: processes.roles.reduce((sum, role) => sum + role.cpu.systemMicros, 0),
  maximum_tree_rss_bytes: Math.max(...processes.roles.map(role => role.peak_tree_rss_bytes)),
  clean_stops: 52, remaining_live_workers: 0, phases: summary.window.phases, paths: idlePaths,
};
const baselinePath = 'delivery/results/econ-baseline-windows-baseline.json';
const baseline = {
  schema_version: 1, outcome: 'blocked_incomplete_sustained_window', valid_run_count: 0,
  command: 'node scripts/rso5-baseline-windows.mjs', execution_artifact: executionPath, manifest_artifact: manifestPath,
  runs: [idle], incomplete_sustained: execution.incomplete, aggregate: null,
  E1: 'incomplete_baseline_evidence', E2: 'blocked', E2_reasons: ['Idle baseline phase 6 ms short', 'Sustained window final artifacts missing after timeout', 'Physical power blocked'],
  E3: 'pending_separate_owner_authorization', D4: 'prototype-only', economic_affordability: 'pending', acceptance_evaluation: 'not_run',
  final_baseline_review: 'blocked_idle_short_and_missing_sustained_evidence', unified_matrix_review: 'available',
};
writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const resultNames = readdirSync('delivery/results');
const historical = resultNames.filter(name => /^econ-baseline-windows-failure-\d+\.json$/.test(name)
  || /^econ-baseline-windows-cleanup-v3-invalid\.json$/.test(name)
  || /^econ-(?:lab-summary|process|disk|network|work|cleanup|authorization|owner-assumptions|decision|power|new-view-readiness)-(?:undefined|idle-baseline|idle-baseline-final|sustained-max-envelope-final)\.(?:json|csv)$/.test(name));
const manifests = ['econ-baseline-windows-manifest.json', 'econ-baseline-windows-manifest-v2.json', 'econ-baseline-windows-manifest-v3.json',
  'econ-baseline-windows-manifest-v4.json', 'econ-baseline-windows-manifest-v5.json', 'econ-baseline-windows-manifest-v6.json'];
const hashPaths = [executionPath, baselinePath, timeoutCleanupPath, sustainedPaths.authorization,
  ...Object.entries(idlePaths).filter(([name]) => name !== 'readiness').map(([, path]) => path),
  ...manifests.map(name => `delivery/results/${name}`), ...historical.map(name => `delivery/results/${name}`),
  'scripts/rso5-baseline-evidence.mjs', 'scripts/rso5-baseline-receipt.mjs', 'scripts/rso5-baseline-blocked-evidence.mjs'];
const hashes = Object.fromEntries([...new Set(hashPaths)].sort().map(path => [path, sha256(path)]));
const hashesPath = 'delivery/results/econ-baseline-windows-hashes.json';
writeFileSync(hashesPath, `${JSON.stringify({ schema_version: 1, outcome: 'blocked_incomplete_sustained_window', valid_run_count: 0,
  artifact_count: Object.keys(hashes).length, hashes }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const receiptPath = 'docs/evals/v04-recovery-economic-baseline-windows-2026-10-30.md';
const lines = [
  '# RSO5 baseline windows blocked postmortem — DEC-008', '',
  '**Status: idle artifacts complete but 6 ms short of the strict 30-minute gate; sustained window incomplete after the 75-minute harness deadline; full baseline review blocked.** E2 remains blocked, E3 requires separate owner authorization, D4 remains prototype-only, and no economic affordability, production or K/R acceptance is claimed.', '',
  '## Terminal blockers and cleanup', '',
  `The v6 attempt used \`${manifestPath}\` with all 26 source hashes verified. Its idle artifact set completed with 52/52 clean stops and zero survivors, but its phase markers span ${number(idle.measured_baseline_ms)} ms, ${idle.baseline_shortfall_ms} ms short of 1,800,000 ms. The sustained window then reached finalization but did not produce process, disk, network, work, summary, decision, owner, power or cleanup artifacts before the 4,500,000 ms deadline killed the parent test. The log shows worker exits during final cleanup, but does not preserve a triggering finalization error. No sustained totals or clean-stop claim can be reconstructed.`, '',
  'One orphaned worker, PID 98966 with PPID 1, remained after parent exit. It was identified by its exact worker command and terminated with SIGKILL; `delivery/results/econ-baseline-windows-cleanup-v6-timeout.json` records zero survivors. No further window was started.', '',
  '## Idle artifact measurements (30-minute gate failed)', '',
  '| Metric | Result |', '| --- | ---: |',
  `| Warmup / baseline / cooldown | ${number(idle.measured_warmup_ms)} / ${number(idle.measured_baseline_ms)} / ${number(idle.measured_cooldown_to_first_stop_ms)} ms |`,
  `| Separate work metric | ${number(idle.work_bytes)} B |`,
  `| Request+response envelopes | ${number(idle.messages)} |`,
  `| Application payload bytes | ${number(idle.payload_bytes)} |`,
  `| Application WebSocket frame bytes | ${number(idle.frame_bytes)} |`,
  `| Worker user CPU | ${(idle.user_cpu_micros / 1e6).toFixed(6)} s |`,
  `| Worker system CPU | ${(idle.system_cpu_micros / 1e6).toFixed(6)} s |`,
  `| Maximum sampled process-tree RSS | ${number(idle.maximum_tree_rss_bytes)} B |`,
  '| Sustained reads / retries | 0 / 0 |',
  '| Clean stops / survivors | 52/52 / 0 |', '',
  'Idle work equals the exact sum of per-role `used_bytes`; network edges reconcile exactly to message, payload and frame totals. No two-window aggregate is reported because the idle duration gate failed and sustained evidence is missing.', '',
  '## Per-role idle work', '',
  '| Role | Work bytes |', '| --- | ---: |',
  ...Object.entries(idle.per_role_work_bytes).map(([role, bytes]) => `| \`${role}\` | ${number(bytes)} |`),
  `| **Total** | **${number(idle.work_bytes)}** |`, '',
  '## Preserved attempts and limitations', '',
  'All earlier failures and invalid or superseded identities are retained and hashed: unmapped durations; missing `runId` and `undefined` artifacts; stale v3 source identity and its 52-worker cleanup; v4 artifact collision; v5 idle artifacts plus retired resolved-retry failure; and v6 timeout. The resolved retry was rebound to the returning admission set without weakening retry rules, but the v6 sustained artifacts are still incomplete.', '',
  `- Power remains exactly \`blocked\`: \`${powerReason}\`. No samples or energy estimates exist.`,
  '- Application WebSocket payload/frame accounting excludes handshake/control frames and TCP/IP bytes. Loopback is not Internet evidence; nettop matched zero worker rows.',
  '- Per-process physical disk counters and fsync latency are unavailable; iostat is host-only. RSS is best-effort sampled on one host.',
  '- Prices, budget, value, affordability and E3 remain open. No E2, production or K/R acceptance follows.', '',
  '## Evidence hashes', '',
  `\`${hashesPath}\` binds ${Object.keys(hashes).length} artifacts, including the blocked execution/baseline, idle evidence with its duration shortfall, incomplete sustained identity, cleanup and all preserved baseline attempt history. The unified matrix hash sets were independently reverified: 254 evidence artifacts and 256 review artifacts, with zero mismatches.`, '',
  '| Artifact | SHA-256 |', '| --- | --- |',
  ...Object.entries(hashes).map(([path, hash]) => `| \`${path}\` | \`${hash}\` |`), '',
  '**Full baseline final review cannot proceed** until a complete 30-minute idle window and complete sustained evidence exist. Independent review of the previously accepted unified 20-run matrix remains available; this postmortem does not invalidate it.', '',
];
writeFileSync(receiptPath, lines.join('\n'), { mode: 0o600, flag: 'wx' });
const reviewHashesPath = 'delivery/results/econ-baseline-windows-review-hashes.json';
writeFileSync(reviewHashesPath, `${JSON.stringify({ schema_version: 1, outcome: 'blocked_incomplete_sustained_window',
  hashes: Object.fromEntries([hashesPath, receiptPath, 'scripts/rso5-baseline-blocked-evidence.mjs'].sort().map(path => [path, sha256(path)])) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ execution: executionPath, baseline: baselinePath, hashes: hashesPath, receipt: receiptPath,
  review_hashes: reviewHashesPath, idle: { work_bytes: idle.work_bytes, messages: idle.messages, payload_bytes: idle.payload_bytes,
    frame_bytes: idle.frame_bytes, user_cpu_micros: idle.user_cpu_micros, system_cpu_micros: idle.system_cpu_micros,
    maximum_tree_rss_bytes: idle.maximum_tree_rss_bytes }, artifact_count: Object.keys(hashes).length }, null, 2));
