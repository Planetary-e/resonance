import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPublicationOutbox } from '../publication-outbox.js';
it.each(['held', 'sending'])('recovers a %s publication after the owning process is killed', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'outbox-crash-')); const key = randomBytes(32);
  const child = fork(new URL('./fixtures/publication-outbox-crash.ts', import.meta.url), [directory, key.toString('hex'), mode],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [id] = await once(child, 'message');
    child.kill('SIGKILL'); await exited;
    const recovered = openPublicationOutbox({ path: join(directory, 'outbox'), encryptionKey: key });
    try { expect(recovered.list()).toMatchObject([{ id, state: mode === 'held' ? 'held' : 'outcome-unknown', mayHaveBeenSent: mode === 'sending' }]); }
    finally { recovered.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  }
});
