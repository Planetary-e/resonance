/** Fsynced, single-relay spending boundary for blinded admission tokens.
 * Cross-relay spending requires a separate quorum protocol; this local ledger
 * deliberately makes no global one-use claim during a network partition.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { KeyObject } from 'node:crypto';
import { admissionKeyFingerprint } from '@resonance/core/admission-policy';
import { isLegacyAdmissionSpendRow, type AdmissionSpendLedger, type LegacyAdmissionSpendRow } from './admission-spend-history.js';
import {
  type BlindAdmissionScopeV2,
  verifyBlindAdmissionTokenV2,
} from '@resonance/core';
import type {
  AdmissionCapabilityVerifierV2,
  AdmissionDecisionV2,
  AdmissionVerificationContextV2,
} from './admission.js';

export function createLocalBlindAdmissionVerifierV2(options: {
  directory: string;
  scope?: BlindAdmissionScopeV2;
  issuerPublicKey?: CryptoKey;
  keyPolicies?: () => Array<{ scope: BlindAdmissionScopeV2; issuerPublicKey: CryptoKey; mode: 'all' | 'replay-only' | 'none' }>;
  /** Persist a quorum certificate before the local spend can be accepted. */
  beforeSpend?: (spend: string, context: AdmissionVerificationContextV2, issuerPublicKey: CryptoKey) => Promise<void>;
  maxSpends?: number;
  /** Configured relays use an encrypted, key-attributed ledger. Omit only for legacy manual configuration. */
  history?: AdmissionSpendLedger;
}): AdmissionCapabilityVerifierV2 & { close(): void } {
  if (!options.keyPolicies && (!options.scope || !options.issuerPublicKey)) throw new Error('Admission verification requires a key policy');
  const maxSpends = options.maxSpends ?? 10_000;
  if (!Number.isSafeInteger(maxSpends) || maxSpends < 1) throw new Error('Invalid admission spend capacity');
  const history = options.history ?? openLegacySpendLog(options.directory, maxSpends);
  const fingerprints = new WeakMap<CryptoKey, string>();
  function fingerprint(key: CryptoKey): string {
    let id = fingerprints.get(key);
    if (!id) { id = admissionKeyFingerprint(KeyObject.from(key).export({ type: 'spki', format: 'pem' }).toString()); fingerprints.set(key, id); }
    return id;
  }
  let closed = false;
  return {
    async verifyAndSpend(capability, context): Promise<AdmissionDecisionV2> {
      if (closed) throw new Error('Admission spend log is unavailable');
      history.size();
      const policy = () => options.keyPolicies ? options.keyPolicies() : [{ scope: options.scope!, issuerPublicKey: options.issuerPublicKey!, mode: 'all' as const }];
      for (const entry of policy()) {
        if (entry.mode === 'none') continue;
        const spend = await verifyBlindAdmissionTokenV2(capability, entry.scope, context.action, context.requestBinding, entry.issuerPublicKey);
        if (!spend) continue;
        if (closed) throw new Error('Admission spend log is unavailable');
        history.size();
        // Re-evaluate dates after asynchronous crypto; crossing a cutoff must not accept new work.
        const current = policy().find(key => key.issuerPublicKey === entry.issuerPublicKey);
        if (!current || current.mode === 'none') return { status: 'rejected', reason: 'key_retired' };
        const issuerKey = fingerprint(entry.issuerPublicKey);
        if (history.isRetired(issuerKey)) return { status: 'rejected', reason: 'key_retired' };
        const previous = history.get(spend);
        if (previous !== undefined && (previous.action !== context.action || previous.binding !== context.requestBinding)) return { status: 'rejected', reason: 'double_spend' };
        if (previous === undefined && current.mode === 'replay-only') return { status: 'rejected', reason: 'key_retired' };
        if (options.beforeSpend) await options.beforeSpend(spend, context, entry.issuerPublicKey);
        if (closed) throw new Error('Admission spend log is unavailable');
        history.size();
        const final = policy().find(key => key.issuerPublicKey === entry.issuerPublicKey);
        if (!final || final.mode === 'none') return { status: 'rejected', reason: 'key_retired' };
        return recordSpend(spend, context, final.mode, issuerKey);
      }
      return { status: 'rejected', reason: 'invalid_token' };
    },
    close() {
      if (!closed) { closed = true; history.close(); }
    },
  };

  function recordSpend(spend: string, context: AdmissionVerificationContextV2, mode: 'all' | 'replay-only', issuerKey: string): AdmissionDecisionV2 {
    // Recheck after the asynchronous quorum hook, including exact retries and legacy attribution.
    if (history.isRetired(issuerKey)) return { status: 'rejected', reason: 'key_retired' };
    const previous = history.get(spend);
    const row = { spend, action: context.action, binding: context.requestBinding, issuerKey };
    if (previous !== undefined) {
      if (previous.action !== row.action || previous.binding !== row.binding) return { status: 'rejected', reason: 'double_spend' };
      if (previous.issuerKey === null) history.write(row);
      return { status: 'replay' };
    }
    if (mode === 'replay-only') return { status: 'rejected', reason: 'key_retired' };
    if (history.size() >= maxSpends) return { status: 'rejected', reason: 'capacity_exhausted' };
    history.write(row);
    return { status: 'accepted' };
  }
}

/** Compatibility for the manual, single-key mode; it cannot compact or retire history. */
function openLegacySpendLog(directory: string, maxSpends: number): AdmissionSpendLedger {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'admission-spends-v2.jsonl');
  const spends = new Map<string, LegacyAdmissionSpendRow>();
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    if (bytes.length > maxSpends * 512 || (bytes.length && bytes.at(-1) !== 10)) {
      throw new Error('Admission spend log is incomplete or exceeds capacity');
    }
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { throw new Error('Admission spend log is corrupt'); }
      if (!isLegacyAdmissionSpendRow(row) || spends.has(row.spend)) throw new Error('Admission spend log is corrupt');
      spends.set(row.spend, row);
    }
    if (spends.size > maxSpends) throw new Error('Admission spend capacity exceeded');
  }
  const newFile = !existsSync(path);
  const fd = openSync(path, 'a', 0o600);
  if (newFile) {
    const directoryFd = openSync(directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  let closed = false, poisoned = false;
  function ensureOpen() { if (closed || poisoned) throw new Error('Admission spend log is unavailable'); }
  return {
    size() { ensureOpen(); return spends.size; },
    get(spend) {
      ensureOpen(); const previous = spends.get(spend); if (previous === undefined) return undefined;
      return { spend, action: previous.action, binding: previous.binding, issuerKey: null };
    },
    isRetired() { ensureOpen(); return false; },
    write(value) {
      ensureOpen();
      if (spends.has(value.spend)) return;
      const row: LegacyAdmissionSpendRow = { version: 1, spend: value.spend, action: value.action, binding: value.binding };
      const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
      if (bytes.length > 512) throw new Error('Admission spend row exceeds capacity');
      poisoned = true;
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('Admission spend log write failed');
        offset += written;
      }
      fsyncSync(fd); spends.set(row.spend, row); poisoned = false;
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}
