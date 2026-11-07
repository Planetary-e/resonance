import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifestPath = 'delivery/results/econ-power-lab-manifest.json';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const powerPaths = runId => ({ json: `delivery/results/econ-power-${runId}.json`, csv: `delivery/results/econ-power-${runId}.csv` });
const artifactPaths = runId => ({
  process: `delivery/results/econ-process-${runId}.json`, disk: `delivery/results/econ-disk-${runId}.json`,
  network: `delivery/results/econ-network-${runId}.json`, work: `delivery/results/econ-work-${runId}.json`,
});

function freezeManifest() {
  if (existsSync(manifestPath)) throw new Error(`Frozen manifest already exists: ${manifestPath}`);
  const base = json('delivery/results/econ-dec11-baseline-manifest.json');
  const extras = ['scripts/rso5-power-lab.mjs', 'packages/relay/src/__tests__/sustainable-rso5-power-lab.integration.test.ts'];
  const scenarios = [...base.runs].sort((a, b) => a.order_index - b.order_index).map((run, index) => {
    const makeIdle = (prefix, seed) => ({ run_id: `${prefix}-${run.run_id}`, seed, kind: 'idle',
      window: { runId: `${prefix}-${run.run_id}`, seed, kind: 'idle', durationMs: 60000, warmupMs: 0, cooldownMs: 0 } });
    return {
      order_index: run.order_index,
      pre_idle: makeIdle('power-pre', `0xE007C${(index * 2).toString(16).padStart(3, '0')}`),
      run: { run_id: `power-${run.run_id}`, scenario: run.scenario, seed: run.seed, repetition: run.repetition },
      post_idle: makeIdle('power-post', `0xE007C${(index * 2 + 1).toString(16).padStart(3, '0')}`),
    };
  });
  const manifest = {
    ...base,
    authorization_id: 'DEC-013',
    created_at: new Date().toISOString(),
    source_hashes: Object.fromEntries([...new Set([...Object.keys(base.source_hashes), ...extras])].map(path => [path, sha256(path)])),
    execution_scope: {
      ...base.execution_scope,
      full_runs_status: 'pending',
      smoke_status: 'separate_short_authorized_parser_smoke_only_not_a_scenario',
      matrix_status: 'pending_owner_full_invocation',
      baseline_windows_status: 'pending_owner_full_invocation',
      acceptance_evaluation: 'not_run',
      no_production_or_economic_acceptance: true,
    },
    power_instrument: {
      command: 'powermetrics --samplers cpu_power,gpu_power,ane_power -i 1000',
      interval_ms: 1000, units: 'mW', component_scope: 'CPU+GPU+ANE combined only; not whole-system energy',
      integration: 'trapezoidal combined mW over actual timestamps; missing/censored intervals excluded and explicit',
      matched_idle: 'incremental energy only when all matched idle windows are valid; otherwise null',
      sanitization: 'raw sampler logs excluded; only timestamps, units and power values retained',
    },
    power_scenarios: scenarios,
    baseline_windows: [
      { run_id: 'power-idle-baseline', seed: '0xE007B001', kind: 'idle',
        window: { runId: 'power-idle-baseline', seed: '0xE007B001', kind: 'idle', durationMs: 1800000, warmupMs: 60000, cooldownMs: 60000 } },
      { run_id: 'power-sustained-max-envelope', seed: '0xE007B002', kind: 'sustained',
        window: { runId: 'power-sustained-max-envelope', seed: '0xE007B002', kind: 'sustained', durationMs: 1800000, warmupMs: 60000, cooldownMs: 60000 } },
    ],
    analysis_freeze: {
      ...base.analysis_freeze,
      run_count: 62,
      scenario_run_count: 20,
      baseline_window_count: 2,
      paired_idle_window_count: 40,
      analysis: 'Existing scenario order/seeds unchanged; 1-second component power; absolute energy per run; pre/post idle subtraction only when valid; failure energy retained; no result-driven changes',
    },
  };
  writeJson(manifestPath, manifest);
  console.log(`Wrote ${manifestPath}: 20 scenarios + 2 baselines + 40 paired idle windows pending; smoke separate`);
}

function sampleTimestamp(value) {
  const match = value.trim().replace(/[()]/g, '').replace(/\s+/g, ' ').match(/^(\w+) (\w+) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) ([+-])(\d{2})(\d{2})$/);
  if (!match) return Number.NaN;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[match[2]];
  if (month === undefined) return Number.NaN;
  const offset = (Number(match[9]) * 60 + Number(match[10])) * (match[8] === '+' ? 1 : -1);
  return Date.UTC(Number(match[7]), month, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) - offset * 60000;
}

