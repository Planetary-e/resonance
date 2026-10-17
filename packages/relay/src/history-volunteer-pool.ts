/** Bounded reusable generation locations. Cleanup completion is authoritative:
 * no slot can accept new work while a previous retirement intent is pending. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, rmdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyDigest, isHistoryDigest, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { parseHistoryCompactionRetention, type HistoryCompactionRetention } from '@resonance/core/history-compaction-retention';
import { reserveHistoryStorage } from './history-storage-reservation.js';
import { HISTORY_MANIFEST_FILENAME } from './history-checkpoint-store.js';
import { reserveHistoryProvisionJournal } from './history-generation-provisioner.js';
import { inspectHistoryRetiredGenerations } from './history-volunteer-frontier.js';

export const HISTORY_POOL_FILENAME = 'history-volunteer-pool.json';
export const HISTORY_POOL_DIRECTORY = 'history-pool';
export const HISTORY_POOL_JOURNAL_BYTES = 128 * 1024;
export interface HistoryVolunteerPoolState {
  version: 1; contextId: string; genesisId: string; replica: string; slots: number; maxBytes: number; maxBlocks: number;
  phase: 'migrating' | 'ready' | 'retiring'; frontier: HistoryCompactionRetention | null;
  retiredGenerations: number[]; legacySlots: string[];
}
function present(path: string) {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function flush(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function isHistoryPoolFile(name: string) {
  return name === HISTORY_POOL_FILENAME || name === `${HISTORY_POOL_FILENAME}.lock` || name === `${HISTORY_POOL_FILENAME}.recovery`
    || /^\.history-volunteer-pool\.json\.[a-f0-9]{16}\.tmp$/.test(name);
}
export function historyPoolSlot(generation: number, slots: number) {
  if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(slots) || slots < 2 || slots > 64) throw new Error('Invalid history pool position');
  return (generation - 1) % slots;
}
export function historyPoolPaths(directory: string, slots: number, generation: number) {
  const base = generation === 0 ? join(directory, HISTORY_POOL_DIRECTORY) : join(directory, HISTORY_POOL_DIRECTORY, `slot-${historyPoolSlot(generation, slots)}`);
  return { base, history: generation === 0 ? join(directory, 'genesis') : join(base, 'history'),
    provision: join(base, generation === 0 ? 'genesis-successor' : 'successor') };
}
export function reserveHistoryPool(directory: string, slots: number, maxBytes: number) {
  historyPoolSlot(1, slots);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 4 * 1024 * 1024 || maxBytes > 256 * 1024 * 1024) throw new Error('Invalid history pool byte capacity');
  reserveManagedStorage({ path: join(directory, HISTORY_POOL_FILENAME), component: 'encrypted-local-state', scope: 'file',
    maximumBytes: 2 * HISTORY_POOL_JOURNAL_BYTES + 8192 });
  reserveHistoryProvisionJournal(historyPoolPaths(directory, slots, 0).provision);
  for (let generation = 1; generation <= slots; generation++) {
    const paths = historyPoolPaths(directory, slots, generation);
    reserveHistoryStorage({ directory: paths.history, component: 'history-replica-ciphertext', ciphertextBytes: maxBytes - 4 * 1024 * 1024,
      manifestFilename: HISTORY_MANIFEST_FILENAME, manifestBytes: 2 * 1024 * 1024 });
    reserveHistoryProvisionJournal(paths.provision);
  }
}
export function openHistoryVolunteerPool(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; genesisId: string; replica: string;
  maxBytes: number; maxBlocks: number; initializeSlots?: number;
}) {
  const path = join(options.directory, HISTORY_POOL_FILENAME), contextId = historyCheckpointContextId(options.context);
  if (!options.context.members.includes(options.replica) || !isHistoryDigest(options.genesisId)
    || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 4 * 1024 * 1024 || options.maxBytes > 256 * 1024 * 1024
    || !Number.isSafeInteger(options.maxBlocks) || options.maxBlocks < 1 || options.maxBlocks > 10001) throw new Error('Invalid history pool enrollment or limits');
  function validate(value: unknown): value is HistoryVolunteerPoolState {
    if (!exactWitnessFields(value, ['version', 'contextId', 'genesisId', 'replica', 'slots', 'maxBytes', 'maxBlocks', 'phase', 'frontier', 'retiredGenerations', 'legacySlots'])
      || value.version !== 1 || value.contextId !== contextId || value.genesisId !== options.genesisId || value.replica !== options.replica
      || value.maxBytes !== options.maxBytes || value.maxBlocks !== options.maxBlocks || !Number.isSafeInteger(value.slots)
      || (value.slots as number) < 2 || (value.slots as number) > 64 || !['migrating', 'ready', 'retiring'].includes(value.phase as string)
      || !Array.isArray(value.retiredGenerations) || value.retiredGenerations.length >= (value.slots as number)
      || !Array.isArray(value.legacySlots)) return false;
    try {
      const frontier = value.frontier === null ? null : parseHistoryCompactionRetention(value.frontier, options.context, options.genesisId);
      if (frontier && frontier.certificate.proposal.generation === 0) return false;
      const generation = frontier?.certificate.proposal.generation ?? 0;
      if (value.phase === 'migrating') return frontier === null && value.retiredGenerations.length === 0
        && JSON.stringify(value.legacySlots) === JSON.stringify([`successors-${options.genesisId.slice(7)}`]);
      if (value.legacySlots.length || value.phase === 'ready' && value.retiredGenerations.length || value.phase === 'retiring' && !frontier) return false;
      return value.retiredGenerations.every((g, i, values) => Number.isSafeInteger(g) && g > 0 && g < generation
        && g > generation - (value.slots as number) && (!i || values[i - 1] < g));
    } catch { return false; }
  }
  const initial: HistoryVolunteerPoolState = { version: 1, contextId, genesisId: options.genesisId, replica: options.replica,
    slots: options.initializeSlots!, maxBytes: options.maxBytes, maxBlocks: options.maxBlocks,
    phase: 'migrating', frontier: null, retiredGenerations: [], legacySlots: [`successors-${options.genesisId.slice(7)}`] };
  if (options.initializeSlots !== undefined) {
    if (!validate(initial) || present(path)) throw new Error('Invalid new history pool selection');
    reserveHistoryPool(options.directory, options.initializeSlots, options.maxBytes);
  } else {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > HISTORY_POOL_JOURNAL_BYTES) throw new Error('History pool journal must be a bounded ordinary file');
  }
  const storage = openEncryptedLocalState({ path, key: options.localKey, domain: 'resonance:history-volunteer-pool:v1',
    maxBytes: HISTORY_POOL_JOURNAL_BYTES, initial, validate, mode: options.initializeSlots === undefined ? 'open-existing' : 'create-new' });
  try { reserveHistoryPool(options.directory, storage.read().slots, options.maxBytes); } catch (error) { storage.close(); throw error; }
  return {
    read: storage.read,
    beginRetirement(retention: HistoryCompactionRetention, retiredGenerations: number[]) {
      const state = storage.read(), proof = parseHistoryCompactionRetention(retention, options.context, options.genesisId);
      if (state.phase !== 'ready' || proof.certificate.proposal.generation <= (state.frontier?.certificate.proposal.generation ?? 0)) throw new Error('History pool frontier must advance from completed cleanup');
      const next: HistoryVolunteerPoolState = { ...state, phase: 'retiring', frontier: proof, retiredGenerations: [...retiredGenerations], legacySlots: [] };
      if (!validate(next)) throw new Error('Invalid history pool retirement'); storage.write(next);
    },
    finishCleanup() {
      const state = storage.read(); if (state.phase === 'ready') return;
      for (const name of state.legacySlots) if (present(join(options.directory, name))) throw new Error('Legacy history pool cleanup is incomplete');
      for (const generation of state.retiredGenerations) {
        const paths = historyPoolPaths(options.directory, state.slots, generation);
        if (present(paths.history) || present(paths.provision) || !lstatSync(paths.base).isDirectory()) throw new Error('History pool cleanup is incomplete');
      }
      storage.write({ ...state, phase: 'ready', legacySlots: [], retiredGenerations: [] });
    },
    close: storage.close,
  };
}

export function ensureHistoryPoolDirectories(directory: string, state: HistoryVolunteerPoolState) {
  const root = join(directory, HISTORY_POOL_DIRECTORY), create = state.phase === 'migrating';
  function ensure(path: string, parent: string) {
    if (!present(path)) { if (!create) throw new Error('History pool slot is missing; retain its ownership history'); mkdirSync(path, { mode: 0o700 }); flush(parent); }
    if (!lstatSync(path).isDirectory()) throw new Error('History pool requires ordinary directories');
  }
  ensure(root, directory);
  const allowed = new Set(['genesis-successor']);
  for (let index = 0; index < state.slots; index++) { const name = `slot-${index}`; allowed.add(name); ensure(join(root, name), root); }
  if (readdirSync(root).some(name => !allowed.has(name))) throw new Error('Unregistered history pool contents require inspection');
}

/** Old slot directories remain as fixed parent locations; only their authorized
 * history/provisioning contents are removed. Validate all targets before unlink. */
