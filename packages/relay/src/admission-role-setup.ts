/** Fresh keys remain sealed until an intact role is captured on four volunteers.
 * A prepared role is never recreated, even if its local history disappears. */
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateSigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from '@resonance/core/admission-witness';
import { historyDigest } from '@resonance/core/history-checkpoint';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { captureStorageReservationOperation, reserveManagedStorage } from '@resonance/core/storage-reservations';
import { canonicalHistorySetupPath, historySetupContains } from './admission-history-setup.js';
import { readOperatorFile, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';
import { openAdmissionRoleCapture } from './admission-role-capture.js';
import type { openProtectedAdmissionSpendHistory } from './protected-admission-history.js';

type Role = 'witness' | 'coordinator';
interface Preparation { version: 1; kind: 'fresh-admission-role'; role: Role; phase: 'preparing' | 'prepared'; publicKey: string; secretKey: string }
const preparationName = 'admission-role-preparation.json', preparationMaximum = 4096;
function present(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function roleSpec(role: Role) {
  if (role !== 'witness' && role !== 'coordinator') throw new Error('Select one explicit new admission role');
  return role === 'witness'
    ? { name: 'admission-witness-votes.json', domain: 'resonance:admission-witness-votes:v1', maximum: 16 * 1024 * 1024 }
    : { name: 'admission-witness-certificates.json', domain: 'resonance:admission-witness-certificates:v1', maximum: 32 * 1024 * 1024 };
}
function ordinary(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Role setup requires an ordinary retained file');
}
function newOutput(path: string) {
  if (present(path)) throw new Error('Role output already exists; retain it and choose a new output path');
  if (!lstatSync(dirname(path)).isDirectory()) throw new Error('Role output needs an existing parent directory');
}
function openPreparation(directory: string, key: Uint8Array, role: Role, initial?: Preparation) {
  const path = join(directory, preparationName);
  if (!initial) ordinary(path);
  return openEncryptedLocalState<Preparation>({ path, key, domain: 'resonance:fresh-admission-role:v1', maxBytes: preparationMaximum,
    mode: initial ? 'create-new' : 'open-existing', initial: initial!,
    validate(value): value is Preparation {
      if (!exactWitnessFields(value, ['version', 'kind', 'role', 'phase', 'publicKey', 'secretKey']) || value.version !== 1
        || value.kind !== 'fresh-admission-role' || value.role !== role || !['preparing', 'prepared'].includes(value.phase as string)
        || !witnessBytes(value.publicKey, 32) || !witnessBytes(value.secretKey, 64)) return false;
      const secret = Buffer.from(value.secretKey as string, 'base64url');
      try { const copy = copyAdmissionSigningKey({ publicKey: Buffer.from(value.publicKey as string, 'base64url'), secretKey: secret }); copy.secretKey.fill(0); return true; }
      catch { return false; } finally { secret.fill(0); }
    } });
}
function emptyRole(role: Role, publicKey: string) {
  return role === 'witness' ? { version: 2, witness: publicKey, votes: [], retiredIssuerKeys: [] }
    : { version: 2, coordinator: publicKey, certificates: [], retiredIssuerKeys: [] };
}
function openEmptyRole(directory: string, key: Uint8Array, state: Preparation, initialize: boolean) {
  const spec = roleSpec(state.role), path = join(directory, spec.name), expected = emptyRole(state.role, state.publicKey);
  if (!initialize) ordinary(path);
  return openEncryptedLocalState({ path, key, domain: spec.domain, maxBytes: spec.maximum, mode: initialize ? 'create-new' : 'open-existing', initial: expected,
    validate(value): value is typeof expected {
      return exactWitnessFields(value, Object.keys(expected)) && value.version === 2
        && (state.role === 'witness' ? value.witness === state.publicKey && Array.isArray(value.votes) && value.votes.length === 0
          : value.coordinator === state.publicKey && Array.isArray(value.certificates) && value.certificates.length === 0)
        && Array.isArray(value.retiredIssuerKeys) && value.retiredIssuerKeys.length === 0;
    } });
}

export interface AdmissionRoleSetupInput { mode: 'new' | 'resume'; selection: Role; storageKeyFile: string; directory: string; output: string }
export function openAdmissionRoleSetup(input: AdmissionRoleSetupInput, signal?: AbortSignal) {
  const retainedScope = captureStorageReservationOperation();
  if (!['new', 'resume'].includes(input.mode)) throw new Error('Select new or resume role preparation');
  const spec = roleSpec(input.selection), directory = canonicalHistorySetupPath(input.directory), output = canonicalHistorySetupPath(input.output);
  if (historySetupContains(directory, output) || historySetupContains(directory, canonicalHistorySetupPath(input.storageKeyFile))) throw new Error('Keep role setup inputs and outputs outside its dedicated directory');
  newOutput(output);
  if (input.mode === 'new' && present(directory)) throw new Error('New role creation requires a new directory and generates a new key');
  if (!lstatSync(dirname(directory)).isDirectory()) throw new Error('Role setup needs an existing parent directory');
  const bytes = readOperatorFile(input.storageKeyFile, 128), source = historyDigest(bytes); bytes.fill(0);
  const key = readOperatorStorageKey(input.storageKeyFile);
  let journal: ReturnType<typeof openPreparation> | undefined, local: ReturnType<typeof openEmptyRole> | undefined, closed = false, applied = false;
  function close() {
    if (closed) return; closed = true;
    try { local?.close(); } finally {
      try { if (journal) { try { journal.read().secretKey = ''; } catch {} journal.close(); } } finally { key.fill(0); }
    }
  }
  const check = () => {
    signal?.throwIfAborted(); if (closed) throw new Error('Role preparation is closed');
    const current = readOperatorFile(input.storageKeyFile, 128);
    try {
      if (directory !== canonicalHistorySetupPath(input.directory) || output !== canonicalHistorySetupPath(input.output) || historyDigest(current) !== source) throw new Error('Role setup selection changed; review again');
    } finally { current.fill(0); }
    newOutput(output);
  };
  try {
    check();
    if (input.mode === 'resume') {
      journal = openPreparation(directory, key, input.selection);
      const state = journal.read();
      if (present(join(directory, spec.name))) local = openEmptyRole(directory, key, state, false);
      else if (state.phase !== 'preparing') throw new Error('Prepared role history is missing; recover it without resetting the key');
    }
    const state = journal?.read();
    const details = { kind: 'fresh-admission-role-setup' as const, mode: input.mode, selection: input.selection, directory, output,
      publicKey: state?.publicKey ?? null, phase: state?.phase ?? 'new', secretKeyExported: false as const };
    const review = { ...details, approvalDigest: historyDigest(`resonance:fresh-admission-role-review:v1\n${JSON.stringify([details, source])}`) };
    return { review, close, apply: (approved: string) => retainedScope(() => {
      check(); if (applied || approved !== review.approvalDigest) throw new Error('Role setup approval changed or was already applied');
      // Fund all outputs before generating a usable identity or publishing any state.
      for (const [name, maximum] of [[preparationName, preparationMaximum], [spec.name, spec.maximum]] as const)
        reserveManagedStorage({ path: join(directory, name), component: 'encrypted-local-state', scope: 'file', maximumBytes: maximum * 2 + 8192 })?.assertWritable();
      reserveManagedStorage({ path: output, component: 'operator-output', scope: 'file', maximumBytes: 4096 })?.assertWritable();
      if (input.mode === 'new') {
        if (present(directory)) throw new Error('New role directory appeared; review again');
        mkdirSync(directory, { mode: 0o700 });
        const pair = generateSigningKeyPair();
        try { journal = openPreparation(directory, key, input.selection, { version: 1, kind: 'fresh-admission-role', role: input.selection, phase: 'preparing',
          publicKey: Buffer.from(pair.publicKey).toString('base64url'), secretKey: Buffer.from(pair.secretKey).toString('base64url') }); }
        finally { pair.secretKey.fill(0); }
      }
      const retained = journal!.read();
      if (!local) {
        if (retained.phase !== 'preparing') throw new Error('Prepared role history cannot be reinitialized');
        local = openEmptyRole(directory, key, retained, true);
      }
      if (retained.phase !== 'prepared') journal!.write({ ...retained, phase: 'prepared' });
      check();
      const publicIdentity = { version: 1, kind: 'admission-role-public-key', role: input.selection, publicKey: retained.publicKey };
      writeOperatorJsonNew(output, publicIdentity, 4096); applied = true;
      return { ...details, publicKey: retained.publicKey, phase: 'prepared', result: 'fresh-admission-role-prepared' as const };
    }) };
  } catch (error) { close(); throw error; }
}

export async function openAdmissionRoleKeyExport(options: { directory: string; output: string; selection: Role; encryptionKey: Uint8Array;
  history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>; signal?: AbortSignal }) {
  const retainedScope = captureStorageReservationOperation();
  roleSpec(options.selection);
  const directory = canonicalHistorySetupPath(options.directory), output = canonicalHistorySetupPath(options.output);
  if (historySetupContains(directory, output)) throw new Error('Export the role signing key outside its retained directory');
  newOutput(output); options.signal?.throwIfAborted();
  const journal = openPreparation(directory, options.encryptionKey, options.selection);
  let capture: Awaited<ReturnType<typeof openAdmissionRoleCapture>> | undefined, closed = false, applied = false;
  function close() {
    if (closed) return; closed = true;
    try { capture?.close(); } finally { try { journal.read().secretKey = ''; } catch {} journal.close(); }
  }
  const check = () => {
    options.signal?.throwIfAborted(); if (closed) throw new Error('Role key export is closed');
    if (directory !== canonicalHistorySetupPath(options.directory) || output !== canonicalHistorySetupPath(options.output)) throw new Error('Role export selection changed');
    newOutput(output);
  };
  try {
    const state = journal.read();
    if (state.phase !== 'prepared') throw new Error('Finish fresh role preparation before exporting a signing key');
    const image = options.history.read().image, role = image.version === 2 ? image.roles[options.selection] : null;
    if (!role || ('witness' in role ? role.witness : role.coordinator) !== state.publicKey) throw new Error('Fresh role must be captured in this protected history before key export');
    capture = await openAdmissionRoleCapture({ directory, encryptionKey: options.encryptionKey, roles: [options.selection], history: options.history });
    const inspect = async () => {
      check(); const captured = await capture!.review();
      if (!captured.alreadyCaptured || captured.fencedRoles !== 1) throw new Error('Role key export needs its retained local fence and protected decisions');
      return captured;
    };
    const captured = await inspect();
    const details = { kind: 'protected-admission-role-key-export' as const, selection: options.selection, directory, output, publicKey: state.publicKey, contextId: captured.contextId };
    const digest = (plan: typeof captured) => historyDigest(`resonance:protected-admission-role-key-export:v1\n${JSON.stringify([details, plan.approvalDigest])}`);
    const review = { ...details, approvalDigest: digest(captured) };
    return { review, close, apply: (approved: string) => retainedScope(async () => {
      if (applied || approved !== review.approvalDigest || digest(await inspect()) !== approved) throw new Error('Role export approval changed; review again');
      await options.history.ready();
      if (digest(await inspect()) !== approved) throw new Error('Protected role changed during readiness; review again');
      writeOperatorJsonNew(output, { publicKey: state.publicKey, secretKey: state.secretKey }, 4096); applied = true;
      return { ...details, result: 'protected-admission-role-key-exported' as const, durableCopies: 4 as const };
    }) };
  } catch (error) { close(); throw error; }
}