function parsePowerSamples(text) {
  const starts = [...text.matchAll(/\*\*\* Sampled system activity/g)].map(match => match.index);
  const samples = [];
  for (let index = 0; index < starts.length; index++) {
    const block = text.slice(starts[index], starts[index + 1] ?? text.length);
    const header = block.match(/\*\*\* Sampled system activity \((.*?) \(([\d.]+)ms elapsed\) \*\*\*/);
    if (!header) continue;
    const atMs = sampleTimestamp(header[1]);
    const metric = name => block.match(new RegExp(`^${name}: ([0-9.]+) mW$`, 'm'))?.[1];
    const cpu = metric('CPU Power'), gpu = metric('GPU Power'), ane = metric('ANE Power'), combined = metric('Combined Power \\(CPU \\+ GPU \\+ ANE\\)');
    samples.push({ at: new Date(atMs).toISOString(), atMs,
      cpu_mw: cpu === undefined ? null : Number(cpu), gpu_mw: gpu === undefined ? null : Number(gpu),
      ane_mw: ane === undefined ? null : Number(ane), combined_mw: combined === undefined ? null : Number(combined) });
  }
  return samples.filter(sample => Number.isFinite(sample.atMs));
}

function integratePower(samples, startAt, endAt) {
  const startMs = Date.parse(startAt), endMs = Date.parse(endAt), censored = [];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { energy_joules: null, energy_kwh: null, average_power_watts: null, peak_power_watts: null,
      duration_ms: Number.isFinite(endMs - startMs) ? endMs - startMs : null, censored: [{ reason: 'invalid window timestamps' }], validity: 'invalid' };
  }
  let energy = 0, validSeconds = 0, peak = 0;
  const bounded = samples.filter(sample => sample.atMs >= startMs && sample.atMs <= endMs);
  for (let index = 0; index + 1 < bounded.length; index++) {
    const left = bounded[index], right = bounded[index + 1], dt = (right.atMs - left.atMs) / 1000;
    if (dt <= 0) continue;
    if (dt > 1.5 || ![left.combined_mw, right.combined_mw].every(Number.isFinite)) {
      censored.push({ start: left.at, end: right.at, reason: dt > 1.5 ? 'sampling gap exceeds 1.5 seconds' : 'missing power value' });
      continue;
    }
    const watts = (left.combined_mw + right.combined_mw) / 2000;
    energy += watts * dt; validSeconds += dt; peak = Math.max(peak, left.combined_mw / 1000, right.combined_mw / 1000);
  }
  const expectedStart = startMs - 1000, expectedEnd = endMs + 1000;
  if (!bounded.length || bounded[0].atMs > expectedStart) censored.push({ start: new Date(startMs).toISOString(), reason: 'no initial sample within 1 second' });
  if (!bounded.length || bounded.at(-1).atMs < endMs - 1000) censored.push({ end: new Date(endMs).toISOString(), reason: 'no final sample within 1 second' });
  const durationSeconds = (endMs - startMs) / 1000;
  return {
    energy_joules: energy, energy_kwh: energy / 3600000,
    average_power_watts: validSeconds ? energy / validSeconds : null,
    peak_power_watts: bounded.length ? peak : null,
    duration_ms: endMs - startMs,
    censored,
    validity: censored.length ? 'partial' : 'valid',
    sample_count: bounded.length,
  };
}

function csvForRun(runId, samples, censored) {
  const lines = ['at,cpu_mw,gpu_mw,ane_mw,combined_mw,status'];
  for (const sample of samples.filter(sample => sample.atMs >= 0)) {
    lines.push(`${sample.at},${sample.cpu_mw ?? ''},${sample.gpu_mw ?? ''},${sample.ane_mw ?? ''},${sample.combined_mw ?? ''},sample`);
  }
  for (const marker of censored) lines.push(`${marker.start ?? marker.end ?? ''},,,,,${marker.reason}`);
  return `${lines.join('\n')}\n`;
}

function powerEvidence(run, samples) {
  const integrated = integratePower(samples, run.started_at, run.completed_at);
  return {
    schema_version: 1, authorization_id: 'DEC-013', run_id: run.run_id, scenario: run.scenario, kind: run.kind,
    status: integrated.validity,
    instrument: { command: 'powermetrics --samplers cpu_power,gpu_power,ane_power -i 1000', interval_ms: 1000,
      units: 'mW', scope: 'CPU+GPU+ANE combined only; not whole-system energy', raw_logs: 'excluded' },
    samples: samples.filter(sample => sample.atMs >= Date.parse(run.started_at) && sample.atMs <= Date.parse(run.completed_at))
      .map(sample => ({ at: sample.at, cpu_mw: sample.cpu_mw, gpu_mw: sample.gpu_mw, ane_mw: sample.ane_mw, combined_mw: sample.combined_mw })),
    censored_samples: integrated.censored,
    sample_count: integrated.sample_count,
    energy_joules: integrated.energy_joules, energy_kwh: integrated.energy_kwh,
    average_power_watts: integrated.average_power_watts, peak_power_watts: integrated.peak_power_watts,
    duration_ms: integrated.duration_ms,
    matched_idle: null,
    thermal_state: 'unavailable', battery_state: 'unavailable',
    artifacts: artifactPaths(run.run_id),
    acceptance_evaluation: 'not_run',
  };
}

