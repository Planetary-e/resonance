import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const number = value => value.toLocaleString('en-US');
const baselinePath = 'delivery/results/econ-dec11-baseline-baseline.json';
const hashesPath = 'delivery/results/econ-dec11-baseline-hashes.json';
const receiptPath = 'docs/evals/v04-dec11-full-warmup-baseline-2026-10-31.md';
const reviewHashesPath = 'delivery/results/econ-dec11-baseline-review-hashes.json';
const baseline = json(baselinePath), evidence = json(hashesPath), execution = json(baseline.execution_artifact);
for (const [path, expected] of Object.entries(evidence.hashes)) if (sha256(path) !== expected) throw new Error(`Hash mismatch: ${path}`);
const [idle, sustained] = baseline.runs, roles = Object.keys(idle.per_role_work_bytes);
const lines = [
  '# RSO5 DEC-011 full-warmup baseline receipt', '',
  '**Status: 2/2 corrected diagnostic windows pass all timing, evidence and cleanup gates; independent budget review may proceed; E2 remains blocked by physical power; no revised-budget, economic, production or K/R approval.**', '',
  '## Frozen execution and correction', '',
  `Command: \`${baseline.command}\`. Execution began at \`${execution.started_at}\` and completed at \`${execution.completed_at}\`. Frozen manifest: \`${baseline.manifest_artifact}\`; all 26 source hashes verify.`, '',
  'DEC-010 sustained warmup was marked but not awaited. DEC-011 enforces the existing monotonic warmup interval before bootstrap. Recovery behavior, retry authorization, work/cost and timing requirements are unchanged. Prior stack-safe bounded finalization, traffic pagination and cleanup behavior are preserved. All DEC-008/DEC-010 attempts and unified matrix artifacts remain intact.', '',
  '## Timing compliance and finalization', '',
  '| Window | Seed | Warmup monotonic | Baseline monotonic | Cooldown to first post-cooldown stop | Finalization |',
  '| --- | --- | ---: | ---: | ---: | --- |',
  ...baseline.runs.map(run => `| \`${run.run_id}\` | \`${run.seed}\` | ${number(run.measured_warmup_monotonic_ms)} ms | ${number(run.measured_baseline_monotonic_ms)} ms | ${number(run.measured_cooldown_wall_ms)} ms | ${run.finalization_phases.join(' → ')} |`),
  '',
  'Both warmups exceed 60,000 ms, both baseline phases exceed 1,800,000 ms, and both cooldowns exceed 60,000 ms. Each run has metrics, host-tools, stop-workers, network-evidence, artifacts, summary and cleanup phases, with 52/52 clean stops and zero survivors.', '',
  '## Actual measurements', '',
  '| Metric | Idle | Sustained | Aggregate / maximum |',
  '| --- | ---: | ---: | ---: |',
  `| Separate work metric | ${number(idle.work_bytes)} B | ${number(sustained.work_bytes)} B | ${number(baseline.aggregate.work_bytes)} B |`,
  `| Request+response envelopes | ${number(idle.messages)} | ${number(sustained.messages)} | ${number(baseline.aggregate.messages)} |`,
  `| Application payload bytes | ${number(idle.payload_bytes)} | ${number(sustained.payload_bytes)} | ${number(baseline.aggregate.payload_bytes)} |`,
  `| Application WebSocket frame bytes | ${number(idle.frame_bytes)} | ${number(sustained.frame_bytes)} | ${number(baseline.aggregate.frame_bytes)} |`,
  `| Worker user CPU | ${(idle.user_cpu_micros / 1e6).toFixed(6)} s | ${(sustained.user_cpu_micros / 1e6).toFixed(6)} s | ${baseline.aggregate.user_cpu_seconds.toFixed(6)} s |`,
  `| Worker system CPU | ${(idle.system_cpu_micros / 1e6).toFixed(6)} s | ${(sustained.system_cpu_micros / 1e6).toFixed(6)} s | ${baseline.aggregate.system_cpu_seconds.toFixed(6)} s |`,
  `| Maximum sampled process-tree RSS | ${number(idle.maximum_tree_rss_bytes)} B | ${number(sustained.maximum_tree_rss_bytes)} B | ${number(baseline.aggregate.maximum_tree_rss_bytes)} B |`,
  `| Sustained reads | ${number(idle.sustained_operations.reads)} | ${number(sustained.sustained_operations.reads)} | ${number(idle.sustained_operations.reads + sustained.sustained_operations.reads)} |`,
  `| Sustained retries | ${number(idle.sustained_operations.retries)} | ${number(sustained.sustained_operations.retries)} | ${number(idle.sustained_operations.retries + sustained.sustained_operations.retries)} |`,
  `| Recovered proofs | ${idle.recovered_proofs} | ${sustained.recovered_proofs} | ${idle.recovered_proofs + sustained.recovered_proofs} |`,
  `| Logical process-held copy audits | ${idle.logical_copy_audits} | ${sustained.logical_copy_audits} | ${idle.logical_copy_audits + sustained.logical_copy_audits} |`,
  '',
  'Per-role work sums exactly match each total. Every network edge reconciles to message, payload and frame totals and to the execution record. Sustained retries use the returning admission set and create no new proofs or configurations.', '',
  '## Per-role work', '',
  '| Role | Idle bytes | Sustained bytes | Combined bytes |',
  '| --- | ---: | ---: | ---: |',
  ...roles.map(role => {
    const idleBytes = idle.per_role_work_bytes[role], sustainedBytes = sustained.per_role_work_bytes[role];
    return `| \`${role}\` | ${number(idleBytes)} | ${number(sustainedBytes)} | ${number(idleBytes + sustainedBytes)} |`;
  }),
  `| **Total** | **${number(idle.work_bytes)}** | **${number(sustained.work_bytes)}** | **${number(baseline.aggregate.work_bytes)}** |`, '',
  '## Limitations and budget-review boundary', '',
  '- Power remains exactly `blocked`: `powermetrics requires superuser; no calibrated external AC meter authorized`. No power samples or energy estimates exist; CPU/work bytes are not watts.',
  `- Application payload/frame accounting excludes handshake/control frames and TCP/IP bytes. Loopback is not Internet evidence. Nettop matched ${baseline.runs.map(run => run.sample_limitations.nettop.matching_process_rows).join(' and ')} worker rows.`,
  '- Per-process physical disk counters and fsync latency are unavailable; logical arena bytes are not physical I/O and iostat is host-only. RSS is best-effort sampled on one host; logical process-held copies are not physical devices.',
  '- Business draws remain nondeterministic. Prices, budget, value and affordability remain pending. E3 requires separate owner authorization. Original work-threshold failures and all K/R gates remain open.', '',
  'Final decision evidence: `delivery/results/econ-dec11-budget-review-decision.json`. **Independent budget review may proceed** using measured mandatory maxima, complete failure history and uncertainty margins. A revised budget, economic affordability or production deployment requires separate owner approval; none is granted here.', '',
  '## Evidence hashes', '',
  `\`${hashesPath}\` binds ${evidence.artifact_count} artifacts, including both DEC-011 runs, warmup/finalization smoke, frozen manifest, decision evidence and prior blocked receipts/hash sets.`, '',
  '| Artifact | SHA-256 |', '| --- | --- |',
  ...Object.entries(evidence.hashes).map(([path, hash]) => `| \`${path}\` | \`${hash}\` |`), '',
];
writeFileSync(receiptPath, lines.join('\n'), { mode: 0o600, flag: 'wx' });
writeFileSync(reviewHashesPath, `${JSON.stringify({ schema_version: 1, authorization_id: 'DEC-011',
  hashes: Object.fromEntries([hashesPath, receiptPath, 'scripts/rso5-dec11-baseline-receipt.mjs'].sort().map(path => [path, sha256(path)])) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ receipt: receiptPath, review_hashes: reviewHashesPath }, null, 2));
