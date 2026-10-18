/** Opt-in actual desktop API/embedding exercise. Isolated local profiles only.
 * No native installers, background services, model downloads or external relays. */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { env } from '@huggingface/transformers';

const { values } = parseArgs({ options: { child: { type: 'boolean' }, 'protected-policy': { type: 'boolean' }, 'protected-admission': { type: 'boolean' }, out: { type: 'string' } } });
env.allowRemoteModels = false;
const wire: string[] = []; let frameBytes = 0;
const originalSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (this: WebSocket, data, ...args: any[]) {
  const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
  frameBytes += Buffer.byteLength(text);
  if (frameBytes > 32 * 1024 * 1024 || wire.length >= 10000) throw new Error('Evaluation wire budget exceeded');
  wire.push(text);
  return Reflect.apply(originalSend, this, [data, ...args]);
} as typeof originalSend;

type Snapshot = { did: string; publications: Array<{ publicationId: string; publicationKey: string }>; wire: string[]; frameBytes: number; peakRssBytes: number; cpuSeconds: number };
if (values.child) {
  assert(process.send && process.env.RESONANCE_DATA_DIR && process.env.RESONANCE_EVAL_DESTINATION);
  const { createAppServer } = await import('../packages/app/src/server/server.js');
  const { getSession, lockSession } = await import('../packages/app/src/server/session.js');
  const app = createAppServer({ port: 0, relayUrl: process.env.RESONANCE_EVAL_DESTINATION });
  let stopped = false;
  async function stop() {
    if (stopped) return; stopped = true; lockSession(); await app.stop();
    WebSocket.prototype.send = originalSend; process.disconnect?.();
  }
  process.on('message', async message => {
    if (message === 'snapshot') {
      const session = getSession(); assert(session); const cpu = process.cpuUsage();
      process.send!({ kind: 'snapshot', did: session.identity.did,
        publications: session.store.listPublications().map(p => ({ publicationId: p.record.publicationId, publicationKey: p.record.publicationKey })),
        wire, frameBytes, peakRssBytes: process.resourceUsage().maxRSS * 1024, cpuSeconds: (cpu.user + cpu.system) / 1e6 } satisfies Snapshot & { kind: string });
    } else if (message === 'stop') await stop();
  });
  process.on('disconnect', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  process.send!({ kind: 'ready', port: await app.start() });
} else {
  const { publicVerif } = await import('@cloudflare/privacypass-ts');
  const { generateSigningKeyPair } = await import('@resonance/core');
  const { signAdmissionPolicy, admissionKeyFingerprint } = await import('@resonance/core/admission-policy');
  const { createRelayServer, createConfiguredAdmissionVerifier } = await import('@resonance/relay');
  const { openAdmissionIssuerLedger } = await import('@resonance/node');
  const { approveAdmissionIssuerBatch } = await import('../packages/node/src/admission-issuer-ledger.js');
  const { createRelayTestEndpoints } = await import('../packages/relay/src/__tests__/fixtures/relay-test-endpoint.js');
  const root = fileURLToPath(new URL('../', import.meta.url)), directory = mkdtempSync(join(tmpdir(), 'resonance-real-app-'));
  const processes: ChildProcess[] = [], cleanup: Array<() => void | Promise<void>> = [];
  const started = performance.now(), cpuStart = process.cpuUsage();
  let report: Record<string, unknown> | undefined;
  const checkpoints: string[] = [];
  const apiTimings: Array<{ operation: string; status: number; durationMs: number }> = [];
  let faultCooldownMs = 0;
  const passed = (message: string) => { checkpoints.push(message); console.error(`PASS ${message}`); };
  const waitMessage = (child: ChildProcess, kind: string, timeoutMs = 60000): Promise<any> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Child ${kind} deadline exceeded`)), timeoutMs);
    const receive = (value: any) => { if (value?.kind === kind) finish(undefined, value); };
    const exited = (code: number | null) => finish(new Error(`Application exited before ${kind}: ${code}`));
    const finish = (error?: Error, value?: any) => {
      clearTimeout(timer); child.off('message', receive); child.off('exit', exited); child.off('error', finish);
      if (error) reject(error); else resolve(value);
    };
    child.on('message', receive); child.once('exit', exited); child.once('error', finish);
  });
  try {
    const [entryAddress] = await createRelayTestEndpoints(1); cleanup.push(entryAddress.close);
    const [destinationAddress] = await createRelayTestEndpoints(1, '::1'); cleanup.push(destinationAddress.close);
    const entryUrl = `ws://127.0.0.1:${entryAddress.port}/`, destinationUrl = `ws://[::1]:${destinationAddress.port}/`;
    const scope = { issuer: 'real-app-local-evaluation', community: 'public', epoch: new Date().toISOString().slice(0, 7) };
    const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
    const der = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    const profile = { version: 1 as const, scope, issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`, relayUrls: [destinationUrl] };
    const authorityKeys = generateSigningKeyPair(), authority = Buffer.from(authorityKeys.publicKey).toString('base64url'), now = Date.now();
    const admission = values['protected-admission']
      ? await (await import('./fixtures/real-app-admission.js')).prepareRealAppAdmission(join(directory, 'admission'), cleanup) : undefined;
    const policy = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', revision: 1, issuedAt: now - 1000, expiresAt: now + 3600000,
      activeKey: admissionKeyFingerprint(profile.issuerPublicKey), keys: [{ profile, notBefore: now - 1000, issueUntil: now + 1800000, spendUntil: now + 2400000, retryUntil: now + 3000000,
        ...(admission ? { witnesses: admission.witnessSet } : {}) }] }, authority, authorityKeys.secretKey);
    const protectedPolicy = values['protected-policy'] || admission
      ? await (await import('./fixtures/real-app-policy-observers.js')).realAppPolicyObservers(join(directory, 'policy'), policy, cleanup) : undefined;
    const protectedAdmission = admission && await admission.activate(policy, protectedPolicy!.context);
    const verifier = protectedAdmission ? undefined : await createConfiguredAdmissionVerifier({ directory: join(directory, 'destination'), authority, policy, encryptionKey: randomBytes(32), initialize: true,
      policyObservers: protectedPolicy?.context });
    if (verifier) cleanup.push(async () => { verifier.close(); await verifier.drainPolicyObservations(); });
    const activeVerifier = () => protectedAdmission?.verifier ?? verifier!;
    let lastAccepted: { capability: Parameters<NonNullable<typeof verifier>['verifyAndSpend']>[0]; context: Parameters<NonNullable<typeof verifier>['verifyAndSpend']>[1] } | undefined;
    const spends: Array<{ action: string; binding: string; token: string; serialized: string; status: string }> = [];
    const discovery = (endpoint: string) => ({ endpoints: [endpoint], reachability: 'direct' as const, supportedGroups: ['public'], storage: { capacityBytes: 4000000, availableBytes: 3000000 }, maxKnownRelays: 8 });
    const entry = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(directory, 'entry'), relayDiscovery: discovery(entryUrl) });
    await entry.start(); cleanup.push(() => entry.stop()); entryAddress.forwardTo(entry.getListeningPort()!);
    const destination = createRelayServer({ port: 0, host: '::1', persistDir: join(directory, 'destination'), relayDiscovery: discovery(destinationUrl),
      policyQuery: protectedPolicy?.query,
      admissionVerifier: { async verifyAndSpend(capability, context) {
        const decision = await activeVerifier().verifyAndSpend(capability, context);
        if (decision.status === 'accepted') lastAccepted = structuredClone({ capability, context });
        spends.push({ action: context.action, binding: context.requestBinding, token: capability.token, serialized: JSON.stringify(capability), status: decision.status });
        return decision;
      } } });
    await destination.start(); cleanup.push(() => destination.stop()); destinationAddress.forwardTo(destination.getListeningPort()!);
    assert.equal(entry.observeRelayDescriptor(destination.getRelayDescriptor()!), 'accepted');
    const issuer = await openAdmissionIssuerLedger({ path: join(directory, 'issuer.json'), expectedProfile: profile, privateKey: keys.privateKey, create: { batchSize: 16, maxPermits: 2 } });
    cleanup.push(issuer.close); await issuer.installPolicy(policy, authority, { observers: protectedPolicy?.context });
    async function issuerProof() {
      if (!protectedPolicy) return undefined;
      const prepared = issuer.preparePolicyObservation();
      const { collectAdmissionPolicyObservation } = await import('../packages/relay/src/admission-policy-observation.js');
      return { version: 1 as const, type: 'admission_policy_query_reply' as const,
        certificate: await collectAdmissionPolicyObservation({ context: protectedPolicy.context, request: prepared.query.request }) };
    }
    async function startApp(name: string) {
      const child = fork(fileURLToPath(import.meta.url), ['--child'], { cwd: root, execArgv: ['--import', import.meta.resolve('tsx')],
        env: { ...process.env, RESONANCE_DATA_DIR: join(directory, name), RESONANCE_EVAL_DESTINATION: destinationUrl,
          RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS: `${entryUrl},${destinationUrl}` }, silent: true });
      processes.push(child); let diagnostic = '';
      child.stdout?.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
      child.stderr?.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
      let ready: { port: number }; try { ready = await waitMessage(child, 'ready'); } catch (error) { throw new Error(`${name}: ${error}; ${diagnostic}`); }
      let auth = ''; const base = `http://127.0.0.1:${ready.port}`, password = `evaluation-only-${name}-${randomBytes(16).toString('hex')}`;
      async function request(path: string, body?: unknown, expectedStatus = 200) {
        const began = performance.now();
        const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(90000),
          headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        apiTimings.push({ operation: path.replace(/\/reqhold_[^/]+\//, '/:id/'), status: response.status, durationMs: Math.round(performance.now() - began) });
        assert.equal(response.status, expectedStatus, `${name} ${path}: ${JSON.stringify(data)}`); return data;
      }
      await request('/api/init', { password }); auth = (await request('/api/unlock', { password })).token;
      await request('/api/admission-wallet/configure', profile);
      if (protectedPolicy) await request('/api/admission-wallet/policy', { policy, authority, observers: protectedPolicy.context });
      const pending = (await request('/api/admission-wallet/request', { count: 16 })).request;
      const permit = issuer.grant(await issuerProof()), response = await approveAdmissionIssuerBatch(issuer, permit, pending, issuerProof);
      assert.equal((await request('/api/admission-wallet/complete', response)).imported, 16);
      async function snapshot(): Promise<Snapshot> { const pending = waitMessage(child, 'snapshot'); child.send('snapshot'); return pending; }
      async function relock() { await request('/api/lock', {}); auth = (await request('/api/unlock', { password })).token; }
      return { request, snapshot, relock };
    }
    const alice = await startApp('alice'), bob = await startApp('bob');
    passed('Two actual app processes initialized and unlocked with the cached FP32 model; blinded issuance completed through authenticated APIs');
    const texts = ['Experienced Python developer specializing in Django and REST APIs, available for freelance work',
      'I offer patient gardening lessons for beginners', 'I need a freelance Python developer for a Django project'];
    const firstPrivateOperationAt = performance.now();
    for (const text of texts.slice(0, 2)) assert.equal((await alice.request('/api/items', { text, type: 'offer' })).status, 'published');
    assert.equal((await bob.request('/api/items', { text: texts[2], type: 'need' })).status, 'published');
    const a = await alice.snapshot(), b = await bob.snapshot(); assert.notEqual(a.did, b.did);
    assert.equal(new Set(a.publications.map(p => p.publicationKey)).size, 2);
    assert.equal(new Set(a.publications.map(p => p.publicationId)).size, 2);
    assert.equal(entry.getStats().stored_publications, 0); assert.equal(destination.getStats().stored_publications, 3);
    passed('Three real-text publications accepted; two offers from one account have separate publication keys and IDs');
    const search = await bob.request('/api/search', { text: texts[2], type: 'need' });
    assert(search.results.some((result: any) => result.publicationId === a.publications[0].publicationId), 'Expected Python offer not retrieved');
    passed('Real-text private search retrieves the complementary offer');
    const mailboxCounts: number[] = [];
    for (const [app, publication] of [[alice, a.publications[0]], [bob, b.publications[0]]] as const) {
      const held = await app.request('/api/private-requests/hold-mailbox', { kind: 'publication-mailbox', id: publication.publicationId });
      assert.equal((await app.request(`/api/private-requests/${held.saved}/release`, {})).result.kind, 'mailbox');
      const matches = await app.request('/api/matches'); assert(matches.length >= 1, 'Encrypted match notice was not delivered'); mailboxCounts.push(matches.length);
      const count = matches.length; await app.relock();
      const repeated = await app.request('/api/private-requests/hold-mailbox', { kind: 'publication-mailbox', id: publication.publicationId });
      await app.request(`/api/private-requests/${repeated.saved}/release`, {});
      assert.equal((await app.request('/api/matches')).length, count, 'Mailbox reread duplicated a match');
    }
    passed('Both applications decrypt and retain match notices; lock/unlock plus another mailbox check does not duplicate them');
    if (protectedAdmission) {
      assert(lastAccepted); await protectedAdmission.restart();
      assert.equal((await activeVerifier().verifyAndSpend(lastAccepted.capability, { ...lastAccepted.context, now: Date.now() })).status, 'replay');
      const { presentBlindAdmissionTokenV2, createAdmissionRequestBindingV2 } = await import('@resonance/core');
      const conflictingBinding = createAdmissionRequestBindingV2('search', { query: 'attempt to reuse a spent credential' });
      const conflicting = presentBlindAdmissionTokenV2(lastAccepted.capability.token, scope, 'search', conflictingBinding);
      assert.deepEqual(await activeVerifier().verifyAndSpend(conflicting, { action: 'search', requestBinding: conflictingBinding, now: Date.now() }),
        { status: 'rejected', reason: 'double_spend' });
      passed('All six protected admission owners reopen; exact retry succeeds and a conflicting spend remains rejected');
      // All loopback clients share one transport-IP allowance. Exercise faults
      // in the next ordinary minute instead of raising production rate limits
      // or mistaking a discovery refusal for a witness durability refusal.
      faultCooldownMs = Math.max(0, Math.ceil(65000 - (performance.now() - firstPrivateOperationAt)));
      if (faultCooldownMs) await delay(faultCooldownMs);
      const before = await alice.request('/api/admission-wallet'), beforeSpends = spends.length;
      await protectedAdmission.loseWitnessQuorum();
      const refused = await alice.request('/api/search', { text: texts[2], type: 'need' }, 503);
      assert.equal(spends.length, beforeSpends);
      assert.equal((await alice.request('/api/admission-wallet')).available, before.available - 1, `Witness-quorum fault must reach token reservation: ${JSON.stringify(refused)}`);
      passed('Witness history quorum loss refuses actual application search and retains the uncertain token without refund');
    }
    if (protectedPolicy) {
      const before = await alice.request('/api/admission-wallet'), beforeSpends = spends.length;
      await protectedPolicy.loseHistoryQuorums();
      const refusal = await alice.request('/api/search', { text: texts[2], type: 'need' }, 503);
      assert.equal(typeof refusal.error, 'string');
      assert.equal((await alice.request('/api/admission-wallet')).available, before.available);
      assert.equal(spends.length, beforeSpends);
      passed('Protected observer history quorum loss refuses an actual app search before reserving or redeeming another token');
    }
    const snapshots = [await alice.snapshot(), await bob.snapshot()], allWire = [...wire, ...snapshots.flatMap(s => s.wire)];
    for (const snapshot of snapshots) {
      assert(allWire.every(frame => !frame.includes(snapshot.did)), 'Account identity leaked to a network frame');
      assert(spends.every(spend => !spend.serialized.includes(snapshot.did)), 'Account identity leaked in an admission presentation');
    }
    for (const text of texts) assert(allWire.every(frame => !frame.includes(text)), 'Plaintext content leaked to a network frame');
    const bindings = new Map<string, string>(), tokenBindings = new Map<string, string>();
    for (const spend of spends) {
      assert(['accepted', 'replay'].includes(spend.status));
      assert.equal(bindings.get(spend.binding) ?? spend.token, spend.token);
      assert.equal(tokenBindings.get(spend.token) ?? spend.binding, spend.binding, 'Credential reused for a different request');
      bindings.set(spend.binding, spend.token); tokenBindings.set(spend.token, spend.binding);
      assert(allWire.every(frame => !frame.includes(spend.token)), 'Admission token exposed outside encrypted transport');
    }
    assert(bindings.size >= 8); assert(spends.some(s => s.action === 'mailbox-acknowledge'));
    passed('No root account identifier, plaintext item text or spent token appears in captured network frames; distinct request bindings use distinct tokens');
    const cpu = process.cpuUsage(cpuStart);
    report = { measuredAt: new Date().toISOString(), checkpoints, model: 'nomic-ai/nomic-embed-text-v1', dtype: 'fp32', remoteModelDownloads: false,
      applicationProcesses: 2, published: 3, mailboxMatchCounts: mailboxCounts, distinctRequestBindings: bindings.size, distinctSpentTokens: tokenBindings.size,
      protectedPolicy: protectedPolicy ? { observers: 5, durableHistories: 25, privateQueries: protectedPolicy.queries(), issuerAndRelayFreshness: true, quorumLossRefusedBeforeSpend: true } : null,
      protectedAdmission: protectedAdmission ? { witnesses: 5, coordinators: 1, durableHistories: 30, restartedOwners: 6,
        retainedDoubleSpendRefusal: true, quorumLossRefused: true } : null,
      apiTimings, faultCooldownMs,
      actions: Object.fromEntries([...new Set(spends.map(s => s.action))].map(action => [action, spends.filter(s => s.action === action).length])),
      resources: { durationMs: Math.round(performance.now() - started), websocketPayloadBytes: frameBytes + snapshots.reduce((n, s) => n + s.frameBytes, 0),
        parentPeakRssBytes: process.resourceUsage().maxRSS * 1024, applicationPeakRssBytes: snapshots.map(s => s.peakRssBytes),
        cpuSeconds: (cpu.user + cpu.system) / 1e6 + snapshots.reduce((n, s) => n + s.cpuSeconds, 0), node: process.version, platform: process.platform, architecture: process.arch },
      limitations: ['Local IPv4/IPv6 loopback domains on one computer; not independent operators, Internet or TLS deployment.',
        'Actual desktop backend APIs and embeddings; no graphical user interaction or native installer is certified.',
        protectedAdmission ? 'Five protected observers, five witnesses and one coordinator use 55 local durable history services; eligibility distribution and independent operators remain separate.'
          : protectedPolicy ? 'Five protected observers with 25 local durable histories, issuer/relay freshness and private wallet checks are composed here; spend-witness quorum durability and eligibility distribution remain separate.'
          : 'Signed manual policy and real blinded tokens with a durable local issuer; observer freshness, quorum spends and eligibility distribution are tested separately, not composed here.',
        'Account/credential-field separation is not timing or content unlinkability; static fingerprints and match relationships remain observable to the destination.',
        'Wire payload counts exclude TCP/TLS/WebSocket headers; per-process peak RSS values are not simultaneous total memory and CPU time is not energy.',
        'Two concurrent model processes on this host; representative hardware and cold first-download experience remain unmeasured.'] };
  } finally {
    for (const child of processes.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send('stop'); else child.kill('SIGTERM');
      });
    }
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    WebSocket.prototype.send = originalSend;
    if (errors.length) throw new AggregateError(errors, `Evaluation cleanup failed; retain ${directory}`);
    rmSync(directory, { recursive: true, force: true });
  }
  assert(report);
  if (values.out) {
    const output = resolve(root, values.out); assert(output.endsWith('.json')); mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, checkpoints: checkpoints.length, resources: report.resources }, null, 2));
  } else console.log(JSON.stringify(report, null, 2));
}
