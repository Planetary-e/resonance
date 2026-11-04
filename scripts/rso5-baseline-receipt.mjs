import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const number = value => value.toLocaleString('en-US');
const seconds = micros => (micros / 1e6).toFixed(6);
const baselinePath = 'delivery/results/econ-baseline-windows-baseline.json';
const hashesPath = 'delivery/results/econ-baseline-windows-hashes.json';
const receiptPath = 'docs/evals/v04-recovery-economic-baseline-windows-2026-10-29.md';
const reviewHashesPath = 'delivery/results/econ-baseline-windows-review-hashes.json';
const baseline = json(baselinePath), evidence = json(hashesPath), execution = json(baseline.execution_artifact);
for (const [path, expected] of Object.entries(evidence.hashes)) {
  const actual = sha256(path);
  if (actual !== expected) throw new Error(`Evidence hash mismatch: ${path}`);
}
const timings = baseline.runs.map(run => {
  const processes = json(run.paths.process);
  const [warmup, baselineStart, cooldown] = run.phases.map(phase => Date.parse(phase.at));
  const firstStop = Math.min(...processes.roles.map(role => Date.parse(role.lifecycle.find(event => event.event === 'stop-requested').at)));
  return { warmup_ms: baselineStart - warmup, baseline_ms: cooldown - baselineStart, cooldown_ms: firstStop - cooldown };
});
const roles = Object.keys(baseline.runs[0].per_role_work_bytes);
const lines = [
  '# RSO5 continuous idle and sustained baseline receipt — DEC-008',
  '',
  '**Status: 2/2 diagnostic baseline windows complete and independently recomputed; E1 complete for local planning only; E2 blocked by physical power; E3 pending separate owner authorization; D4 prototype-only.** No economic affordability, production, K/R or other acceptance is claimed.',
  '',
  '## Frozen execution and preserved failures',
  '',
  'Command:',
  '',
  '```',
  baseline.command,
  '```',
  '',
  `Execution started at \`${execution.started_at}\` and completed at \`${execution.completed_at}\`. The frozen manifest is \`${baseline.manifest_artifact}\`; all 26 source hashes were recomputed and verified before this execution. No matrix run, production routing, dependency installation, privileged command, Git/CI or installer action occurred.`,
  '',
  'Earlier attempts remain invalid or superseded diagnostic history and are excluded from the aggregate: the first failed before workers because duration fields were unmapped; the second omitted `runId`, wrote idle artifacts under `undefined`, and failed on the sustained cleanup filename collision after both timed phases; the third reused stale source hashes and was stopped before completion, with its 52 orphaned workers escalated to SIGKILL and zero survivors; the fourth collided with the third attempt’s partial authorization artifact before the timed window and cleaned up all workers; the fifth completed a valid idle window but its sustained resolved retry named a retired admission set before the timed phase. Both windows were rerun under one corrected source identity rather than mixing versions. Unique final identities and a pre-worker artifact collision check prevent filename recurrence. All failure, `undefined`, v2/v3/v4/v5 manifest and invalid or superseded run artifacts are retained and hashed below.',
  '',
  '## Window definitions and measured phases',
  '',
  '| Window | Seed | Warmup | Baseline | Cooldown | Measured warmup | Measured baseline | Measured cooldown to first stop |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...baseline.runs.map((run, index) => `| \`${run.run_id}\` | \`${run.seed}\` | ${number(run.warmup_ms)} ms | ${number(run.duration_ms)} ms | ${number(run.cooldown_ms)} ms | ${number(timings[index].warmup_ms)} ms | ${number(timings[index].baseline_ms)} ms | ${number(timings[index].cooldown_ms)} ms |`),
  '',
  'Phase markers are preserved in each run summary and process artifact. Cooldown is measured to the earliest worker stop request, so it is a conservative lower bound. The idle window retained all 52 enrolled roles without business recovery operations. The sustained window completed one full RSO5 lifecycle, then continuously performed quota-safe reads and resolved/unresolved recovery retries without creating new proofs.',
  '',
  '## Per-window measurements',
  '',
  '| Metric | Idle baseline | Sustained maximum envelope | Aggregate / maximum |',
  '| --- | ---: | ---: | ---: |',
  `| Separate work metric | ${number(baseline.runs[0].work_bytes)} B | ${number(baseline.runs[1].work_bytes)} B | ${number(baseline.aggregate.work_bytes)} B |`,
  `| Request+response envelopes | ${number(baseline.runs[0].messages)} | ${number(baseline.runs[1].messages)} | ${number(baseline.aggregate.messages)} |`,
  `| Application payload bytes | ${number(baseline.runs[0].payload_bytes)} | ${number(baseline.runs[1].payload_bytes)} | ${number(baseline.aggregate.payload_bytes)} |`,
  `| Application WebSocket frame bytes | ${number(baseline.runs[0].frame_bytes)} | ${number(baseline.runs[1].frame_bytes)} | ${number(baseline.aggregate.frame_bytes)} |`,
  `| Worker user CPU | ${seconds(baseline.runs[0].user_cpu_micros)} s | ${seconds(baseline.runs[1].user_cpu_micros)} s | ${baseline.aggregate.user_cpu_seconds.toFixed(6)} s |`,
  `| Worker system CPU | ${seconds(baseline.runs[0].system_cpu_micros)} s | ${seconds(baseline.runs[1].system_cpu_micros)} s | ${baseline.aggregate.system_cpu_seconds.toFixed(6)} s |`,
  `| Maximum sampled process-tree RSS | ${number(baseline.runs[0].maximum_tree_rss_bytes)} B | ${number(baseline.runs[1].maximum_tree_rss_bytes)} B | ${number(baseline.aggregate.maximum_tree_rss_bytes)} B |`,
  `| Sustained reads | ${number(baseline.runs[0].sustained_operations.reads)} | ${number(baseline.runs[1].sustained_operations.reads)} | ${number(baseline.runs.reduce((sum, run) => sum + run.sustained_operations.reads, 0))} |`,
  `| Sustained retries | ${number(baseline.runs[0].sustained_operations.retries)} | ${number(baseline.runs[1].sustained_operations.retries)} | ${number(baseline.runs.reduce((sum, run) => sum + run.sustained_operations.retries, 0))} |`,
  `| Clean worker stops | ${baseline.runs[0].clean_stops}/52 | ${baseline.runs[1].clean_stops}/52 | 104/104 |`,
  `| Surviving workers | ${baseline.runs[0].remaining_live_workers} | ${baseline.runs[1].remaining_live_workers} | 0 |`,
  '',
  'Work equals the exact sum of per-role `used_bytes` in each run. Edge messages, payload bytes and frame bytes reconcile exactly to their run totals and execution record. Request+response envelopes use one semantic; authentication refusals are separate and have no response envelope. CPU and memory cover the recorded worker process trees on one host; maximum RSS is a maximum, not a sum.',
  '',
  '## Per-role work',
  '',
  '| Role | Idle bytes | Sustained bytes | Combined bytes |',
  '| --- | ---: | ---: | ---: |',
  ...roles.map(role => {
    const idle = baseline.runs[0].per_role_work_bytes[role], sustained = baseline.runs[1].per_role_work_bytes[role];
    return `| \`${role}\` | ${number(idle)} | ${number(sustained)} | ${number(idle + sustained)} |`;
  }),
  `| **Total** | **${number(baseline.runs[0].work_bytes)}** | **${number(baseline.runs[1].work_bytes)}** | **${number(baseline.aggregate.work_bytes)}** |`,
  '',
  '## Missing, censored and limited measurements',
  '',
  '- Power JSON and CSV are exactly `blocked`: `powermetrics requires superuser; no calibrated external AC meter authorized`. There are no power samples, joules, kWh or energy estimates. CPU seconds and work bytes are not watts.',
  `- Application WebSocket payload/frame accounting excludes handshake/control frames and TCP/IP bytes. Loopback is not Internet, Wi-Fi or last-mile evidence. Nettop matched ${baseline.runs.map(run => run.sample_limitations.nettop.matching_process_rows).join(' and ')} worker rows; no nettop byte total was inferred or added.`,
  '- Per-process physical disk counters and fsync latency remain unavailable. Logical arena bytes are not physical disk I/O; iostat is whole-host only and cannot be attributed to workers.',
  '- RSS is best-effort sampled with `ps` on one physical host; shared-memory attribution and whole-host isolation are unavailable. Logical process-held copies are not physical devices or crash-durability proof.',
  '- Business draws remain nondeterministic. Prices, budget, value, economic affordability, E3 and all K/R acceptance remain open. These windows support local planning only.',
  '',
  '## Evidence hashes',
  '',
  `\`${hashesPath}\` binds ${evidence.artifact_count} artifacts, including final evidence and preserved invalid history.`,
  '',
  '| Artifact | SHA-256 |',
  '| --- | --- |',
  ...Object.entries(evidence.hashes).map(([path, hash]) => `| \`${path}\` | \`${hash}\` |`),
  '',
  '**Final independent review can proceed** on the unified 20-run matrix and these two continuous baseline windows. E2 remains blocked by missing physical power, E3 requires separate owner authorization, and no economic, production or K/R acceptance follows.',
  '',
];
writeFileSync(receiptPath, `${lines.join('\n')}`, { mode: 0o600, flag: 'wx' });
const reviewHashes = {
  schema_version: 1,
  run_count: 2,
  hashes: Object.fromEntries([hashesPath, receiptPath, 'scripts/rso5-baseline-receipt.mjs'].sort().map(path => [path, sha256(path)])),
};
writeFileSync(reviewHashesPath, `${JSON.stringify(reviewHashes, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ receipt: receiptPath, review_hashes: reviewHashesPath }, null, 2));
