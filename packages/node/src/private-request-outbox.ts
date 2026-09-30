/** Encrypted, explicitly released search and mailbox intents. Signed requests exist only during release. */
import { randomBytes } from 'node:crypto';
import type { SearchResultV2 } from '@resonance/core';
import { openEncryptedLocalState } from './encrypted-local-state.js';
import { createRelayClient, type RelayClient, type AdmissionCapabilityProviderV2 } from './relay-client.js';
import { PrivateOperationError, PRIVATE_OPERATION_DEADLINE_MS } from './private-operation.js';
import { validatePrivatePublicationRoute, type PrivatePublicationRoute } from './publication-outbox.js';

export const MAX_PRIVATE_REQUEST_HOLDS = 64;
export const MAX_PRIVATE_REQUEST_HOLD_BYTES = 16 * 1024 * 1024;
export const PRIVATE_REQUEST_HOLD_LIFETIME_MS = 24 * 60 * 60 * 1000;
export type PrivateRequestIntent =
  | { kind: 'search'; text: string; itemType: 'need' | 'offer'; fingerprint: string }
  | { kind: 'publication-mailbox'; publicationId: string }
  | { kind: 'relationship-mailbox'; relationshipId: string };
export type PrivateRequestResult = { kind: 'search'; results: SearchResultV2[] }
  | { kind: 'mailbox'; matchesAdded: number; messagesProcessed: number; channelsActivated: number; channelOperationsProcessed: number };
export type HeldRequestState = 'held' | 'sending' | 'completed' | 'cancelled' | 'expired' | 'outcome-unknown';
export interface HeldRequest {
  id: string; intent: PrivateRequestIntent; state: HeldRequestState; heldAt: number; expiresAt: number;
  attempts: number; mayHaveBeenSent: boolean; result: PrivateRequestResult | null;
}
interface Entry extends HeldRequest { route: PrivatePublicationRoute }
interface State { version: 1; automaticMailboxes: boolean; entries: Entry[] }

/** A terminal guard: disconnecting/cancelling a released workflow also forbids subsequent follow-up calls. */
export function guardRelayClient(client: RelayClient, signal: AbortSignal, check: () => void = () => {}, called: () => void = () => {}, succeeded: () => void = () => {}): RelayClient {
  return new Proxy(client, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== 'function' || ['disconnect', 'isConnected', 'on'].includes(String(property))) return value;
    return (...args: unknown[]) => {
      signal.throwIfAborted(); check(); called();
      return Promise.resolve(Reflect.apply(value, target, args)).then(result => {
        succeeded(); signal.throwIfAborted(); check(); return result;
      });
    };
  } });
}