function attachMatchedIdle(runEvidence, idleEvidence) {
  const valid = runEvidence.status === 'valid' && runEvidence.energy_joules !== null
    && idleEvidence.length > 0 && idleEvidence.every(run => run.status === 'valid' && run.energy_joules !== null && run.duration_ms > 0);
  if (!valid) {
    runEvidence.matched_idle = { run_ids: idleEvidence.map(run => run.run_id), valid: false,
      mean_power_watts: null, incremental_energy_joules: null, incremental_energy_kwh: null,
      reason: 'matched idle evidence missing or censored' };
    return;
  }
  const energy = idleEvidence.reduce((sum, run) => sum + run.energy_joules, 0);
  const duration = idleEvidence.reduce((sum, run) => sum + run.duration_ms, 0) / 1000;
  const mean = energy / duration, incremental = runEvidence.energy_joules - mean * (runEvidence.duration_ms / 1000);
  runEvidence.matched_idle = { run_ids: idleEvidence.map(run => run.run_id), valid: true,
    mean_power_watts: mean, incremental_energy_joules: incremental, incremental_energy_kwh: incremental / 3600000 };
}

function writeRunEvidence(runEvidence) {
  const paths = powerPaths(runEvidence.run_id);
  writeJson(paths.json, runEvidence);
  writeFileSync(paths.csv, csvForRun(runEvidence.run_id, runEvidence.samples, runEvidence.censored_samples), { mode: 0o600 });
  return paths;
}