export function inspectHistoryPoolRetirement(directory: string, state: HistoryVolunteerPoolState) {
  if (state.phase === 'migrating') for (const name of state.legacySlots) {
    const path = join(directory, name);
    if (present(path) && readdirSync(path).some(file => !/^(?:history-provision\.json(?:\.(?:lock|recovery))?|\.history-provision\.json\.[a-f0-9]{16}\.tmp)$/.test(file))) {
      throw new Error('Genesis pool migration cannot retire unregistered child contents');
    }
  }
  const legacy = inspectHistoryRetiredGenerations(directory, state.legacySlots);
  const files = [...legacy.files], directories = [...legacy.directories];
  const identity = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  for (const generation of state.retiredGenerations) {
    const paths = historyPoolPaths(directory, state.slots, generation);
    if (!lstatSync(paths.base).isDirectory() || readdirSync(paths.base).some(name => !['history', 'successor'].includes(name))) throw new Error('Unexpected history pool slot contents');
    for (const [path, provision] of [[paths.history, false], [paths.provision, true]] as const) {
      if (!present(path)) continue;
      if (!lstatSync(path).isDirectory()) throw new Error('Retired pool history must be an ordinary directory');
      const contents = readdirSync(path).sort(); if (contents.length > (provision ? 16 : 10020)) throw new Error('Retired pool file bound exceeded');
      directories.push(path);
      for (const name of contents) {
        const metadata = provision ? /^(?:history-provision\.json(?:\.(?:lock|recovery))?|\.history-provision\.json\.[a-f0-9]{16}\.tmp)$/
          : /^(?:history-manifest\.json(?:\.(?:lock|recovery))?|\.history-manifest\.json\.[a-f0-9]{16}\.tmp)$/;
        const block = !provision && /^(?:[a-f0-9]{64}\.block|\.block-[a-f0-9]{32}\.tmp)$/.test(name), full = join(path, name), stat = lstatSync(full);
        if ((!block && !metadata.test(name)) || !stat.isFile() || stat.nlink !== 1
          || stat.size > (block ? HISTORY_ENVELOPE_MAX_BYTES : provision ? 128 * 1024 : 2 * 1024 * 1024 + 8192)) throw new Error('Unexpected retired pool file');
        files.push({ path: full, bytes: stat.size, identity: identity(stat), control: /\.(?:lock|recovery)$/.test(name) });
      }
    }
  }
  const content = files.filter(f => !f.control);
  return { files, directories, filesRemoved: content.length, bytesReclaimed: content.reduce((sum, f) => sum + f.bytes, 0), digest: historyDigest(JSON.stringify(content)) };
}
export function cleanHistoryPoolRetirement(directory: string, state: HistoryVolunteerPoolState) {
  const inspected = inspectHistoryPoolRetirement(directory, state);
  for (const file of inspected.files) rmSync(file.path);
  for (const path of inspected.directories.reverse()) rmdirSync(path);
  // Persist each reused slot's empty contents before clearing the cleanup intent.
  for (const generation of state.retiredGenerations) flush(historyPoolPaths(directory, state.slots, generation).base);
  flush(directory); return inspected;
}
