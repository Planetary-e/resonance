/** Reviewed same-file promotion of intact local roles. Fence each local writer
 * before a snapshot can become replicated authority; retain its complete capture
 * through interruption. No missing role is initialized by this workflow. */
import { realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { historyCheckpointContextId, historyDigest } from '@resonance/core/history-checkpoint';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { parseAdmissionRoleHistories, assertAdmissionRoleRetention, type AdmissionRoleHistories,
  type AdmissionWitnessHistoryState, type AdmissionCoordinatorHistoryState } from './admission-role-history.js';
import type { openProtectedAdmissionSpendHistory } from './protected-admission-history.js';

type Role = 'witness' | 'coordinator';
type LocalRole = AdmissionWitnessHistoryState | AdmissionCoordinatorHistoryState;
interface Fence { version: 3; kind: 'protected-admission-role'; role: Role; contextId: string; state: LocalRole }
export async function openAdmissionRoleCapture(options: {
  directory: string; encryptionKey: Uint8Array; roles: readonly Role[];
  history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>>;
}) {
  if (!options.roles.length || options.roles.length > 2 || new Set(options.roles).size !== options.roles.length
    || options.roles.some(role => role !== 'witness' && role !== 'coordinator')) throw new Error('Select explicit distinct admission roles');
  const directory = realpathSync(options.directory);
  if (!lstatSync(directory).isDirectory()) throw new Error('Local role capture requires an existing ordinary directory');
  const { history } = options, contextId = historyCheckpointContextId(history.read().context);
  const stores = new Map<Role, ReturnType<typeof openEncryptedLocalState<LocalRole | Fence>>>();
  let closed = false, busy = false;
  const available = () => { if (closed) throw new Error('Admission role capture is closed'); };
  function local(raw: unknown, role: Role): LocalRole {
    const policy = history.read().image.policy;
    let state = raw;
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 3) {
      if (!exactWitnessFields(raw, ['version', 'kind', 'role', 'contextId', 'state'])) throw new Error('Invalid admission role fence');
      const fence = raw as unknown as Fence;
      if (fence.kind !== 'protected-admission-role' || fence.role !== role || fence.contextId !== contextId) throw new Error('Local admission role is fenced to another history');
      state = fence.state;
    }
    if (state && typeof state === 'object' && 'version' in state && state.version === 1) {
      const fields = role === 'witness' ? ['version', 'witness', 'votes'] : ['version', 'coordinator', 'certificates'];
      if (!exactWitnessFields(state, fields)) throw new Error('Invalid legacy admission role state');
      state = { ...state, version: 2, retiredIssuerKeys: [] };
    }
    return parseAdmissionRoleHistories({ witness: null, coordinator: null, [role]: state }, policy)[role]!;
  }
  function close() {
    if (closed) return; closed = true;
    const errors: unknown[] = [];
    for (const store of stores.values()) try { store.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new Error('Admission role capture cleanup failed; retain local state');
  }
  try {
    for (const role of [...options.roles].sort()) {
      const witness = role === 'witness';
      const store = openEncryptedLocalState<LocalRole | Fence>({ path: join(directory, witness ? 'admission-witness-votes.json' : 'admission-witness-certificates.json'),
        key: options.encryptionKey, domain: witness ? 'resonance:admission-witness-votes:v1' : 'resonance:admission-witness-certificates:v1',
        maxBytes: (witness ? 16 : 32) * 1024 * 1024, mode: 'open-existing', initial: null!,
        validate(value): value is LocalRole | Fence { try { local(value, role); return true; } catch { return false; } } });
      stores.set(role, store);
    }
  } catch (error) { close(); throw error; }
  async function plan() {
    available(); const image = history.read().image;
    const roles: AdmissionRoleHistories = image.version === 2 ? structuredClone(image.roles) : { witness: null, coordinator: null };
    for (const [role, store] of stores) {
      const state = local(store.read(), role);
      if (roles[role]) assertAdmissionRoleRetention({ witness: null, coordinator: null, [role]: state }, roles);
      else Object.assign(roles, { [role]: state });
    }
    const capture = await history.planRoleCapture(roles); available();
    const review = { ...capture, kind: 'admission-local-role-capture' as const,
      localRoles: [...stores.keys()], fencedRoles: [...stores.values()].filter(store => store.read().version === 3).length,
      approvalDigest: historyDigest(`resonance:admission-local-role-capture:v1\n${JSON.stringify([
        directory, contextId, capture.approvalDigest, [...stores].map(([role, store]) => [role, store.read()]),
      ])}`) };
    return { roles, capture, review };
  }
  return {
    async review() { if (busy) throw new Error('Admission role capture is in progress'); return (await plan()).review; },
    async apply(approvedDigest: string) {
      available(); if (busy) throw new Error('Admission role capture is in progress'); busy = true;
      try {
        let prepared = await plan();
        if (prepared.review.approvalDigest !== approvedDigest) throw new Error('Local admission roles or approval changed');
        if (!prepared.capture.fits) throw new Error('Admission role capture needs checkpoint headroom before fencing local roles');
        await history.ready(); available();
        prepared = await plan();
        if (prepared.review.approvalDigest !== approvedDigest) throw new Error('History changed during role capture readiness; review again');
        if (!prepared.capture.fits) throw new Error('Admission role capture needs checkpoint headroom before fencing local roles');
        for (const [role, store] of stores) if (store.read().version !== 3) {
          store.write({ version: 3, kind: 'protected-admission-role', role, contextId, state: local(store.read(), role) });
        }
        await history.captureRoles(prepared.roles, prepared.capture.approvalDigest); available();
        return { ...prepared.review, completed: true as const, durableCopies: 4 as const };
      } finally { busy = false; }
    }, close,
  };
}
