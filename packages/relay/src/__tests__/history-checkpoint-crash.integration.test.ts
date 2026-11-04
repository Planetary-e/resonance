import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyCheckpointEnvelopeId, openHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

it.each(['appended', 'frozen', 'before-index', 'after-index'])('reopens conservatively after SIGKILL at %s', async mode => {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-checkpoint-crash-'));
  const options = { ...f.options, directory };
  const initial = openHistoryCheckpointStore({ ...options, initialize: f.root }); initial.close();
  const raw = JSON.stringify({ options, localKey: f.localKey.toString('hex'), key: f.key.toString('hex'),
    owner: { publicKey: Buffer.from(f.owner.publicKey).toString('hex'), secretKey: Buffer.from(f.owner.secretKey).toString('hex') } });
  const child = fork(new URL('./fixtures/history-checkpoint-crash.ts', import.meta.url), [raw, mode],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [{ id }] = await once(child, 'message');
    if (mode === 'appended' || mode === 'frozen') {
      expect((await once(child, 'message'))[0]).toBe('stored');
      child.kill('SIGKILL');
    }
    await exited;
    const recovered = openHistoryCheckpointStore({ ...options, minimum: mode === 'before-index' ? undefined
      : { sequence: 1, id, generationBarrier: mode === 'frozen' ? 1 : 0 } });
    try {
      const state = recovered.read();
      expect(state.envelopes[0]).toEqual(f.root);
      expect(state.envelopes).toHaveLength(mode === 'before-index' ? 1 : 2);
      expect(readdirSync(directory).filter(name => name.endsWith('.block'))).toHaveLength(state.envelopes.length);
      if (mode !== 'before-index') {
        expect(historyCheckpointEnvelopeId(state.envelopes[1])).toBe(id);
        expect(openHistoryCheckpoint(state.envelopes[1], f.context, f.key).toString()).toBe('crash-preserved-spend');
      }
      if (mode === 'frozen') expect(() => recovered.append(f.next(state.envelopes[1]))).toThrow('frozen');
    } finally { recovered.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
