/** Key-attributed local spends and irreversible retirement in one encrypted snapshot. */
import { resolve } from 'node:path';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionKeyFingerprint, admissionPolicyKeys, isArchivedAdmissionKey, assertAdmissionPolicyCurrent, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { planAdmissionHistoryRetirement, validRetiredIssuerKeys, type AdmissionHistoryMaintenance } from './admission-history-retirement.js';
import { checkAdmissionLegacyRecovery, type AdmissionSpendState, type AdmissionLegacyRecovery } from './admission-legacy-recovery.js';

export interface AdmissionSpendRecord { spend: string; action: string; binding: string; issuerKey: string | null }
export interface AdmissionSpendLedger {
  size(): number;
  get(spend: string): AdmissionSpendRecord | undefined;
  isRetired(issuerKey: string): boolean;
  write(row: AdmissionSpendRecord & { issuerKey: string }): void;
  close(): void;
}
export interface LegacyAdmissionSpendRow { version: 1; spend: string; action: string; binding: string }
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function validSpend(row: Record<string, unknown>): boolean {
  return typeof row.spend === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row.spend)
    && typeof row.action === 'string' && row.action.length <= 32
    && typeof row.binding === 'string' && /^admreq_[A-Za-z0-9_-]{86}$/.test(row.binding);
}
export function isLegacyAdmissionSpendRow(value: unknown): value is LegacyAdmissionSpendRow {
  return fields(value, ['version','spend','action','binding']) && value.version === 1 && validSpend(value);
}

