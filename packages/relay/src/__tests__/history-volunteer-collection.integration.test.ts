import { afterEach, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { historyVolunteerCollectionFixture } from './fixtures/history-volunteer-collection-fixture.js';
import { waitForPolicyLinks } from './fixtures/policy-observer-outbound-fixture.js';
import { HistoryRelayRouter } from '../history-relay-router.js';
import { createRelayServer } from '../server.js';
import { loadOrCreateRelayIdentity } from '../relay-identity-store.js';
import { openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { openPolicyObserverRecovery, preparePolicyObserverRecovery } from '../policy-observer-recovery.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function start(directory: string, collection: string, paused = false) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../main.ts', import.meta.url))], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment, RELAY_DATA_DIR: directory, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0',
      RELAY_HISTORY_VOLUNTEER_COLLECTION_FILE: collection, RELAY_ADMIN_API_KEY: 'collection-test',
      ...(paused ? { RELAY_NEW_WORK_BANDWIDTH_BYTES_PER_HOUR: '0' } : {}) } });
  const exited = once(child, 'exit'); let output = '', port = 0, closed = false;
  const read = (bytes: Buffer) => {
    output += bytes.toString();
    for (const line of output.split('\n')) { try { const event = JSON.parse(line); if (event.event === 'started') port = event.port; } catch { /* Partial diagnostic line. */ } }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  const close = async () => {
    if (closed) return; closed = true; if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000); try { await exited; } finally { clearTimeout(timer); }
  }; cleanup.push(close);
  return { close, exited, async listening() {
    await waitForPolicyLinks(() => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Collection runtime failed: ${output}`); return port > 0; });
    return port;
  }, async health() { return (await (await fetch(`http://127.0.0.1:${port}/stats?key=collection-test`)).json() as { history: unknown }).history; } };
}

it('runs five volunteer processes with five independent policy histories each through restart, resource pause and selected-history recovery', async () => {
  const n = await historyVolunteerCollectionFixture(close => cleanup.push(close), 5);
  const directories = n.keys.map((_, i) => join(n.directory, `runtime-${i}`));
  const ids = directories.map(directory => { const identity = loadOrCreateRelayIdentity(directory); try { return identity.did; } finally { identity.secretKey.fill(0); } });
  const members = n.keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${9 + i}/history-checkpoint` }));
  const router = new HistoryRelayRouter({ members: members.map((m, i) => ({ publicKey: m.publicKey, relayId: ids[i] })), serializeRequests: true }); cleanup.push(() => router.close());
  const controller = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(n.directory, 'controller'), historyLinks: router,
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  await controller.start(); cleanup.push(() => controller.stop({ graceful: false })); const descriptor = controller.getRelayDescriptor()!;
  for (let i = 0; i < 5; i++) writeFileSync(n.paths[i], JSON.stringify({ ...n.configs[i], controllers: [{ relayId: descriptor.relayId, endpoint: descriptor.endpoints[0] }] }));
  const launch = async (paused = false) => {
    const processes = directories.map((directory, i) => start(directory, n.paths[i], paused));
    await Promise.all(processes.map(process => process.listening()));
    await waitForPolicyLinks(() => controller.getRelayLinkStatus().inboundRelayIds.filter(id => ids.includes(id)).length === 5);
    return processes;
  };
  let volunteers = await launch();
  const options = n.roots.map((h, i) => ({ directory: join(n.directory, `owner-${i}`), encryptionKey: h.encryptionKey, signingKey: h.signingKey,
    // Five cold child processes open 25 durable histories. Maintenance has its
    // own bound; observe() below still uses the caller's three-second challenge.
    context: n.context, historyContext: h.context, root: h.root, members, transport: router.checkpoint, timeoutMs: 15000 }));
  const observers = [];
  for (const option of options) {
    const observer = await openProtectedPolicyObserver({ ...option, mode: 'create-new' }); cleanup.push(observer.close);
    await observer.ready(); observers.push(observer);
  }
  await observers[0].advance(n.advance);
  for (let i = 0; i < 5; i++) {
    const request = createAdmissionPolicyHeadRequest(n.context), vote = await observers[i].observe(request);
    expect(parseAdmissionPolicyHeadVote(vote, request, n.context, Date.now()).head.revision).toBe(i === 0 ? 2 : 1);
  }
  expect(await volunteers[0].health()).toMatchObject({ volunteer: { state: 'available', usage: { histories: 5, generations: 5, retainedBlocks: 6 } } });
  const ordinaryLimits = router.health();
  await Promise.all(volunteers.map(volunteer => volunteer.close()));
  await waitForPolicyLinks(() => !controller.getRelayLinkStatus().inboundRelayIds.some(id => ids.includes(id)));
  volunteers = await launch(true);
  await observers[0].ready(); // An exact retry remains available while new work is paused.
  await expect(observers[1].advance(n.advance)).rejects.toThrow('Four');
  expect(observers[1].status()).toMatchObject({ pending: true });
  await observers[2].ready();
  expect(await volunteers[0].health()).toMatchObject({ volunteer: { usage: { histories: 5, retainedBlocks: 6 } } });
  await Promise.all(volunteers.map(volunteer => volunteer.close()));
  await waitForPolicyLinks(() => !controller.getRelayLinkStatus().inboundRelayIds.some(id => ids.includes(id)));
  volunteers = await launch(); await observers[1].ready();
  expect(observers[1].policy()).toEqual(n.second); expect(observers[2].policy()).toEqual(n.first);

  const recoveryOptions = { directory: join(n.directory, 'recovery'), encryptionKey: n.roots[0].encryptionKey, signingKey: n.roots[0].signingKey,
    context: n.context, historyContext: n.roots[0].context, genesis: n.roots[0].root, members, transport: router.checkpoint,
    agreementTransport: router.agreement, dataTransport: router.transfer, provisionTransport: router.provision };
  const review = await preparePolicyObserverRecovery({ ...recoveryOptions, source: observers[0].reviewRecoverySource() });
  const recovery = await openPolicyObserverRecovery({ ...recoveryOptions, initialize: { review, approvedDigest: review.approvalDigest } }); cleanup.push(recovery.close);
  observers[0].close();
  for (let phase = 0; phase < 12 && !recovery.status().complete; phase++) await recovery.advance();
  expect(recovery.status().complete).toBe(true);
  const destination = join(n.directory, 'restored'), { preparation, continuation } = await recovery.reviewRestore(destination);
  const restored = await openProtectedPolicyObserver({ ...options[0], directory: destination, root: continuation, genesis: n.roots[0].root,
    mode: 'create-new', restore: { preparation, approvedDigest: preparation.review.approvalDigest } }); cleanup.push(restored.close);
  await restored.ready(); await restored.advance(n.later); expect(restored.policy()).toEqual(n.third);
  expect(observers[1].policy()).toEqual(n.second);
  for (const observer of observers.slice(2)) { await observer.ready(); expect(observer.policy()).toEqual(n.first); }
  expect(await volunteers[0].health()).toMatchObject({ volunteer: { usage: { histories: 5, generations: 6 } } });
  expect(router.health()).toMatchObject({ maximumOperations: ordinaryLimits.maximumOperations, maximumBufferBytes: ordinaryLimits.maximumBufferBytes });
}, 120000);
