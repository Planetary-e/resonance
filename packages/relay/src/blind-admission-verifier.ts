/** Fsynced, single-relay spending boundary for blinded admission tokens.
 * Cross-relay spending requires a separate quorum protocol; this local ledger
 * deliberately makes no global one-use claim during a network partition.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type BlindAdmissionScopeV2,
  verifyBlindAdmissionTokenV2,
} from '@resonance/core';
import type {
  AdmissionCapabilityVerifierV2,
  AdmissionDecisionV2,
  AdmissionVerificationContextV2,
} from './admission.js';

interface SpendRow {
  version: 1;
  spend: string;
  action: string;
  binding: string;
}

const ROW_KEYS = ['action', 'binding', 'spend', 'version'];

export function createLocalBlindAdmissionVerifierV2(options: {
  directory: string;
  scope: BlindAdmissionScopeV2;
  issuerPublicKey: CryptoKey;
  maxSpends?: number;
}): AdmissionCapabilityVerifierV2 & { close(): void } {
  const maxSpends = options.maxSpends ?? 10_000;
  if (!Number.isSafeInteger(maxSpends) || maxSpends < 1) throw new Error('Invalid admission spend capacity');
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const path = join(options.directory, 'admission-spends-v2.jsonl');
  const spends = new Map<string, string>();
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    if (bytes.length > maxSpends * 512 || (bytes.length && bytes.at(-1) !== 10)) {
      throw new Error('Admission spend log is incomplete or exceeds capacity');
    }
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { throw new Error('Admission spend log is corrupt'); }
      if (!isSpendRow(row) || spends.has(row.spend)) throw new Error('Admission spend log is corrupt');
      spends.set(row.spend, `${row.action}\n${row.binding}`);
    }
    if (spends.size > maxSpends) throw new Error('Admission spend capacity exceeded');
  }
  const newFile = !existsSync(path);
  const fd = openSync(path, 'a', 0o600);
  if (newFile) {
    const directoryFd = openSync(options.directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  let closed = false;
  let poisoned = false;
  return {
    async verifyAndSpend(capability, context): Promise<AdmissionDecisionV2> {
      if (closed || poisoned) throw new Error('Admission spend log is unavailable');
      const spend = await verifyBlindAdmissionTokenV2(
        capability, options.scope, context.action, context.requestBinding, options.issuerPublicKey,
      );
      if (!spend) return { status: 'rejected', reason: 'invalid_token' };
      return recordSpend(spend, context);
    },
    close() {
      if (!closed) { closed = true; closeSync(fd); }
    },
  };

  function recordSpend(spend: string, context: AdmissionVerificationContextV2): AdmissionDecisionV2 {
    const binding = `${context.action}\n${context.requestBinding}`;
    const previous = spends.get(spend);
    if (previous !== undefined) {
      return previous === binding
        ? { status: 'replay' }
        : { status: 'rejected', reason: 'double_spend' };
    }
    if (spends.size >= maxSpends) return { status: 'rejected', reason: 'capacity_exhausted' };
    const row: SpendRow = { version: 1, spend, action: context.action, binding: context.requestBinding };
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    if (bytes.length > 512) throw new Error('Admission spend row exceeds capacity');
    poisoned = true;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Admission spend log write failed');
      offset += written;
    }
    fsyncSync(fd);
    spends.set(spend, binding);
    poisoned = false;
    return { status: 'accepted' };
  }
}

function isSpendRow(value: unknown): value is SpendRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === ROW_KEYS.join(',')
    && row.version === 1
    && typeof row.spend === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row.spend)
    && typeof row.action === 'string' && row.action.length <= 32
    && typeof row.binding === 'string' && /^admreq_[A-Za-z0-9_-]{86}$/.test(row.binding);
}
