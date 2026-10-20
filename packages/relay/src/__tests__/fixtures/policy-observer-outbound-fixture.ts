import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRelayContactHintV1 } from '@resonance/core';
import { policyObserverSetupFixture } from './policy-observer-setup-fixture.js';
import { readPolicyObserverEnrollment } from '../../policy-observer-setup.js';
import { openConfiguredHistoryVolunteer, parseHistoryVolunteerConfiguration } from '../../history-volunteer-config.js';
import { HistoryRelayRouter } from '../../history-relay-router.js';
import { createRelayServer } from '../../server.js';
import { loadOrCreateRelayIdentity } from '../../relay-identity-store.js';
import { openConfiguredHistoryVolunteerCollection, parseHistoryVolunteerCollection } from '../../history-volunteer-collection.js';
import type { HistoryRoleMethod } from '../../history-relay-link.js';

export async function waitForPolicyLinks(test: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!test()) { if (Date.now() >= deadline) throw new Error('Policy history links did not settle'); await new Promise(r => setTimeout(r, 10)); }
}
export async function policyObserverOutboundFixture(register: (close: () => void | Promise<void>) => void,
  options: { coLocated?: boolean; trace?: boolean; beforeExchange?: (replica: number, method: HistoryRoleMethod, frame: unknown) => Promise<void> } = {}) {
  const n = await policyObserverSetupFixture(register); await n.prepare();
  for (let i = 0; i < 5; i++) await n.enroll(i);
  const enrollment = readPolicyObserverEnrollment(n.enrollmentPath);
  const identity = (path: string, secret?: string) => { const key = loadOrCreateRelayIdentity(path, secret); try { return key.did; } finally { key.secretKey.fill(0); } };
  const identityDirectory = join(n.directory, 'operator-identity'), passphrase = 'policy observer operator secret';
  const operatorId = identity(identityDirectory, passphrase), secret = join(n.directory, 'passphrase'); writeFileSync(secret, passphrase);
  const maintenanceDirectory = options.coLocated ? join(n.directory, 'maintenance-identity') : identityDirectory;
  const maintenanceId = options.coLocated ? identity(maintenanceDirectory, passphrase) : operatorId;
  const volunteerDirectories = n.keys.map((_, i) => join(n.directory, `relay-${i}`)), ids = volunteerDirectories.map(path => identity(path));
  if (options.coLocated) { volunteerDirectories[0] = identityDirectory; ids[0] = operatorId; }
  const bridgeDirectory = join(n.directory, 'bridge'), bridgeId = identity(bridgeDirectory);
  const controllers = [...new Set([operatorId, maintenanceId])];
  const bridgeRouter = new HistoryRelayRouter({ waitForConnection: true, bridgeRoutes: controllers.flatMap(controllerRelayId =>
    ids.filter(id => id !== controllerRelayId).map(targetRelayId => ({ controllerRelayId, targetRelayId }))) });
  register(() => bridgeRouter.close());
  const discovery = { supportedGroups: ['public'], descriptorLifetimeMs: 120000, storage: { capacityBytes: 1000000, availableBytes: 1000000 } };
  const bridge = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: bridgeDirectory, historyLinks: bridgeRouter,
    relayDiscovery: { ...discovery, endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct' } });
  await bridge.start(); register(() => bridge.stop({ graceful: false }));
  const endpoint = bridge.getRelayDescriptor()!.endpoints[0];
  // Test-only diagnostics retain bounded metadata, never protocol values or operator files.
  type ExchangeTrace = { member: number; method: HistoryRoleMethod; action: string | null; startedMs: number;
    durationMs: number; status: 'waiting' | 'handling' | 'succeeded' | 'failed'; failure?: 'timeout' | 'cancelled' | 'storage' | 'other' };
  const trace: ExchangeTrace[] = [], traceStart = performance.now();
  function exchangeTrace() {
    return trace.map(entry => ({ ...entry, durationMs: entry.status === 'waiting' || entry.status === 'handling'
      ? Math.round(performance.now() - traceStart - entry.startedMs) : entry.durationMs }));
  }
  let coLocatedFile: string | undefined;
  const roles = n.keys.map((_, i) => {
    const value = { version: 1,
    context: enrollment.historyContext, genesisId: enrollment.genesisId, directory: n.replicaArgs(i)[3], signingKeyFile: n.keyFiles[i], storageKeyFile: n.storageFiles[i],
    controllers: [{ relayId: bridgeId, endpoint }], limits: { bytesPerGeneration: 64 * 1024 * 1024, blocksPerGeneration: 10001, generations: 65 } };
    if (options.coLocated && i === 0) {
      coLocatedFile = join(n.directory, 'co-located-volunteer.json'); writeFileSync(coLocatedFile, JSON.stringify(value)); return undefined;
    }
    if (!options.beforeExchange && !options.trace) return openConfiguredHistoryVolunteer(parseHistoryVolunteerConfiguration(value, n.directory));
    const { version: _version, controllers, ...history } = value;
    const collection = openConfiguredHistoryVolunteerCollection(parseHistoryVolunteerCollection({ version: 1, kind: 'history-volunteer-collection', histories: [history], controllers }, n.directory));
    const router = new HistoryRelayRouter({ acceptedRelayIds: [bridgeId], handler: async (method, frame) => {
      const action = (frame as { request?: { action?: unknown } } | null)?.request?.action;
      const entry: ExchangeTrace = { member: i, method,
        action: typeof action === 'string' && ['append', 'install', 'head', 'read', 'freeze', 'repair', 'seal', 'continuation'].includes(action) ? action : null,
        startedMs: Math.round(performance.now() - traceStart), durationMs: 0, status: 'waiting' };
      if (options.trace) { if (trace.length === 64) trace.shift(); trace.push(entry); }
      const started = performance.now();
      try {
        await options.beforeExchange?.(i, method, frame); entry.status = 'handling';
        const result = await collection.handle(method, frame); entry.status = 'succeeded'; return result;
      } catch (error) {
        entry.status = 'failed';
        const code = (error as NodeJS.ErrnoException)?.code, message = error instanceof Error ? error.message : '';
        entry.failure = code === 'ETIMEDOUT' || /timed out|deadline|expired/i.test(message) ? 'timeout'
          : code === 'ECANCELED' || /cancelled|aborted/i.test(message) ? 'cancelled'
          : ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'EBUSY', 'ENOENT', 'EMFILE', 'ENFILE'].includes(code ?? '') ? 'storage' : 'other';
        throw error;
      } finally { entry.durationMs = Math.round(performance.now() - started); }
    } });
    return { router, close() { router.close(); collection.close(); } };
  });
  register(() => roles.forEach(role => role?.close()));
  const volunteers = [];
  for (let i = 0; i < 5; i++) {
    const role = roles[i]; if (!role) continue;
    const volunteer = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: volunteerDirectories[i], historyLinks: role.router,
      relayDiscovery: { ...discovery, endpoints: [], reachability: 'outbound-only' },
      relayLinks: { targets: [createRelayContactHintV1('configured', endpoint, bridgeId)], reconnectBaseMs: 50, reconnectMaxMs: 100 } });
    await volunteer.start(); register(() => volunteer.stop({ graceful: false })); volunteers.push(volunteer);
  }
  await waitForPolicyLinks(() => bridge.getRelayLinkStatus().inboundRelayIds.filter(id => ids.includes(id)).length === (options.coLocated ? 4 : 5));
  const links = join(n.directory, 'links.json'); writeFileSync(links, JSON.stringify({ version: 2,
    members: n.input.members.map((member, i) => ({ publicKey: member.publicKey, relayId: ids[i] })), bridge: { relayId: bridgeId, endpoint } }));
  const transportFile = join(n.directory, 'transport.json'); writeFileSync(transportFile, JSON.stringify({ version: 1, identityDirectory: maintenanceDirectory,
    identityPassphraseFile: secret, expectedRelayId: maintenanceId, linksFile: links, contacts: [], deadlineMs: 15000 }));
  return { ...n, enrollment, bridge, bridgeRouter, volunteers, roles, transportFile, secret, operatorId, identityDirectory, links, coLocatedFile,
    exchangeTrace, resetExchangeTrace() { trace.length = 0; } };
}
