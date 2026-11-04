import { AsyncLocalStorage } from 'node:async_hooks';
import { SUSTAINABLE_RECOVERY_LIMITS } from './sustainable-recovery-manifest.js';

export type RecoveryWorkCategory = 'L' | 'D' | 'V' | 'H' | 'J';
export type RecoveryWorkMechanism = 'serialize' | 'parse' | 'clone' | 'copy' | 'concat'
  | 'base64' | 'encrypt' | 'decrypt' | 'disk-read' | 'disk-write' | 'allocate' | 'legacy' | 'other';
export interface RecoveryWorkUsage {
  usedBytes: number;
  maximumBytes: number | null;
  diagnosticUnbounded?: true;
  categories: Record<RecoveryWorkCategory, number>;
  mechanisms: Record<RecoveryWorkMechanism, number>;
}
interface RecoveryWorkBudget extends Omit<RecoveryWorkUsage, 'diagnosticUnbounded'> { diagnosticUnbounded: boolean }

const scopes = new AsyncLocalStorage<RecoveryWorkBudget>();
const categories: RecoveryWorkCategory[] = ['L', 'D', 'V', 'H', 'J'];
const mechanisms: RecoveryWorkMechanism[] = [
  'serialize', 'parse', 'clone', 'copy', 'concat', 'base64',
  'encrypt', 'decrypt', 'disk-read', 'disk-write', 'allocate', 'legacy', 'other',
];

function withRecoveryWork<T>(maximumBytes: number | null, diagnosticUnbounded: boolean, operation: () => T, onComplete?: (usage: RecoveryWorkUsage) => void): T {
  if (scopes.getStore()) return operation();
  const budget: RecoveryWorkBudget = {
    usedBytes: 0,
    maximumBytes,
    diagnosticUnbounded,
    categories: { L: 0, D: 0, V: 0, H: 0, J: 0 },
    mechanisms: {
      serialize: 0, parse: 0, clone: 0, copy: 0, concat: 0, base64: 0,
      encrypt: 0, decrypt: 0, 'disk-read': 0, 'disk-write': 0, allocate: 0, legacy: 0, other: 0,
    },
  };
  const complete = () => onComplete?.(structuredClone({
    usedBytes: budget.usedBytes,
    maximumBytes: budget.maximumBytes,
    ...(diagnosticUnbounded ? { diagnosticUnbounded: true as const } : {}),
    categories: budget.categories,
    mechanisms: budget.mechanisms,
  }));
  try {
    const result = scopes.run(budget, operation);
    if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
      return (result as unknown as Promise<unknown>).then(value => {
        complete(); return value;
      }, error => {
        complete(); throw error;
      }) as T;
    }
    complete(); return result;
  } catch (error) {
    complete(); throw error;
  }
}

export function withSustainableRecoveryWork<T>(
  maximumBytes: number,
  operation: () => T,
  onComplete?: (usage: RecoveryWorkUsage) => void,
): T {
  if (!scopes.getStore() && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || maximumBytes > SUSTAINABLE_RECOVERY_LIMITS.work)) throw new Error('Invalid recovery work capacity');
  return withRecoveryWork(maximumBytes, false, operation, onComplete);
}

export function withDiagnosticUnboundedRecoveryWork<T>(operation: () => T, onComplete?: (usage: RecoveryWorkUsage) => void): T {
  return withRecoveryWork(null, true, operation, onComplete);
}

export function chargeSustainableRecoveryWork(
  bytes: number,
  category: RecoveryWorkCategory = 'L',
  mechanism: RecoveryWorkMechanism = 'other',
): void {
  const budget = scopes.getStore();
  if (!budget) throw new Error('Recovery work operation is not scoped');
  if (!categories.includes(category) || !mechanisms.includes(mechanism)
    || !Number.isSafeInteger(bytes) || bytes < 0
    || budget.maximumBytes !== null && bytes > budget.maximumBytes - budget.usedBytes) throw new Error('Recovery cumulative work exhausted');
  budget.usedBytes += bytes;
  budget.categories[category] += bytes;
  budget.mechanisms[mechanism] += bytes;
}

export function sustainableRecoveryWorkUsage(): RecoveryWorkUsage | undefined {
  const budget = scopes.getStore();
  return budget ? structuredClone({
    usedBytes: budget.usedBytes,
    maximumBytes: budget.maximumBytes,
    ...(budget.diagnosticUnbounded ? { diagnosticUnbounded: true as const } : {}),
    categories: budget.categories,
    mechanisms: budget.mechanisms,
  }) : undefined;
}

export function sustainableRecoveryJson(value: unknown, category: RecoveryWorkCategory = 'L'): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Recovery value is not JSON serializable');
  chargeSustainableRecoveryWork(Buffer.byteLength(text), category, 'serialize');
  const bytes = Buffer.from(text);
  chargeSustainableRecoveryWork(bytes.length, category, 'serialize');
  return bytes;
}

export function sustainableRecoveryParse(bytes: string | Uint8Array, category: RecoveryWorkCategory = 'L'): unknown {
  const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  chargeSustainableRecoveryWork(length, category, 'parse');
  let text: string;
  if (typeof bytes === 'string') text = bytes;
  else {
    const copy = Buffer.from(bytes);
    chargeSustainableRecoveryWork(copy.length, category, 'parse');
    text = copy.toString();
    chargeSustainableRecoveryWork(length, category, 'parse');
  }
  const result = JSON.parse(text);
  chargeSustainableRecoveryWork(length, category, 'parse');
  return result;
}

export function sustainableRecoveryClone<T>(value: T, category: RecoveryWorkCategory = 'L'): T {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Recovery value is not JSON serializable');
  const bytes = Buffer.byteLength(text);
  chargeSustainableRecoveryWork(bytes, category, 'clone');
  const clone = structuredClone(value);
  chargeSustainableRecoveryWork(bytes, category, 'clone');
  return clone;
}

export function sustainableRecoveryBytes(
  value: string | Uint8Array,
  encoding?: BufferEncoding,
  category: RecoveryWorkCategory = 'L',
  mechanism: RecoveryWorkMechanism = 'copy',
): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, encoding) : Buffer.from(value);
  chargeSustainableRecoveryWork(bytes.length, category, mechanism);
  return bytes;
}

export function sustainableRecoveryView(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function sustainableRecoveryConcat(
  values: readonly Uint8Array[],
  category: RecoveryWorkCategory = 'L',
  mechanism: RecoveryWorkMechanism = 'concat',
): Buffer {
  const bytes = Buffer.concat(values);
  chargeSustainableRecoveryWork(bytes.length, category, mechanism);
  return bytes;
}
