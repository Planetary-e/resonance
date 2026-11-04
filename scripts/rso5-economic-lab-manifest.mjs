import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAfter = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const activeRunId = valueAfter('--run-id');
const activeSeed = valueAfter('--seed');
const activeScenario = valueAfter('--scenario') ?? 'full-smoke';
if (activeRunId && (!activeSeed || !/^[a-z][a-z0-9-]+$/.test(activeRunId))) throw new Error('Run identity/seed required');
const outputPath = activeRunId ? `delivery/results/econ-lab-manifest-${activeRunId}.json` : 'delivery/results/econ-lab-manifest.json';
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const sourcePaths = [
  'docs/handover/2026-10-24/source-tsconfig.json',
  'packages/relay/src/sustainable-rso5-lab-transport.ts',
  'packages/relay/src/sustainable-rso5-lab-worker.ts',
  'packages/relay/src/sustainable-rso5-lab.ts',
  'packages/relay/src/__tests__/sustainable-rso5-independent-lab.integration.test.ts',
  'packages/relay/src/__tests__/sustainable-rso5-matrix-driver.integration.test.ts',
  'packages/relay/src/__tests__/sustainable-rso5-matrix-execution.integration.test.ts',
  'packages/relay/src/__tests__/sustainable-rso5-lab-evidence.test.ts',
  'packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts',
  'packages/relay/src/__tests__/sustainable-recovery-fixture.ts',
  'packages/relay/src/sustainable-rso5-arena.ts',
  'packages/relay/src/sustainable-rso5-codec.ts',
  'packages/relay/src/sustainable-rso5-manifest.ts',
  'packages/relay/src/sustainable-rso5-opaque.ts',
  'packages/relay/src/sustainable-rso5-protected-arena.ts',
  'packages/relay/src/sustainable-rso5-runtime.ts',
  'packages/relay/src/sustainable-recovery-work.ts',
  'scripts/rso5-finalize-evidence.mjs',
  'scripts/rso5-independent-lab-smoke.mjs',
  'scripts/rso5-economic-lab-manifest.mjs',
  'scripts/rso5-economic-matrix-driver.mjs',
  'scripts/rso5-economic-receipt.mjs',
  'scripts/rso5-matrix-evidence.mjs',
];
const definitions = [
  ['cold', 'cold', '0xE0070000'],
  ['returning', 'return', '0xE0070100'],
  ['local-loss', 'local', '0xE0070200'],
  ['new-view', 'new-view', '0xE0070300'],
];
const orderSeed = '0xE0072026';
const runs = definitions.flatMap(([scenario, prefix, base]) => Array.from({ length: 5 }, (_, index) => ({
  run_id: `${prefix}-${String(index + 1).padStart(2, '0')}`,
  scenario,
  repetition: index + 1,
  seed: `0x${(BigInt(base) + BigInt(index + 1)).toString(16).toUpperCase().padStart(8, '0')}`,
})));
const ordered = runs.map(run => ({ ...run, order_digest: sha256(`${orderSeed}:${run.run_id}`) }))
  .sort((a, b) => a.order_digest.localeCompare(b.order_digest))
  .map((run, index) => ({ ...run, order_index: index }));
