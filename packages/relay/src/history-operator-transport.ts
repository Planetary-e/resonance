/** Lazy, explicitly pinned outbound transport for reviewed operator workflows.
 * Offline review/status never opens a connection or reads an infrastructure key. */
import { dirname, resolve } from 'node:path';
import { createRelayDescriptorV1, type Identity } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import type { AdmissionHistoryProtection } from './protected-admission-history.js';
import { exchangeHistoryAgreement, exchangeHistoryAgreementData, exchangeHistoryProvision } from './history-agreement-exchange.js';
import { exchangeHistoryCheckpoint } from './history-checkpoint-exchange.js';
import type { HistoryAgreementTransport, HistoryAgreementDataTransport, HistoryProvisionTransport } from './history-agreement-exchange.js';
import { readOperatorJson } from './admission-operator-files.js';
import { readAdmissionHistoryLinksFile } from './admission-history-config.js';
import { parseHistoryBridgeContact } from './history-bridge-config.js';
import { isHistoryRelayId } from './history-relay-bridge.js';
import { HistoryRelayRouter } from './history-relay-router.js';
import { RelayLinkManager } from './relay-link-client.js';
import { loadExistingRelayIdentity } from './relay-identity-store.js';
import { readRelayIdentityPassphrase } from './relay-identity-config.js';

export function readHistoryOperatorTransportFile(path: string, context: AdmissionHistoryProtection['context']) {
  const value = readOperatorJson(path, 64 * 1024);
  if (!exactWitnessFields(value, ['version', 'identityDirectory', 'identityPassphraseFile', 'expectedRelayId', 'linksFile', 'contacts', 'deadlineMs'])
    || value.version !== 1 || !isHistoryRelayId(value.expectedRelayId)
    || !Number.isSafeInteger(value.deadlineMs) || (value.deadlineMs as number) < 100 || (value.deadlineMs as number) > 300000
    || !Array.isArray(value.contacts) || value.contacts.length > 5) throw new Error('Invalid operator history transport configuration');
  const file = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw.length || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('Invalid operator transport file path');
    return resolve(dirname(resolve(path)), raw);
  };
  const identityDirectory = file(value.identityDirectory), identityPassphraseFile = file(value.identityPassphraseFile);
  const links = readAdmissionHistoryLinksFile(file(value.linksFile), context);
  const supplied = value.contacts.map(parseHistoryBridgeContact);
  // Bridge endpoints come only from the separately pinned links file. Direct
  // operation needs a reachable, pinned contact for every member; no listener.
  const targets = links.contacts.length ? links.contacts : supplied;
  if ((links.contacts.length && supplied.length) || (!links.contacts.length && supplied.length !== 5)
    || new Set(targets.map(t => t.endpoint)).size !== targets.length
    || new Set(targets.map(t => t.expectedRelayId)).size !== targets.length
    || (!links.contacts.length && supplied.some(t => !links.members.some(m => m.relayId === t.expectedRelayId)))
    || links.members.some(m => m.relayId === value.expectedRelayId)
    || targets.some(t => t.expectedRelayId === value.expectedRelayId)) throw new Error('Operator transport contacts do not match the retained routing pins');
  return { identityDirectory, identityPassphraseFile, expectedRelayId: value.expectedRelayId,
    deadlineMs: value.deadlineMs as number, members: links.members, targets };
}

export function createHistoryOperatorTransport(protection: AdmissionHistoryProtection, path: string | undefined, signal?: AbortSignal) {
  // Parsing is offline. A supplied but invalid file must never select direct fallback.
  const config = path === undefined ? undefined : readHistoryOperatorTransportFile(path, protection.context);
  let router: HistoryRelayRouter | undefined, manager: RelayLinkManager | undefined, identity: Identity | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const lifetime = new AbortController();
  function close() {
    if (closed) return; closed = true;
    signal?.removeEventListener('abort', close);
    if (timer) clearTimeout(timer);
    router?.close(); lifetime.abort(); manager?.stop(); identity?.secretKey.fill(0);
  }
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  function combined(request: AbortSignal) {
    const joined = AbortSignal.any([request, lifetime.signal]);
    if (joined.aborted) throw new Error('Operator history request cancelled');
    return joined;
  }
  function session(signal: AbortSignal) {
    if (signal.aborted) throw new Error('Operator history request cancelled');
    if (closed || !config) throw new Error('Operator history transport is unavailable');
    if (router) return router;
    try {
      identity = loadExistingRelayIdentity(config.identityDirectory, readRelayIdentityPassphrase(undefined, config.identityPassphraseFile)!);
      if (identity.did !== config.expectedRelayId) throw new Error('Operator infrastructure identity does not match its retained pin');
      router = new HistoryRelayRouter({ members: config.members, waitForConnection: true, serializeRequests: true });
      let sequence = Date.now();
      manager = new RelayLinkManager(identity, () => {
        const now = Date.now(); sequence = Math.max(sequence + 1, now);
        return createRelayDescriptorV1({ sequence, issuedAt: now, expiresAt: now + 120000,
          reachability: 'outbound-only', endpoints: [], supportedGroups: [],
          capabilities: { storesPublications: false, storesMailboxes: false, answersQueries: false, forwardsQueries: false, replicaExchange: false },
          storage: { capacityBytes: 0, availableBytes: 0 } }, identity!);
      }, { targets: config.targets, maxConnections: 5, historyLinks: router, signal: lifetime.signal,
        handshakeTimeoutMs: Math.min(15000, config.deadlineMs), reconnectBaseMs: 250, reconnectMaxMs: 1000 });
      timer = setTimeout(close, config.deadlineMs); manager.start();
      return router;
    } catch (error) { close(); throw error; }
  }
  const agreementTransport: HistoryAgreementTransport = (member, frame, signal) => config ? session(signal).agreement(member, frame, combined(signal)) : exchangeHistoryAgreement(member, frame, combined(signal));
  const dataTransport: HistoryAgreementDataTransport = (member, frame, signal) => config ? session(signal).transfer(member, frame, combined(signal)) : exchangeHistoryAgreementData(member, frame, combined(signal));
  const provisionTransport: HistoryProvisionTransport = (member, frame, signal) => config ? session(signal).provision(member, frame, combined(signal)) : exchangeHistoryProvision(member, frame, combined(signal));
  return {
    protection: { ...protection, transport: (member, frame, signal) => config
      ? session(signal).checkpoint(member, frame, combined(signal))
      : (protection.transport ?? exchangeHistoryCheckpoint)(member, frame, combined(signal)) } as AdmissionHistoryProtection,
    agreementTransport, dataTransport, provisionTransport, close,
  };
}
