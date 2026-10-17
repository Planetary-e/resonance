import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function run(mode: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('./fixtures/tls/test-ca.crt', import.meta.url)) };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  const child = fork(new URL('./fixtures/tls-paths.mjs', import.meta.url), [mode], { env,
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('TLS fixture exited before its result'); })]);
    expect(message.error, message.stack).toBeUndefined(); await exited; expect(child.exitCode).toBe(0); return message.result;
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
}

it('enforces TLS trust, hostname and certificate dates on eleven production transport paths', async () => {
  const rows = await run('matrix'); expect(rows).toHaveLength(110);
  for (const row of rows) {
    expect(row.error, `${row.host}/${row.certificate}/${row.path}`).toBeTypeOf('string'); // The probe closes after the first application frame.
    expect(row.upgrades, `${row.host}/${row.certificate}/${row.path}`).toBe(row.certificate === 'localhost' ? 1 : 0);
    expect(row.frames, `${row.host}/${row.certificate}/${row.path}`).toBe(row.certificate === 'localhost' ? 1 : 0);
  }
}, 30000);

it('completes private publish/search/mailbox entirely over WSS and preserves work after certificate/key renewal and restart', async () => {
  const result = await run('route');
  expect(result.ack).toBe('ok'); expect(result.before).toEqual([result.publicationId]); expect(result.after).toEqual([result.publicationId]);
  expect(result.matched).toBe('ok'); expect(result.envelopes).toHaveLength(1); expect(result.notices).toHaveLength(1);
  expect(result.retainedEnvelopes).toEqual(result.envelopes); expect(result.retainedNotices).toEqual(result.notices);
  expect(result.acknowledged).toBe('ok'); expect(result.remaining).toBe(0); expect(result.sameRelayIdentity).toBe(true);
}, 30000);

it.each(['proxy-valid', 'proxy-invalid'])('revalidates the certificate between destination discovery and forwarding through %s', async mode => {
  const result = await run(mode);
  expect(result.upgrades).toBe(mode === 'proxy-valid' ? 2 : 1);
  expect(result.stored).toBe(mode === 'proxy-valid' ? 1 : 0);
  expect(result.ack).toBe(mode === 'proxy-valid' ? 'ok' : null);
  if (mode === 'proxy-valid') expect(result.error).toBeNull(); else expect(result.error).toBeTypeOf('string');
}, 30000);
