/** Explicit, local-only holds for signed publications. No timers, polling, or automatic retries. */
import { randomBytes } from 'node:crypto';
import { assertSecureRelayTransportEndpoint, verifyPublicationRecord, type AckPayload, type PublicationRecord } from '@resonance/core';
import { createRelayClient, type AdmissionCapabilityProviderV2, type RelayClient } from './relay-client.js';
import { PrivateOperationError } from './private-operation.js';
import { openEncryptedLocalState } from './encrypted-local-state.js';

export const MAX_PUBLICATION_OUTBOX_ENTRIES = 64;
export const MAX_PUBLICATION_OUTBOX_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_RELEASES = 4;
export type PublicationDeliveryState = 'held' | 'sending' | 'delivered' | 'cancelled' | 'expired' | 'outcome-unknown';
export interface PrivatePublicationRoute {
  relayUrl: string;
  fallbackUrls: string[];
  privateEntryUrls: string[];
}
export interface HeldPublicationSummary {
  id: string;
  publicationId: string;
  state: PublicationDeliveryState;
  heldAt: number;
  expiresAt: number;
  mayHaveBeenSent: boolean;
}
interface Entry extends HeldPublicationSummary {
  record: PublicationRecord;
  route: PrivatePublicationRoute;
  localData: string;
}
interface State { version: 1; entries: Entry[] }

export function openPublicationOutbox(options: {
  path: string; encryptionKey: Uint8Array;
  admissionCapabilityProvider?: AdmissionCapabilityProviderV2;
  /** Owner/test limits may be smaller, never larger than the fixed maximums. */
  maxEntries?: number; maxBytes?: number;
  now?: () => number;
}) {
  const capacity = limit(options.maxEntries ?? MAX_PUBLICATION_OUTBOX_ENTRIES, MAX_PUBLICATION_OUTBOX_ENTRIES);
  const maxBytes = limit(options.maxBytes ?? MAX_PUBLICATION_OUTBOX_BYTES, MAX_PUBLICATION_OUTBOX_BYTES);
  const now = options.now ?? Date.now;
  const storage = openEncryptedLocalState<State>({
    path: options.path, key: options.encryptionKey, domain: 'resonance:publication-outbox:v1',
    maxBytes, initial: { version: 1, entries: [] }, validate: validState,
  });
  const active = new Map<string, { client: RelayClient; cancelled: boolean }>();
  let closed = false;
  try {
    const entries = storage.read().entries.map(entry => entry.state === 'sending'
      ? { ...entry, state: 'outcome-unknown' as const, mayHaveBeenSent: true } : entry);
    if (entries.some((entry, index) => entry !== storage.read().entries[index])) storage.write({ version: 1, entries });
    expire();
  } catch (error) { storage.close(); throw error; }

  function expire(): void {
    const at = now();
    const entries = storage.read().entries.map(entry =>
      !active.has(entry.id) && ['held', 'outcome-unknown'].includes(entry.state) && entry.expiresAt <= at
        ? { ...entry, state: 'expired' as const } : entry);
    if (entries.some((entry, index) => entry !== storage.read().entries[index])) storage.write({ version: 1, entries });
  }
  function find(id: string): Entry {
    const entry = storage.read().entries.find(item => item.id === id);
    if (!entry) throw new Error('Saved publication not found');
    return entry;
  }
  function update(id: string, patch: Partial<Entry>): void {
    storage.write({ version: 1, entries: storage.read().entries.map(entry => entry.id === id ? { ...entry, ...patch } : entry) });
  }

  return {
    hold(record: PublicationRecord, route: PrivatePublicationRoute, localData = ''): HeldPublicationSummary {
      expire();
      const at = now();
      if (!verifyPublicationRecord(record) || record.createdAt > at || record.expiresAt <= at) {
        throw new Error('Only a currently valid signed publication can be held');
      }
      validateRoute(route);
      if (typeof localData !== 'string' || Buffer.byteLength(localData) > maxBytes) throw new Error('Invalid local outbox data');
      if (storage.read().entries.some(entry => entry.publicationId === record.publicationId)) {
        throw new Error('Publication already has an outbox entry');
      }
      if (storage.read().entries.length >= capacity) throw new Error('Publication outbox is full; remove completed entries first');
      const entry: Entry = JSON.parse(JSON.stringify({
        id: `out_${randomBytes(16).toString('hex')}`, publicationId: record.publicationId,
        state: 'held', heldAt: at, expiresAt: record.expiresAt, mayHaveBeenSent: false,
        record, route, localData,
      }));
      storage.write({ version: 1, entries: [...storage.read().entries, entry] });
      return summary(entry);
    },
    list(): HeldPublicationSummary[] { expire(); return storage.read().entries.map(summary); },
    read(id: string): { record: PublicationRecord; localData: string; delivery: HeldPublicationSummary } {
      expire(); const entry = find(id);
      return { record: structuredClone(entry.record), localData: entry.localData, delivery: summary(entry) };
    },
    async release(id: string): Promise<AckPayload> {
      expire();
      const entry = find(id);
      if (active.has(id) || !['held', 'outcome-unknown'].includes(entry.state)) throw new Error('Saved publication cannot be sent in its current state');
      if (active.size >= MAX_CONCURRENT_RELEASES) throw new Error('Four saved publications are already sending; try again when one finishes');
      const previousUncertainty = entry.mayHaveBeenSent;
      // Persist the exact signed operation and sending intent before a client can reserve a token or open a socket.
      update(id, { state: 'sending', mayHaveBeenSent: true });
      let client: RelayClient | undefined;
      let started = false;
      let persistingAcknowledgement = false;
      try {
        client = createRelayClient({ ...entry.route, admissionCapabilityProvider: options.admissionCapabilityProvider });
        active.set(id, { client, cancelled: false });
        if (now() >= entry.expiresAt) throw new PrivateOperationError('PRIVATE_OPERATION_CANCELLED', 'not-sent', new Error('Saved publication expired'));
        started = true;
        const ack = await client.submitPublicationOperation(structuredClone(entry.record));
        if (closed) throw new Error('Outbox closed while sending; outcome unknown');
        if (ack.status !== 'ok' || ack.ref !== entry.publicationId) throw new Error('Saved publication was not acknowledged');
        persistingAcknowledgement = true;
        update(id, { state: 'delivered', mayHaveBeenSent: true });
        return ack;
      } catch (error) {
        if (!closed && !persistingAcknowledgement) {
          const uncertain = previousUncertainty || (started && !(error instanceof PrivateOperationError && error.outcome === 'not-sent'));
          const state: PublicationDeliveryState = now() >= entry.expiresAt ? 'expired'
            : uncertain ? 'outcome-unknown' : active.get(id)?.cancelled ? 'cancelled' : 'held';
          update(id, { state, mayHaveBeenSent: uncertain });
        }
        throw error;
      } finally { client?.disconnect(); active.delete(id); }
    },
    cancel(id: string): HeldPublicationSummary {
      expire(); const entry = find(id);
      const running = active.get(id);
      if (running) {
        running.cancelled = true;
        running.client.disconnect();
        return summary(entry); // Completion records whether cancellation preceded transmission.
      }
      if (entry.state !== 'held') throw new Error('Only an unsent held publication can be cancelled');
      update(id, { state: 'cancelled' });
      return summary(find(id));
    },
    remove(id: string): void {
      expire(); const entry = find(id);
      if (active.has(id) || !['delivered', 'cancelled', 'expired'].includes(entry.state)) {
        throw new Error('Only completed, cancelled, or expired outbox entries can be removed');
      }
      storage.write({ version: 1, entries: storage.read().entries.filter(item => item.id !== id) });
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const operation of active.values()) operation.client.disconnect();
      storage.close(); // Interrupted sends remain durable and reopen as unknown; they are never replayed.
    },
  };

  function validState(value: unknown): value is State {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'entries,version') return false;
    const state = value as State;
    if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > capacity) return false;
    const ids = new Set<string>(); const publications = new Set<string>();
    for (const entry of state.entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).sort().join(',') !== 'expiresAt,heldAt,id,localData,mayHaveBeenSent,publicationId,record,route,state'
        || !/^out_[a-f0-9]{32}$/.test(entry.id) || ids.has(entry.id) || publications.has(entry.publicationId)
        || !verifyPublicationRecord(entry.record) || entry.publicationId !== entry.record.publicationId
        || entry.expiresAt !== entry.record.expiresAt || !Number.isSafeInteger(entry.heldAt)
        || entry.heldAt < entry.record.createdAt || entry.heldAt >= entry.expiresAt
        || !['held', 'sending', 'delivered', 'cancelled', 'expired', 'outcome-unknown'].includes(entry.state)
        || typeof entry.mayHaveBeenSent !== 'boolean' || typeof entry.localData !== 'string'
        || (['held', 'cancelled'].includes(entry.state) && entry.mayHaveBeenSent)
        || (['sending', 'delivered', 'outcome-unknown'].includes(entry.state) && !entry.mayHaveBeenSent)) return false;
      try { validateRoute(entry.route); } catch { return false; }
      ids.add(entry.id); publications.add(entry.publicationId);
    }
    return true;
  }
}

