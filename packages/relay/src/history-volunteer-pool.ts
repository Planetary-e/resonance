/** Bounded reusable generation locations. Cleanup completion is authoritative:
 * no slot can accept new work while a previous retirement intent is pending. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, rmdirSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState, inspectLocalStateOwnership, isLocalStateOwnershipName } from '@resonance/core/local-state';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyDigest, isHistoryDigest, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { parseHistoryCompactionRetention, type HistoryCompactionRetention } from '@resonance/core/history-compaction-retention';
import { reserveHistoryStorage } from './history-storage-reservation.js';
import { HISTORY_MANIFEST_FILENAME } from './history-checkpoint-store.js';
import { reserveHistoryProvisionJournal } from './history-generation-provisioner.js';
import { HISTORY_VOLUNTEER_FRONTIER_FILENAME, isHistoryVolunteerFrontierFile, inspectHistoryRetiredGenerations } from './history-volunteer-frontier.js';

export const HISTORY_POOL_FILENAME = 'history-volunteer-pool.json';
export const HISTORY_POOL_DIRECTORY = 'history-pool';
export const HISTORY_POOL_JOURNAL_BYTES = 128 * 1024;
export interface HistoryVolunteerPoolState {
  version: 1; contextId: string; genesisId: string; replica: string; slots: number; maxBytes: number; maxBlocks: number;
  phase: 'migrating' | 'ready' | 'retiring'; frontier: HistoryCompactionRetention | null;
  retiredGenerations: number[]; legacySlots: string[];
  /** Present only during a reviewed, same-filesystem relocation of a certified
   * legacy generation. Source and destination must never coexist. */
  migration?: { sourcePath: string; legacyFrontierDigest: string | null };
}
function present(path: string) {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function flush(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function isHistoryPoolFile(name: string) {
  return name === HISTORY_POOL_FILENAME || isLocalStateOwnershipName(HISTORY_POOL_FILENAME, name)
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
  initializeMigration?: { frontier: HistoryCompactionRetention; legacySlots: string[]; sourcePath: string; legacyFrontierDigest: string | null };
}) {
  const path = join(options.directory, HISTORY_POOL_FILENAME), contextId = historyCheckpointContextId(options.context);
  if (!options.context.members.includes(options.replica) || !isHistoryDigest(options.genesisId)
    || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 4 * 1024 * 1024 || options.maxBytes > 256 * 1024 * 1024
    || !Number.isSafeInteger(options.maxBlocks) || options.maxBlocks < 1 || options.maxBlocks > 10001) throw new Error('Invalid history pool enrollment or limits');
  function validate(value: unknown): value is HistoryVolunteerPoolState {
    const migrating = value && typeof value === 'object' && 'migration' in value;
    if (!exactWitnessFields(value, ['version', 'contextId', 'genesisId', 'replica', 'slots', 'maxBytes', 'maxBlocks', 'phase', 'frontier', 'retiredGenerations', 'legacySlots', ...(migrating ? ['migration'] : [])])
      || value.version !== 1 || value.contextId !== contextId || value.genesisId !== options.genesisId || value.replica !== options.replica
      || value.maxBytes !== options.maxBytes || value.maxBlocks !== options.maxBlocks || !Number.isSafeInteger(value.slots)
      || (value.slots as number) < 2 || (value.slots as number) > 64 || !['migrating', 'ready', 'retiring'].includes(value.phase as string)
      || !Array.isArray(value.retiredGenerations) || value.retiredGenerations.length >= (value.slots as number)
      || !Array.isArray(value.legacySlots)) return false;
    try {
      const frontier = value.frontier === null ? null : parseHistoryCompactionRetention(value.frontier, options.context, options.genesisId);
      if (frontier && frontier.certificate.proposal.generation === 0) return false;
      const generation = frontier?.certificate.proposal.generation ?? 0;
      if (value.phase === 'migrating') {
        if (value.retiredGenerations.length) return false;
        if (!frontier) return !migrating && JSON.stringify(value.legacySlots) === JSON.stringify([`successors-${options.genesisId.slice(7)}`]);
        const migration = value.migration;
        if (!exactWitnessFields(migration, ['sourcePath', 'legacyFrontierDigest']) || typeof migration.sourcePath !== 'string'
          || migration.legacyFrontierDigest !== null && !isHistoryDigest(migration.legacyFrontierDigest)) return false;
        const parts = migration.sourcePath.split('/');
        return parts.length === 2 && /^successors-[a-f0-9]{64}$/.test(parts[0])
          && [`generation-${frontier.certificate.proposal.rootId.slice(7)}`, `.creating-${frontier.certificate.proposal.rootId.slice(7)}`].includes(parts[1])
          && value.legacySlots.length <= 65 && value.legacySlots.includes(parts[0])
          && value.legacySlots.includes(`successors-${frontier.certificate.proposal.rootId.slice(7)}`)
          && value.legacySlots.every((name, i, names) => typeof name === 'string' && /^successors-[a-f0-9]{64}$/.test(name) && (!i || names[i - 1] < name));
      }
      if (migrating) return false;
      if (value.legacySlots.length || value.phase === 'ready' && value.retiredGenerations.length || value.phase === 'retiring' && !frontier) return false;
      return value.retiredGenerations.every((g, i, values) => Number.isSafeInteger(g) && g > 0 && g < generation
        && g > generation - (value.slots as number) && (!i || values[i - 1] < g));
    } catch { return false; }
  }
  const initial: HistoryVolunteerPoolState = { version: 1, contextId, genesisId: options.genesisId, replica: options.replica,
    slots: options.initializeSlots!, maxBytes: options.maxBytes, maxBlocks: options.maxBlocks,
    phase: 'migrating', frontier: options.initializeMigration?.frontier ?? null, retiredGenerations: [],
    legacySlots: options.initializeMigration?.legacySlots ?? [`successors-${options.genesisId.slice(7)}`],
    ...(options.initializeMigration ? { migration: { sourcePath: options.initializeMigration.sourcePath, legacyFrontierDigest: options.initializeMigration.legacyFrontierDigest } } : {}) };
  if (options.initializeMigration && options.initializeSlots === undefined) throw new Error('Pool migration requires an explicit new selection');
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
      if (state.migration?.legacyFrontierDigest && readdirSync(options.directory).some(isHistoryVolunteerFrontierFile)) throw new Error('Legacy frontier cleanup is incomplete');
      for (const generation of state.retiredGenerations) {
        const paths = historyPoolPaths(options.directory, state.slots, generation);
        if (present(paths.history) || present(paths.provision) || !lstatSync(paths.base).isDirectory()) throw new Error('History pool cleanup is incomplete');
      }
      const { migration: _, ...ready } = state;
      storage.write({ ...ready, phase: 'ready', legacySlots: [], retiredGenerations: [] });
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
  if (state.phase === 'migrating' && !state.migration) for (const name of state.legacySlots) {
    const path = join(directory, name);
    if (present(path) && readdirSync(path).some(file => !isLocalStateOwnershipName('history-provision.json', file)
      && !/^(?:history-provision\.json(?:\.(?:lock|recovery))?|\.history-provision\.json\.[a-f0-9]{16}\.tmp)$/.test(file))) {
      throw new Error('Genesis pool migration cannot retire unregistered child contents');
    }
  }
  const legacy = inspectHistoryRetiredGenerations(directory, state.legacySlots);
  const files = [...legacy.files], directories = [...legacy.directories];
  const identity = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  function control(path: string) {
    const inspected = inspectLocalStateOwnership(path); directories.push(...inspected.directories);
    for (const file of inspected.files) files.push({ path: file.path, bytes: file.bytes, identity: identity(file.stat), control: true });
  }
  if (state.migration?.legacyFrontierDigest) for (const name of readdirSync(directory).filter(isHistoryVolunteerFrontierFile).sort()) {
    if (isLocalStateOwnershipName(HISTORY_VOLUNTEER_FRONTIER_FILENAME, name)) { control(join(directory, name)); continue; }
    const path = join(directory, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > HISTORY_POOL_JOURNAL_BYTES) throw new Error('Unexpected legacy frontier file');
    files.push({ path, bytes: stat.size, identity: identity(stat), control: /\.(?:lock|recovery)$/.test(name) });
  }
  for (const generation of state.retiredGenerations) {
    const paths = historyPoolPaths(directory, state.slots, generation);
    if (!lstatSync(paths.base).isDirectory() || readdirSync(paths.base).some(name => !['history', 'successor'].includes(name))) throw new Error('Unexpected history pool slot contents');
    for (const [path, provision] of [[paths.history, false], [paths.provision, true]] as const) {
      if (!present(path)) continue;
      if (!lstatSync(path).isDirectory()) throw new Error('Retired pool history must be an ordinary directory');
      const contents = readdirSync(path).sort(); if (contents.length > (provision ? 16 : 10020)) throw new Error('Retired pool file bound exceeded');
      directories.push(path);
      for (const name of contents) {
        if (isLocalStateOwnershipName(provision ? 'history-provision.json' : 'history-manifest.json', name)) { control(join(path, name)); continue; }
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

/** A durable pool selection already names this move. Rename preserves the exact
 * encrypted manifest, payloads and barriers without a second writable history.
 * Refuse cross-filesystem moves, both locations and missing history. No copy or
 * deletion fallback is permitted. Validate again at the destination before cleanup. */
export function relocateHistoryPoolFrontier(directory: string, state: HistoryVolunteerPoolState, validateSource: (path: string) => void) {
  if (!state.migration || !state.frontier || state.phase !== 'migrating') return;
  const source = join(directory, ...state.migration.sourcePath.split('/'));
  const target = historyPoolPaths(directory, state.slots, state.frontier.certificate.proposal.generation).history;
  const old = present(source), moved = present(target);
  if (old === moved) throw new Error('Pool migration requires exactly one retained source or destination');
  if (moved) return; // The service authenticates this existing store before any cleanup.
  if (state.migration.legacyFrontierDigest && !present(join(directory, HISTORY_VOLUNTEER_FRONTIER_FILENAME))) throw new Error('Legacy frontier disappeared before pool relocation');
  inspectHistoryPoolRetirement(directory, state);
  validateSource(source);
  renameSync(source, target); flush(dirname(source)); flush(dirname(target));
}