const roleProcessMap = [
  ...Array.from({ length: 4 }, (_, index) => ({ role: `observer-${index}`, kind: 'policy-observer', process: 'independent-node-worker', internal_history_replicas: 5 })),
  ...['old', 'new'].flatMap(side => Array.from({ length: 4 }, (_, index) => [
    { role: `runtime-${side}-${index}`, kind: 'rso5-runtime', process: 'independent-node-worker', arena: 'per-process', keys: 'role-local' },
    ...Array.from({ length: 5 }, (_, copy) => ({ role: `replica-${side}-${index}-${copy + 1}`, kind: 'rso5-replica', process: 'independent-node-worker', arena: 'per-process', keys: 'role-local' })),
  ])).flat(),
];
const hostDescription = 'Mac15,6|Apple M3 Pro|arm64|19327352832';
const manifest = {
  schema_version: 1,
  authorization_id: 'DEC-008',
  created_at: new Date().toISOString(),
  execution_scope: {
    matrix_driver: 'implemented_selection_smoke_only',
    matrix_status: 'not_executed',
    matrix_execution_guard: 'independentReviewApproved required',
    active_run_id: activeRunId ?? null,
    active_scenario: activeRunId ? activeScenario : null,
    active_seed: activeRunId ? activeSeed : null,
    sustained_windows_status: 'not_executed',
    stopped_campaign: false,
    acceptance_evaluation: 'not_run',
  },
  host: {
    sanitized_id: sha256(`rso5-economic-lab-v1\n${hostDescription}`),
    model: 'Mac15,6',
    chip: 'Apple M3 Pro',
    architecture: 'arm64',
    memory_bytes: 19327352832,
    os: 'macOS 27.0',
    os_build: '26A428',
    node: process.version,
    isolation: 'single-host independent Node processes; no whole-host isolation claim',
  },
  source_hashes: Object.fromEntries(sourcePaths.map(path => [path, sha256(readFileSync(path))])),
  order_seed: orderSeed,
  order_algorithm: 'sort by lowercase hex SHA256(order_seed + ":" + run_id), then assign zero-based order_index',
  runs: ordered,
  roles: roleProcessMap,
  role_count: roleProcessMap.length,
  transport: {
    protocol: 'WebSocket',
    scope: 'loopback',
    authentication: 'per-run/per-sender/per-recipient/per-channel HMAC-SHA256 plus explicit method authorization and existing RSO5/history signatures',
    serialization: 'JSON text frames with per-message identities; perMessageDeflate disabled',
    direct_function_transport: false,
    internet_evidence: false,
    byte_scope: 'application WebSocket payload/frame only; handshake/control/TCP/IP excluded',
  },
  seed_application: 'Run identity and per-channel credential derivation; legacy fixture randomBytes is not deterministic',
  randomness: {
    source: 'node:crypto.randomBytes',
    deterministic: false,
    exact_business_replay: false,
    values: 'All fixture keys, evidence values, identities, nonces and other draws are nondeterministic',
    seed_retrofit_forbidden: true,
    discard_draws_forbidden: true,
  },
  analysis_freeze: {
    frozen_before_results: ['source_hashes', 'seeds', 'scenarios', 'run_count', 'analysis'],
    run_count: 20,
    analysis: 'Frozen scenario order and lifecycle gates; retain every draw/invalid run; per-role work sum; application WebSocket payload/frame accounting; descriptive evidence only',
    post_result_changes_forbidden: true,
  },
  scenario_readiness: {
    'new-view': 'runtime:newView followed by runtime:startup for every member, with durable serving sequence/digest evidence',
  },
  artifact_identity: 'run-specific manifests and artifacts with exclusive-create semantics',
  instruments: {
    process_cpu_rss_lifecycle: 'worker process.cpuUsage/memoryUsage plus recursive unprivileged ps parent-link enumeration',
    process_disk: 'logical arena usage only; physical per-process counters unavailable in Node.js/macOS harness',
    network_application: 'actual serialized WebSocket payload/frame bytes per edge/direction/purpose with sent/received reconciliation',
    nettop: 'unprivileged nettop -P -n -x -L 1 reconciliation when supported; separate host view only',
    iostat: 'unprivileged iostat -d -c 1 when supported; whole-host only',
    power: {
      status: 'blocked',
      reason: 'powermetrics requires superuser; no calibrated external AC meter authorized',
      samples: [],
    },
  },
  sanitization: {
    host_serial_or_uuid: 'excluded',
    ip_addresses: 'excluded from artifacts',
    keys_and_plaintext: 'excluded from artifacts',
    roles: 'sanitized logical identifiers only',
    raw_worker_logs: 'not published',
  },
  gates: {
    E1: 'complete_for_local_planning_only',
    E2: 'blocked',
    E3: 'pending_separate_owner_authorization',
    D4: 'prototype-only',
    economic_affordability: 'pending',
  },
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: activeRunId ? 'wx' : 'w' });
console.log(`Wrote ${outputPath} with ${ordered.length} ordered runs and ${roleProcessMap.length} independent worker roles`);
