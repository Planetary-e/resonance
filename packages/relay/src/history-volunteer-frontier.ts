/** Local authoritative ancestor-retirement boundary. The volunteer service must
 * validate its selected store before cleanup. No network request writes this file. */
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, rmSync, rmdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState, inspectLocalStateOwnership, isLocalStateOwnershipName } from '@resonance/core/local-state';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';
import { historyCheckpointContextId, historyDigest, HISTORY_ENVELOPE_MAX_BYTES, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { parseHistoryCompactionRetention, type HistoryCompactionRetention } from '@resonance/core/history-compaction-retention';

export const HISTORY_VOLUNTEER_FRONTIER_FILENAME = 'history-volunteer-frontier.json';
const MAX_BYTES = 128 * 1024, DOMAIN = 'resonance:history-volunteer-frontier:v1';
const slot = /^successors-[a-f0-9]{64}$/;
export interface HistoryVolunteerFrontier {
  version: 1; contextId: string; genesisId: string; replica: string;
  retention: HistoryCompactionRetention; selectedPath: string; retiredSlots: string[];
}
function exists(path: string) {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function isHistoryVolunteerFrontierFile(name: string) {
  return name === HISTORY_VOLUNTEER_FRONTIER_FILENAME || isLocalStateOwnershipName(HISTORY_VOLUNTEER_FRONTIER_FILENAME, name)
    || /^\.history-volunteer-frontier\.json\.[a-f0-9]{16}\.tmp$/.test(name);
}
export function openHistoryVolunteerFrontier(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; genesisId: string; replica: string;
}) {
  const path = join(options.directory, HISTORY_VOLUNTEER_FRONTIER_FILENAME), contextId = historyCheckpointContextId(options.context);
  const validate = (value: unknown): value is HistoryVolunteerFrontier => {
    if (!exactWitnessFields(value, ['version', 'contextId', 'genesisId', 'replica', 'retention', 'selectedPath', 'retiredSlots'])
      || value.version !== 1 || value.contextId !== contextId || value.genesisId !== options.genesisId || value.replica !== options.replica
      || typeof value.selectedPath !== 'string' || !Array.isArray(value.retiredSlots) || value.retiredSlots.length > 65) return false;
    try {
      const retained = parseHistoryCompactionRetention(value.retention, options.context, options.genesisId), p = retained.certificate.proposal;
      if (p.generation === 0) return false;
      const selected = value.selectedPath.split('/');
      if (selected.length !== 2 || !slot.test(selected[0])
        || ![`generation-${p.rootId.slice(7)}`, `.creating-${p.rootId.slice(7)}`].includes(selected[1])) return false;
      return value.retiredSlots.every((name, i, names) => typeof name === 'string' && slot.test(name)
        && name !== selected[0] && name !== `successors-${p.rootId.slice(7)}` && (!i || names[i - 1] < name));
    } catch { return false; }
  };
  let storage: ReturnType<typeof openEncryptedLocalState<HistoryVolunteerFrontier>> | undefined, closed = false, failed = false;
  const reserve = () => reserveManagedStorage({ path, component: 'encrypted-local-state', scope: 'file', maximumBytes: 2 * MAX_BYTES + 8192 });
  if (exists(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Volunteer frontier must be a bounded ordinary file');
    reserve();
    storage = openEncryptedLocalState({ path, key: options.localKey, domain: DOMAIN, maxBytes: MAX_BYTES,
      initial: null as unknown as HistoryVolunteerFrontier, validate, mode: 'open-existing' });
  }
  function live() { if (closed || failed) throw new Error('History volunteer frontier must be reopened'); }
  return {
    read() { live(); return storage?.read() ?? null; },
    retain(value: HistoryVolunteerFrontier) {
      live(); if (!validate(value)) throw new Error('Invalid history volunteer frontier selection');
      const previous = storage?.read(), p = value.retention.certificate.proposal, old = previous?.retention.certificate.proposal;
      if (old && (p.generation <= old.generation || value.selectedPath === previous!.selectedPath)) {
        throw new Error('History volunteer frontier must advance to a later generation');
      }
      reserve();
      try {
        if (storage) storage.write(value);
        else storage = openEncryptedLocalState({ path, key: options.localKey, domain: DOMAIN, maxBytes: MAX_BYTES,
          initial: value, validate, mode: 'create-new' });
      } catch (error) { failed = true; throw error; }
    },
    close() { if (!closed) { closed = true; storage?.close(); } },
  };
}

/** Inspect every target before removing any file. Known metadata and payload
 * names only; no recursion through arbitrary paths, symlinks or linked files. */
export function inspectHistoryRetiredGenerations(directory: string, names: readonly string[]) {
  const files: Array<{ path: string; bytes: number; identity: string; control: boolean }> = [], directories: string[] = [];
  const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  function control(path: string) {
    const inspected = inspectLocalStateOwnership(path); directories.push(...inspected.directories);
    for (const file of inspected.files) files.push({ path: file.path, bytes: file.bytes, identity: identity(file.stat), control: true });
  }
  for (const name of names) {
    if (!slot.test(name)) throw new Error('Invalid retired generation directory');
    const base = join(directory, name); if (!exists(base)) continue;
    if (!lstatSync(base).isDirectory()) throw new Error('Retired generation must be an ordinary directory');
    const top = readdirSync(base).sort(); if (top.length > 16) throw new Error('Unexpected retired provision contents');
    directories.push(base);
    function add(path: string, maximum: number, control = false) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error('Retired generation contains nonordinary or oversized files');
      files.push({ path, bytes: stat.size, identity: identity(stat), control });
    }
    for (const entry of top) {
      const path = join(base, entry);
      if (isLocalStateOwnershipName('history-provision.json', entry)) { control(path); continue; }
      if (/^(?:history-provision\.json(?:\.(?:lock|recovery))?|\.history-provision\.json\.[a-f0-9]{16}\.tmp)$/.test(entry)) {
        add(path, 128 * 1024, /\.(?:lock|recovery)$/.test(entry)); continue;
      }
      if (!/^(?:generation-|\.creating-)[a-f0-9]{64}$/.test(entry) || !lstatSync(path).isDirectory()) throw new Error('Unexpected retired generation directory');
      const contents = readdirSync(path).sort(); if (contents.length > 10020) throw new Error('Retired generation exceeds its file bound');
      directories.push(path);
      for (const file of contents) {
        if (isLocalStateOwnershipName('history-manifest.json', file)) control(join(path, file));
        else if (/^(?:[a-f0-9]{64}\.block|\.block-[a-f0-9]{32}\.tmp)$/.test(file)) add(join(path, file), HISTORY_ENVELOPE_MAX_BYTES);
        else if (/^(?:history-manifest\.json(?:\.(?:lock|recovery))?|\.history-manifest\.json\.[a-f0-9]{16}\.tmp)$/.test(file)) {
          add(join(path, file), 2 * 1024 * 1024 + 8192, /\.(?:lock|recovery)$/.test(file));
        } else throw new Error('Unexpected retired generation file');
      }
    }
  }
  const content = files.filter(f => !f.control);
  return { files, directories, filesRemoved: content.length, bytesReclaimed: content.reduce((sum, f) => sum + f.bytes, 0),
    digest: historyDigest(JSON.stringify(content)) };
}
/** Call only after validating the selected frontier store. The durable local
 * journal already authorizes the exact retired directories and survives unlink. */
export function cleanHistoryRetiredGenerations(directory: string, state: HistoryVolunteerFrontier) {
  const inspected = inspectHistoryRetiredGenerations(directory, state.retiredSlots);
  for (const file of inspected.files) rmSync(file.path);
  for (const path of inspected.directories.reverse()) rmdirSync(path);
  if (inspected.directories.length && process.platform !== 'win32') {
    const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return inspected;
}
