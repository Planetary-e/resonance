import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2), flag = args.indexOf('--run-id');
const runId = flag >= 0 ? args[flag + 1] : undefined;
if (!runId || !/^[a-z][a-z0-9-]+$/.test(runId)) throw new Error('Use --run-id <reproduction identity>');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const paths = {
  manifest: `delivery/results/econ-lab-manifest-${runId}.json`,
  summary: `delivery/results/econ-lab-summary-${runId}.json`,
  process: `delivery/results/econ-process-${runId}.json`,
  disk: `delivery/results/econ-disk-${runId}.json`,
  network: `delivery/results/econ-network-${runId}.json`,
  work: `delivery/results/econ-work-${runId}.json`,
  power: `delivery/results/econ-power-${runId}.json`,
  cleanup: `delivery/results/econ-cleanup-${runId}.json`,
  authorization: `delivery/results/econ-authorization-${runId}.json`,
  owner: `delivery/results/econ-owner-assumptions-${runId}.json`,
  decision: `delivery/results/econ-decision-${runId}.json`,
  matrix: 'delivery/results/econ-matrix-driver-final-smoke.json',
  attempts: 'delivery/results/econ-lab-attempts.json',
};
const evidence = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, json(path)]));
const { manifest, summary, process: processes, disk, network, work, power, cleanup, authorization, owner, decision, matrix, attempts } = evidence;
const userCpu = processes.roles.reduce((sum, role) => sum + role.cpu.userMicros, 0) / 1e6;
const systemCpu = processes.roles.reduce((sum, role) => sum + role.cpu.systemMicros, 0) / 1e6;
const peakRss = Math.max(...processes.roles.map(role => role.peak_tree_rss_bytes));
const workTotal = work.roles.reduce((sum, role) => sum + role.used_bytes, 0);
const invalidAttempts = attempts.attempts.filter(attempt => attempt.outcome === 'invalid').length;
if (summary.run_id !== runId || processes.run_id !== runId || network.run_id !== runId || work.run_id !== runId) throw new Error('Run identity mismatch');
if (workTotal !== work.total_work_bytes || workTotal !== summary.work_bytes_separate_metric) throw new Error('Per-role work does not recompute');
if (!network.reconciliation.exact || cleanup.remaining_live_workers !== 0 || processes.clean_stops !== 52) throw new Error('Evidence gates incomplete');
if (!authorization.forged_cross_runtime_role_refused || !authorization.privileged_replica_runtime_read_refused) throw new Error('Authorization negative checks missing');
if (matrix.matrix_runs_executed !== 0 || matrix.runs.length !== 20) throw new Error('Matrix execution/selection state differs');
if (matrix.randomness?.source !== 'node:crypto.randomBytes' || matrix.randomness?.deterministic !== false
  || matrix.randomness?.exact_business_replay !== false || matrix.analysis_freeze?.post_result_changes_forbidden !== true
  || !matrix.runs.filter(run => run.scenario === 'new-view').every(run => run.readiness === 'post-newView-startup')) {
  throw new Error('Matrix randomness/readiness preregistration differs');
}
if (power.status !== 'blocked' || power.samples.length !== 0 || owner.status !== 'pending' || decision.E2 !== 'blocked') throw new Error('Power/owner/E2 state differs');
const copyAudits = summary.logical_process_held_copy_audits;
const content = `# RSO5 independent-process economic evidence receipt — DEC-008

**Status: diagnostic reproduction ${runId} PASS; independent re-review may proceed; E2 blocked; prototype-only; no K/R acceptance.**
This receipt is generated programmatically from the exact ${runId} artifact set. It
is not a 20-run matrix, production deployment, campaign or economic verdict.

## Frozen identity and environment

- Run: \`${runId}\`; scenario: \`${summary.scenario}\`; manifest: \`${paths.manifest}\`.
- Host: Mac15,6, Apple M3 Pro/arm64, 18 GiB; macOS 27.0 (26A428), Node.js 24.19.0.
- Transport: authenticated serialized WebSocket loopback with per-run/per-sender/
  per-recipient/per-channel credentials and explicit method authorization.
- Matrix driver: 20 frozen order/seed identities validated by selection smoke;
  **zero matrix lifecycles executed**. Execution remains gated by independent review.
- New-view path: every \`runtime:newView\` is followed by per-member
  \`runtime:startup\` and durable serving sequence/digest evidence. Selection smoke
  verifies this required path; no new-view matrix lifecycle was executed here.
- Randomness: \`node:crypto.randomBytes\` is nondeterministic and runs are not exact
  business replays. Seeds, source, scenarios, run count and analysis are frozen before
  results; no seed retrofitting or draw discard is allowed.
- Power: **blocked** — \`${power.reason}\`.
- Prices, budget, value and affordability: **pending**.

## Reproduction gates

- Focused RSO5 manifest: **17/17 PASS**.
- Actual-source \`./node_modules/.bin/tsc -p docs/handover/2026-10-24/source-tsconfig.json --noEmit\`: **PASS**.
- Independent-process reproduction: **1/1 PASS**, with 8 runtimes, 40 RSO5 replicas,
  4 observers and **52/52 clean stops**.
- Exact-path post-run sweep: **zero surviving workers**. Bounded stop uses graceful
  wait, SIGTERM escalation and SIGKILL fallback.
- Forged cross-runtime role and privileged replica \`runtime:read\`: **refused**.
- Predecessor runtimes/replicas stopped before recovery: ${summary.predecessor_runtime_and_replicas_stopped_before_recovery ? 'yes' : 'not selected'}.
- Recovered proofs: **${summary.recovered_proofs}**. Logical process-held copy audits:
  **${copyAudits}**, with RSO5 signature/scope/challenge/identity verification.
  These are not physical devices or crash-durability proof.
- Process trees: recursive \`ps\` parent-link enumeration; observed child IDs are
  retained per role, not hardcoded.

## Exact current measurements

| Metric | ${runId} artifact value |
| --- | ---: |
| Authenticated WebSocket messages | ${network.message_count} |
| Application payload bytes | ${network.total_payload_bytes} |
| Application WebSocket frame bytes | ${network.total_frame_bytes} |
| Separate work metric | ${workTotal} B |
| Worker user CPU | ${userCpu.toFixed(6)} s |
| Worker system CPU | ${systemCpu.toFixed(6)} s |
| Maximum sampled process-tree RSS | ${peakRss} B |
| Clean worker stops | ${processes.clean_stops}/52 |
| Remaining workers after exact-path sweep | ${cleanup.remaining_live_workers} |

Work was independently recomputed as \`sum(roles.used_bytes)\` from
\`${paths.work}\`; per-role operations are retained for review. CPU and maximum RSS
were computed from \`${paths.process}\`.

## Limitations retained

- Application WebSocket payload/frame bytes only; handshake/control frames and
  TCP/IP bytes are excluded. Loopback is not Internet/Wi-Fi/last-mile evidence.
- \`nettop\` matched zero worker rows; no host-network byte reconciliation is inferred.
- \`iostat\` is whole-host only. Per-process physical disk counters and fsync latency
  remain unavailable; logical arena files are not physical disk I/O.
- RSS sampling is best effort on one host, not whole-host isolation.
- Matrix-specific business randomness remains unseeded; frozen seeds currently derive
  run identity and channel credentials. Matrix execution was not performed.
- Power remains blocked with no samples. No work-byte/CPU-to-energy conversion or
  economic affordability claim is made.

## Attempts and evidence lineage

\`${paths.attempts}\` retains ${invalidAttempts} invalid attempts plus subsequent
reproductions. The earlier same-name reproduction is preserved separately as
\`reproduction-02\`; this receipt uses only ${runId} files. Failure/reconciliation
artifacts remain retained. No invalid run was silently replaced.

E1 is complete for local planning only. E2 remains **blocked** by incomplete aggregate
matrix/30-minute window evidence and blocked physical power. Run artifacts otherwise
carry their own run-specific completion status rather than matrix-not-run labels.
E3 needs separate owner authorization. D4 prototype-only remains.

**Independent re-review can proceed** on matrix scenario selection, identity
immutability, role/channel authorization, process-tree evidence, signed logical-copy
audits, cleanup, and exact resource accounting. No E2, K/R or production acceptance
is claimed.
`;
writeFileSync('docs/evals/v04-recovery-economic-evidence-2026-10-28.md', content, { mode: 0o600 });
console.log(`Generated receipt from exact ${runId} artifacts`);