export function openPrivateRequestOutbox(options: {
  path: string; encryptionKey: Uint8Array; admissionCapabilityProvider?: AdmissionCapabilityProviderV2;
  execute(intent: PrivateRequestIntent, client: RelayClient, signal: AbortSignal): Promise<PrivateRequestResult>;
  now?: () => number; maxEntries?: number; maxBytes?: number;
}) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_PRIVATE_REQUEST_HOLDS;
  const maxBytes = options.maxBytes ?? MAX_PRIVATE_REQUEST_HOLD_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_PRIVATE_REQUEST_HOLDS
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PRIVATE_REQUEST_HOLD_BYTES) throw new Error('Invalid saved-request capacity');
  const storage = openEncryptedLocalState<State>({ path: options.path, key: options.encryptionKey,
    domain: 'resonance:private-request-outbox:v1', maxBytes,
    initial: { version: 1, automaticMailboxes: true, entries: [] }, validate: validState });
  const active = new Map<string, { cancel(): void }>();
  let closed = false;
  try {
    const state = storage.read();
    if (state.entries.some(entry => entry.state === 'sending')) storage.write({ ...state,
      entries: state.entries.map(entry => entry.state === 'sending' ? { ...entry, state: 'outcome-unknown', mayHaveBeenSent: true } : entry) });
    expire();
  } catch (error) { storage.close(); throw error; }
  function expire() {
    const state = storage.read(); const at = now();
    if (state.entries.some(entry => ['held', 'outcome-unknown'].includes(entry.state) && entry.expiresAt <= at)) {
      storage.write({ ...state, entries: state.entries.map(entry => ['held', 'outcome-unknown'].includes(entry.state) && entry.expiresAt <= at
        ? { ...entry, state: 'expired' } : entry) });
    }
  }
  function find(id: string) { const entry = storage.read().entries.find(entry => entry.id === id); if (!entry) throw new Error('Saved request not found'); return entry; }
  function patch(id: string, change: Partial<Entry>) {
    const state = storage.read(); storage.write({ ...state, entries: state.entries.map(entry => entry.id === id ? { ...entry, ...change } : entry) });
  }
  function publicEntry(entry: Entry): HeldRequest { const { route, ...value } = entry; return structuredClone(value); }
  return {
    list(): HeldRequest[] { expire(); return storage.read().entries.map(publicEntry); },
    automaticMailboxes(): boolean { return storage.read().automaticMailboxes; },
    setAutomaticMailboxes(enabled: boolean): void {
      expire(); const state = storage.read();
      if (enabled && state.entries.some(entry => entry.intent.kind !== 'search' && ['held', 'sending', 'outcome-unknown'].includes(entry.state))) {
        throw new Error('Run, cancel, or remove pending mailbox checks before enabling automatic checks');
      }
      storage.write({ ...state, automaticMailboxes: enabled });
    },
    hold(intent: PrivateRequestIntent, route: PrivatePublicationRoute): HeldRequest {
      expire(); if (!validIntent(intent)) throw new Error('Invalid saved request'); validatePrivatePublicationRoute(route);
      const state = storage.read(); if (state.entries.length >= maxEntries) throw new Error('Saved requests are full; remove finished requests first');
      if (intent.kind !== 'search' && state.entries.some(entry => ['held', 'sending', 'outcome-unknown'].includes(entry.state) && sameMailbox(entry.intent, intent))) {
        throw new Error('This mailbox already has a pending check');
      }
      const at = now();
      const entry: Entry = structuredClone({ id: `reqhold_${randomBytes(16).toString('hex')}`, intent, route,
        state: 'held', heldAt: at, expiresAt: at + PRIVATE_REQUEST_HOLD_LIFETIME_MS, attempts: 0, mayHaveBeenSent: false, result: null });
      // Saving a mailbox check atomically pauses every automatic mailbox path.
      storage.write({ ...state, automaticMailboxes: intent.kind === 'search' ? state.automaticMailboxes : false, entries: [...state.entries, entry] });
      return publicEntry(entry);
    },
    async release(id: string): Promise<PrivateRequestResult> {
      expire(); const entry = find(id);
      if (!['held', 'outcome-unknown'].includes(entry.state) || active.has(id)) throw new Error('Request cannot run in its current state');
      if (active.size >= 4) throw new Error('Four saved requests are already running');
      patch(id, { state: 'sending', attempts: entry.attempts + 1, mayHaveBeenSent: true });
      const controller = new AbortController();
      let client: RelayClient | undefined; let calls = 0; let successes = 0; let cancelled = false; let persisting = false;
      const deadline = performance.now() + PRIVATE_OPERATION_DEADLINE_MS;
      function abort(reason: string) { if (!controller.signal.aborted) controller.abort(new Error(reason)); client?.disconnect(); }
      const check = () => {
        if (performance.now() >= deadline || now() >= entry.expiresAt) abort('Saved request exceeded its delivery deadline');
        controller.signal.throwIfAborted();
      };
      const timer = setTimeout(() => abort('Saved request exceeded its ten-second delivery deadline'), PRIVATE_OPERATION_DEADLINE_MS);
      active.set(id, { cancel() { cancelled = true; abort('Saved request cancelled'); } });
      try {
        check(); client = createRelayClient({ ...entry.route, admissionCapabilityProvider: options.admissionCapabilityProvider });
        const guarded = guardRelayClient(client, controller.signal, check, () => calls++, () => successes++);
        // Race even a non-cooperating executor. Its client guard forbids late network continuations.
        const result = await new Promise<PrivateRequestResult>((resolve, reject) => {
          const aborted = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', aborted, { once: true });
          Promise.resolve().then(() => { check(); return options.execute(structuredClone(entry.intent), guarded, controller.signal); })
            .then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
        });
        check(); if (closed) throw new Error('Saved requests closed during delivery');
        if (!validResult(result) || (entry.intent.kind === 'search') !== (result.kind === 'search')) throw new Error('Invalid saved-request result');
        persisting = true; patch(id, { state: 'completed', result }); return structuredClone(result);
      } catch (error) {
        if (!closed && !persisting) {
          const uncertain = entry.mayHaveBeenSent || successes > 0 || (calls > 0 && !(error instanceof PrivateOperationError && error.outcome === 'not-sent'));
          patch(id, { state: now() >= entry.expiresAt ? 'expired' : uncertain ? 'outcome-unknown' : cancelled ? 'cancelled' : 'held', mayHaveBeenSent: uncertain });
        }
        throw error;
      } finally { clearTimeout(timer); abort('Saved request finished'); active.delete(id); }
    },
    cancel(id: string): void {
      expire(); if (active.has(id)) { active.get(id)!.cancel(); return; }
      if (find(id).state !== 'held') throw new Error('Only an unsent request can be cancelled'); patch(id, { state: 'cancelled' });
    },
    remove(id: string): void {
      expire(); if (['held', 'sending'].includes(find(id).state)) throw new Error('Cancel or finish this request first');
      const state = storage.read(); storage.write({ ...state, entries: state.entries.filter(entry => entry.id !== id) });
    },
    close(): void { if (closed) return; closed = true; for (const operation of active.values()) operation.cancel(); storage.close(); },
  };

  function validState(value: unknown): value is State {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'automaticMailboxes,entries,version'
      || value.version !== 1 || typeof value.automaticMailboxes !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > maxEntries) return false;
    const ids = new Set<string>();
    for (const entry of value.entries) {
      if (!object(entry) || Object.keys(entry).sort().join(',') !== 'attempts,expiresAt,heldAt,id,intent,mayHaveBeenSent,result,route,state'
        || typeof entry.id !== 'string' || !/^reqhold_[a-f0-9]{32}$/.test(entry.id) || ids.has(entry.id)
        || !validIntent(entry.intent) || !Number.isSafeInteger(entry.heldAt) || !Number.isSafeInteger(entry.expiresAt)
        || entry.expiresAt !== Number(entry.heldAt) + PRIVATE_REQUEST_HOLD_LIFETIME_MS
        || !Number.isSafeInteger(entry.attempts) || Number(entry.attempts) < 0 || typeof entry.mayHaveBeenSent !== 'boolean'
        || !['held', 'sending', 'completed', 'cancelled', 'expired', 'outcome-unknown'].includes(String(entry.state))
        || (['held', 'cancelled'].includes(String(entry.state)) && entry.mayHaveBeenSent)
        || (['sending', 'completed', 'outcome-unknown'].includes(String(entry.state)) && !entry.mayHaveBeenSent)
        || (entry.state === 'completed' ? !validResult(entry.result) : entry.result !== null)) return false;
      try { validatePrivatePublicationRoute(entry.route as PrivatePublicationRoute); } catch { return false; }
      ids.add(entry.id);
    }
    return true;
  }
}
export type PrivateRequestOutbox = ReturnType<typeof openPrivateRequestOutbox>;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validIntent(value: unknown): value is PrivateRequestIntent {
  if (!object(value)) return false;
  if (value.kind === 'publication-mailbox') return Object.keys(value).sort().join(',') === 'kind,publicationId' && typeof value.publicationId === 'string' && /^pub_[A-Za-z0-9_-]{43}$/.test(value.publicationId);
  if (value.kind === 'relationship-mailbox') return Object.keys(value).sort().join(',') === 'kind,relationshipId' && typeof value.relationshipId === 'string' && /^rel_[A-Za-z0-9_-]{43}$/.test(value.relationshipId);
  return value.kind === 'search' && Object.keys(value).sort().join(',') === 'fingerprint,itemType,kind,text'
    && typeof value.text === 'string' && value.text.trim().length > 0 && Buffer.byteLength(value.text) <= 8192
    && ['need', 'offer'].includes(String(value.itemType)) && typeof value.fingerprint === 'string'
    && Buffer.from(value.fingerprint, 'base64').length === 64 && Buffer.from(value.fingerprint, 'base64').toString('base64') === value.fingerprint;
}
function validResult(value: unknown): value is PrivateRequestResult {
  if (!object(value)) return false;
  if (value.kind === 'mailbox') return Object.keys(value).sort().join(',') === 'channelOperationsProcessed,channelsActivated,kind,matchesAdded,messagesProcessed'
    && ['matchesAdded', 'messagesProcessed', 'channelsActivated', 'channelOperationsProcessed'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
  return value.kind === 'search' && Object.keys(value).sort().join(',') === 'kind,results' && Array.isArray(value.results) && value.results.length <= 10 && value.results.every(result => object(result)
    && Object.keys(result).sort().join(',') === 'itemType,publicationId,similarity'
    && typeof result.publicationId === 'string' && /^pub_[A-Za-z0-9_-]{43}$/.test(result.publicationId)
    && ['need', 'offer'].includes(String(result.itemType)) && typeof result.similarity === 'number' && Number.isFinite(result.similarity) && result.similarity >= -1 && result.similarity <= 1);
}

function sameMailbox(a: PrivateRequestIntent, b: PrivateRequestIntent): boolean {
  return a.kind === 'publication-mailbox' && b.kind === 'publication-mailbox' ? a.publicationId === b.publicationId
    : a.kind === 'relationship-mailbox' && b.kind === 'relationship-mailbox' && a.relationshipId === b.relationshipId;
}