export function openAdmissionSpendHistory(options: {
  /** Callers must authenticate the installed policy first. Initialization is only for genuinely new histories. */
  directory: string; encryptionKey: Uint8Array; policy: SignedAdmissionPolicy;
  initialize?: boolean; maxSpends?: number; now?: () => number;
}): AdmissionSpendLedger & AdmissionHistoryMaintenance & AdmissionLegacyRecovery {
  const limit = options.maxSpends ?? 10000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid admission spend history capacity');
  const policy = structuredClone(options.policy), now = options.now ?? Date.now;
  const known = new Set(admissionPolicyKeys(policy).map(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey)));
  const participant = resolve(options.directory);
  type State = AdmissionSpendState;
  const initial: State = { version: 2, authority: policy.authority, spends: [], retiredIssuerKeys: [] };
  const storage = openEncryptedLocalState<State>({
    // Same path as the old JSONL: after replacement older readers fail closed, without a second-file migration window.
    path: resolve(options.directory, 'admission-spends-v2.jsonl'), key: options.encryptionKey,
    domain: 'resonance:admission-local-spends:v2', maxBytes: 8 * 1024 * 1024,
    mode: options.initialize ? 'create-new' : 'open-existing', initial,
    decodeLegacy(bytes) {
      // Empty files are ambiguous: an old unused log and a truncated new snapshot look identical.
      if (!bytes.length) throw new Error('Empty admission spend history; restore intact history before reopening');
      // The encrypted envelope never ends in a newline. Incomplete legacy data also fails the encrypted parser.
      if (bytes.length && bytes.at(-1) !== 10) return undefined;
      if (bytes.length > limit * 512) throw new Error('Admission legacy spend log exceeds capacity');
      const spends: AdmissionSpendRecord[] = [];
      for (const line of bytes.toString('utf8').split('\n')) {
        if (!line) continue;
        let row: unknown;
        try { row = JSON.parse(line); } catch { throw new Error('Admission legacy spend log is corrupt'); }
        if (!isLegacyAdmissionSpendRow(row)) throw new Error('Admission legacy spend log is corrupt');
        // A hash cannot identify its issuer. Only a later cryptographically verified exact retry can attribute this row.
        spends.push({ spend: row.spend, action: row.action, binding: row.binding, issuerKey: null });
      }
      if (!spends.length) throw new Error('Empty admission spend history; restore intact history before reopening');
      return { ...initial, spends };
    },
    validate(value): value is State {
      if (!fields(value, ['version','authority','spends','retiredIssuerKeys']) || value.version !== 2 || value.authority !== policy.authority
        || !validRetiredIssuerKeys(value.retiredIssuerKeys, policy, participant, 'local-spends')
        || !Array.isArray(value.spends) || value.spends.length > limit) return false;
      const retired = new Set(value.retiredIssuerKeys), seen = new Set<string>();
      return value.spends.every(row => {
        if (!fields(row, ['issuerKey','spend','action','binding']) || !validSpend(row) || seen.has(row.spend as string)
          || (row.issuerKey !== null && (typeof row.issuerKey !== 'string' || !known.has(row.issuerKey) || retired.has(row.issuerKey)))) return false;
        seen.add(row.spend as string); return true;
      });
    },
  });
  const spends = new Map(storage.read().spends.map(row => [row.spend, row]));
  let recovering = false;
  function writable() { storage.read(); if (recovering) throw new Error('Legacy spend recovery is in progress'); }
  async function recover(proofs: unknown, approvedDigest?: string) {
    writable(); recovering = true;
    try {
      const state = storage.read();
      const checked = await checkAdmissionLegacyRecovery({ directory: participant, policy, state, proofs, now });
      storage.read(); // A close during asynchronous verification must prevent both review and commit.
      if (approvedDigest === undefined) return checked.plan;
      if (approvedDigest !== checked.plan.approvalDigest) throw new Error('Recovery evidence, history or approval changed; review recovery again');
      const time = now(); assertAdmissionPolicyCurrent(policy, time);
      if (checked.plan.keys.some(key => time < key.retryUntil)) throw new Error('Legacy spend recovery must wait for the final retry cutoff');
      // Proven removal and all required key fences are one atomic, flushed snapshot.
      storage.write(checked.next);
      spends.clear(); for (const row of checked.next.spends) spends.set(row.spend, row);
      return checked.plan;
    } finally { recovering = false; }
  }
  const planRetirement = (issuerKey: string) => {
    const state = storage.read();
    return { ...planAdmissionHistoryRetirement({ role: 'local-spends', participant, policy, issuerKey, state,
      retiredIssuerKeys: state.retiredIssuerKeys, entries: spends.size,
      remove: state.spends.filter(row => row.issuerKey === issuerKey).length, maximumEntries: limit, now: now() }),
      unattributedRecordsRetained: state.spends.filter(row => row.issuerKey === null).length };
  };
  return {
    planLegacyRecovery(proofs) { return recover(proofs); },
    recoverLegacy(proofs, approvedDigest) {
      if (typeof approvedDigest !== 'string') return Promise.reject(new Error('Legacy recovery requires explicit review approval'));
      return recover(proofs, approvedDigest);
    },
    size() { storage.read(); return spends.size; },
    get(spend) { storage.read(); const row = spends.get(spend); return row ? { ...row } : undefined; },
    isRetired(issuerKey) { return storage.read().retiredIssuerKeys.includes(issuerKey) || isArchivedAdmissionKey(policy, issuerKey); },
    write(row) {
      writable();
      const state = storage.read(), previous = spends.get(row.spend);
      if (!fields(row, ['issuerKey','spend','action','binding']) || !validSpend(row)) throw new Error('Invalid admission spend record');
      if (!known.has(row.issuerKey) || isArchivedAdmissionKey(policy, row.issuerKey) || state.retiredIssuerKeys.includes(row.issuerKey)) throw new Error('Admission issuer key is permanently retired or unknown');
      if (previous && (previous.action !== row.action || previous.binding !== row.binding || (previous.issuerKey !== null && previous.issuerKey !== row.issuerKey))) {
        throw new Error('Conflicting admission spend');
      }
      if (previous?.issuerKey === row.issuerKey) return;
      if (!previous && spends.size >= limit) throw new Error('Admission spend history is full');
      const next = new Map(spends); next.set(row.spend, { ...row });
      storage.write({ ...state, spends: [...next.values()] });
      spends.set(row.spend, { ...row });
    },
    planRetirement,
    retire(issuerKey, approvedDigest) {
      writable();
      const plan = planRetirement(issuerKey);
      if (approvedDigest !== plan.approvalDigest) throw new Error('Admission history changed or approval does not match; review retirement again');
      const state = storage.read(), retained = state.spends.filter(row => row.issuerKey !== issuerKey);
      storage.write({ ...state, spends: retained, retiredIssuerKeys: [...state.retiredIssuerKeys, issuerKey].sort() });
      spends.clear(); for (const row of retained) spends.set(row.spend, row);
      return plan;
    },
    close() { storage.close(); },
  };
}