async function samplerProcess(rawPath, durationMs = 0) {
  const child = spawn('powermetrics', ['--samplers', 'cpu_power,gpu_power,ane_power', '-i', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [], errors = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => errors.push(chunk));
  const processExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const completion = (async () => {
    const result = await processExit;
    const text = `${Buffer.concat(chunks)}`;
    writeFileSync(rawPath, text, { mode: 0o600 });
    if (result.code !== 0 && result.signal !== 'SIGTERM') throw new Error(`powermetrics failed: ${result.code ?? result.signal} ${Buffer.concat(errors).toString().slice(-512)}`);
    return result;
  })();
  if (durationMs) {
    await new Promise(resolve => setTimeout(resolve, durationMs));
    child.kill('SIGTERM');
    await completion;
  }
  return { child, exit: completion };
}

async function runSmoke() {
  const sampleArgument = process.argv.find(argument => argument.startsWith('--sample-file='));
  const samplePath = sampleArgument ? sampleArgument.slice('--sample-file='.length) : '';
  const temp = mkdtempSync(join(tmpdir(), 'rso5-power-smoke-'));
  const rawPath = join(temp, 'sampler.txt');
  if (samplePath) writeFileSync(rawPath, readFileSync(samplePath), { mode: 0o600 });
  else await samplerProcess(rawPath, 3000);
  const samples = parsePowerSamples(readFileSync(rawPath, 'utf8'));
  if (!samples.length) throw new Error('No powermetrics samples parsed');
  const arithmetic = integratePower([
    { at: '2026-01-01T00:00:00.000Z', atMs: Date.parse('2026-01-01T00:00:00.000Z'), combined_mw: 1000 },
    { at: '2026-01-01T00:00:01.000Z', atMs: Date.parse('2026-01-01T00:00:01.000Z'), combined_mw: 1000 },
  ], '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
  if (arithmetic.energy_joules !== 1) throw new Error(`Energy arithmetic failed: ${arithmetic.energy_joules}`);
  const smoke = {
    schema_version: 1, authorization_id: 'DEC-013', status: 'passed_parser_and_energy_arithmetic_smoke',
    full_scenario: false, sample_count: samples.length,
    samples: samples.map(sample => ({ at: sample.at, cpu_mw: sample.cpu_mw, gpu_mw: sample.gpu_mw, ane_mw: sample.ane_mw, combined_mw: sample.combined_mw })),
    units: 'mW', raw_sample_identity: samplePath || 'short live authorized sampler',
    arithmetic_check: { kind: 'synthetic_unit_test_not_physical_evidence', expected_joules: 1, actual_joules: arithmetic.energy_joules, pass: true },
    energy_joules: 0, energy_kwh: 0, note: 'One actual sample establishes parsing only; no interval energy and no full scenario was measured',
    acceptance_evaluation: 'not_run',
  };
  writeJson('delivery/results/econ-power-lab-smoke.json', smoke);
  writeFileSync('delivery/results/econ-power-lab-smoke.csv', csvForRun('smoke', samples, []), { mode: 0o600 });
  console.log(JSON.stringify(smoke, null, 2));
}

async function runFull() {
  const manifest = json(manifestPath);
  if (manifest.authorization_id !== 'DEC-013' || manifest.execution_scope.full_runs_status !== 'pending') throw new Error('DEC-013 frozen full-lab manifest invalid');
  const temp = mkdtempSync(join(tmpdir(), 'rso5-power-full-')), rawPath = join(temp, 'sampler.txt');
  const sampler = await samplerProcess(rawPath);
  let test;
  try {
    test = spawn('./node_modules/.bin/vitest', ['run', 'packages/relay/src/__tests__/sustainable-rso5-power-lab.integration.test.ts', '--maxWorkers=1'], { stdio: 'inherit' });
    sampler.child.once('exit', () => { if (test.exitCode === null) test.kill('SIGTERM'); });
    const testResult = await new Promise(resolve => test.once('exit', (code, signal) => resolve({ code, signal })));
    sampler.child.kill('SIGTERM');
    await sampler.exit;
    const execution = json('delivery/results/econ-power-lab-execution.json');
    const samples = parsePowerSamples(readFileSync(rawPath, 'utf8'));
    const evidence = new Map();
    for (const run of execution.completed) evidence.set(run.run_id, writeRunEvidence(powerEvidence(run, samples)));
    for (const run of manifest.power_scenarios) {
      const scenarioEvidence = json(powerPaths(run.run.run_id).json);
      attachMatchedIdle(scenarioEvidence, [json(powerPaths(run.pre_idle.run_id).json), json(powerPaths(run.post_idle.run_id).json)]);
      writeRunEvidence(scenarioEvidence);
    }
    const sustained = json(powerPaths('power-sustained-max-envelope').json);
    attachMatchedIdle(sustained, [json(powerPaths('power-idle-baseline').json)]);
    writeRunEvidence(sustained);
    const decision = {
      schema_version: 1, authorization_id: 'DEC-013',
      status: testResult.code === 0 ? 'power_evidence_complete_pending_independent_review' : 'power_evidence_partial',
      execution: 'delivery/results/econ-power-lab-execution.json',
      sampler: manifest.power_instrument,
      absolute_energy_joules: Object.fromEntries(execution.completed.map(run => [run.run_id, json(powerPaths(run.run_id).json).energy_joules])),
      failure_energy_joules: Object.fromEntries(execution.completed.filter(run => run.outcome !== 'passed').map(run => [run.run_id, json(powerPaths(run.run_id).json).energy_joules])),
      incremental_energy: Object.fromEntries(manifest.power_scenarios.map(run => [run.run.run_id, json(powerPaths(run.run.run_id).json).matched_idle])),
      sustained_incremental_energy: sustained.matched_idle,
      artifact_join: 'One continuous sampler partitioned by run timestamps; no per-run sampler energy is summed twice',
      E2: 'pending_independent_physical_evidence_review', E3: 'pending_separate_owner_authorization',
      economic_affordability: 'pending', production_approval: 'not_granted', acceptance_evaluation: 'not_run',
    };
    writeJson('delivery/results/econ-power-lab-decision.json', decision);
    const hashes = {};
    for (const run of execution.completed) {
      for (const path of [...Object.values(powerPaths(run.run_id)), ...Object.values(artifactPaths(run.run_id))]) hashes[path] = sha256(path);
    }
    for (const path of [manifestPath, 'delivery/results/econ-power-lab-execution.json', 'delivery/results/econ-power-lab-decision.json']) hashes[path] = sha256(path);
    writeJson('delivery/results/econ-power-lab-hashes.json', { schema_version: 1, authorization_id: 'DEC-013', hashes });
    console.log(JSON.stringify(decision, null, 2));
    if (testResult.code !== 0) process.exitCode = testResult.code ?? 1;
  } finally {
    if (test && test.exitCode === null) test.kill('SIGTERM');
    if (sampler.child.exitCode === null) sampler.child.kill('SIGTERM');
  }
}

if (process.argv.includes('--freeze')) await freezeManifest();
else if (process.argv.includes('--smoke')) await runSmoke();
else if (process.argv.includes('--full')) await runFull();
else {
  console.error('Usage: node scripts/rso5-power-lab.mjs --freeze | --smoke [--sample-file=path] | --full (owner uses sudo for full)');
  process.exitCode = 1;
}