export type PublicationOutbox = ReturnType<typeof openPublicationOutbox>;

function summary(entry: Entry): HeldPublicationSummary {
  const { id, publicationId, state, heldAt, expiresAt, mayHaveBeenSent } = entry;
  return { id, publicationId, state, heldAt, expiresAt, mayHaveBeenSent };
}

function validateRoute(route: PrivatePublicationRoute): void {
  if (!route || typeof route !== 'object' || Array.isArray(route)
    || Object.keys(route).sort().join(',') !== 'fallbackUrls,privateEntryUrls,relayUrl'
    || !Array.isArray(route.fallbackUrls) || !Array.isArray(route.privateEntryUrls)
    || route.fallbackUrls.length > 15 || !route.privateEntryUrls.length || route.privateEntryUrls.length > 16) {
    throw new Error('Saved publications require an explicit private relay route');
  }
  const destinations = [route.relayUrl, ...route.fallbackUrls];
  const urls = [...destinations, ...route.privateEntryUrls];
  if (new Set(urls).size !== urls.length) throw new Error('Private entry and destination URLs must be distinct');
  for (const url of urls) {
    if (typeof url !== 'string' || url.length > 512) throw new Error('Invalid private outbox route');
    assertSecureRelayTransportEndpoint(url);
  }
}

function limit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid outbox capacity limit');
  return value;
}
