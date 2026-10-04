import { beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateSigningKeyPair, sign } from '../crypto.js';
import { admissionKeyFingerprint, signAdmissionPolicy, verifyAdmissionPolicy, assertAdmissionPolicySuccessor,
  parseAdmissionPolicyBody, openAdmissionPolicyStore, type AdmissionPolicyBody, type AdmissionPolicyKey, type SignedAdmissionPolicy } from '../admission-policy.js';
import { prepareAdmissionRotation, signAdmissionRotation, type AdmissionRotationRequest } from '../admission-rotation.js';

const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url');
let time: number, entries: AdmissionPolicyKey[], previous: SignedAdmissionPolicy, archived: SignedAdmissionPolicy;
beforeAll(async () => {
  time = Date.now();
  const witnesses = { version: 1 as const, quorum: 4 as const,
    members: Array.from({ length: 5 }, (_, i) => ({ publicKey: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${48000 + i}/` })),
    coordinators: [Buffer.from(generateSigningKeyPair().publicKey).toString('base64url')] };
  entries = Array.from({ length: 9 }, (_, i) => ({ profile: { version: 1, scope: { issuer: 'archive-community', community: 'public', epoch: `period-${i}` },
    issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: ['ws://127.0.0.1:48010/'] },
    notBefore: time - 10000, issueUntil: time + 100000, spendUntil: time + 200000, retryUntil: time + 300000, witnesses }));
  entries[0] = { ...entries[0], issueUntil: time - 3000, spendUntil: time - 2000, retryUntil: time - 1000 };
  previous = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', revision: 1, issuedAt: time - 10000,
    expiresAt: time + 86400000, activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), keys: entries.slice(0, 8) }, authority, key.secretKey);
  const prepared = await prepareAdmissionRotation(previous, request(), authority, () => time);
  archived = (await signAdmissionRotation(previous, prepared.plan, authority, key.secretKey, prepared.summary.approvalDigest, () => time)).policy;
}, 30000);
function request(): AdmissionRotationRequest { return { version: 2, kind: 'admission-rotation-request', issuedAt: time,
  expiresAt: time + 86400000, archive: [previous.activeKey], retire: [], newKey: entries[8] }; }
function body(): AdmissionPolicyBody { const { authority: _, signature: __, ...value } = archived; return structuredClone(value); }

it('preserves the exact v1 signing payload and authenticates every v2 archive field', async () => {
  const legacyPayload = Buffer.from('resonance:admission-policy:v1\n' + JSON.stringify([
    previous.version, previous.kind, previous.revision, previous.issuedAt, previous.expiresAt, previous.activeKey,
    previous.keys.map(e => [e.profile, e.notBefore, e.issueUntil, e.spendUntil, e.retryUntil, e.witnesses]),
  ]));
  expect(previous.signature).toBe(Buffer.from(sign(legacyPayload, key.secretKey)).toString('base64url'));
  expect(await verifyAdmissionPolicy(archived, authority)).toEqual(archived);
  const forged = structuredClone(archived); forged.archivedKeys![0].profile.scope.epoch = 'forged';
  await expect(verifyAdmissionPolicy(forged, authority)).rejects.toThrow('signature');
  for (const edit of [
    (b: AdmissionPolicyBody) => { b.keys.push(b.archivedKeys![0]); },
    (b: AdmissionPolicyBody) => { b.archivedKeys!.push(b.keys[0]); },
    (b: AdmissionPolicyBody) => { b.activeKey = previous.activeKey; },
    (b: AdmissionPolicyBody) => { b.archivedKeys![0].retryUntil = time + 1; },
    (b: AdmissionPolicyBody) => { b.archivedKeys = Array(65).fill(b.archivedKeys![0]); },
    (b: AdmissionPolicyBody) => { b.version = 1; },
    (b: AdmissionPolicyBody) => { delete b.archivedKeys; },
  ]) { const value = body(); edit(value); await expect(parseAdmissionPolicyBody(value)).rejects.toThrow(); }
});

it('never drops, edits or reactivates archives, including shortened-cutoff and downgrade attempts', async () => {
  expect(() => assertAdmissionPolicySuccessor(previous, archived)).not.toThrow();
  for (const edit of [
    (b: AdmissionPolicyBody) => { b.archivedKeys = []; },
    (b: AdmissionPolicyBody) => { b.archivedKeys![0].retryUntil--; },
    (b: AdmissionPolicyBody) => { b.archivedKeys![0].witnesses!.members[0].endpoint = 'ws://127.0.0.1:49999/'; },
    (b: AdmissionPolicyBody) => { b.keys.push(b.archivedKeys!.pop()!); },
    (b: AdmissionPolicyBody) => { b.version = 1; delete b.archivedKeys; },
  ]) { const value = body(); value.revision++; edit(value); expect(() => assertAdmissionPolicySuccessor(archived, value)).toThrow(); }
  const prematurelyArchived = body(); prematurelyArchived.issuedAt = time - 1500; prematurelyArchived.archivedKeys![0].retryUntil = time - 1500;
  // Structurally valid signed authority output still cannot bypass the predecessor's promised cutoff.
  await parseAdmissionPolicyBody(prematurelyArchived);
  expect(() => assertAdmissionPolicySuccessor(previous, prematurelyArchived)).toThrow('original final cutoff');
});

it('binds ninth-rotation review to archival selection and refuses ambiguous or premature requests', async () => {
  const { plan, summary } = await prepareAdmissionRotation(previous, request(), authority, () => time);
  expect(plan.body).toEqual(body());
  expect(summary.policyCapacity).toMatchObject({ retainedKeys: 8, archivedKeys: 1, remainingKeySlots: 0, remainingArchiveSlots: 63, maximumFileBytes: 524288 });
  expect(summary.retained[0]).toMatchObject({ issuerKey: previous.activeKey, archived: true });
  expect(summary.historyCapacity).toMatchObject({ inspected: false, reset: false });
  const edited = structuredClone(plan); edited.body.expiresAt--;
  await expect(signAdmissionRotation(previous, edited, authority, key.secretKey, summary.approvalDigest, () => time)).rejects.toThrow('Approval');
  for (const edit of [
    (r: AdmissionRotationRequest) => { r.archive!.push(previous.activeKey); },
    (r: AdmissionRotationRequest) => { r.archive = [admissionKeyFingerprint(entries[8].profile.issuerPublicKey)]; },
    (r: AdmissionRotationRequest) => { r.archive = [admissionKeyFingerprint(entries[1].profile.issuerPublicKey)]; },
    (r: AdmissionRotationRequest) => { r.retire = [{ issuerKey: previous.activeKey, issueUntil: time - 3000, spendUntil: time - 2000, retryUntil: time - 1500 }]; },
    (r: AdmissionRotationRequest) => { r.newKey = entries[0]; },
    (r: AdmissionRotationRequest) => { r.newKey = structuredClone(entries[8]); r.newKey.profile.scope.epoch = entries[0].profile.scope.epoch; },
  ]) { const r = request(); edit(r); await expect(prepareAdmissionRotation(previous, r, authority, () => time)).rejects.toThrow(); }
});

it('persists v2 across restart and refuses a signed archive erasure or an older revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admission-archive-store-'));
  const options = { path: join(directory, 'policy.json'), encryptionKey: randomBytes(32), now: () => time };
  let store = await openAdmissionPolicyStore(options);
  try {
    await store.install(previous, authority); await store.install(archived, authority);
    const saved = readFileSync(options.path);
    store.close(); store = await openAdmissionPolicyStore({ ...options, mode: 'open-existing' });
    expect(store.current()).toEqual(archived);
    const erased = await signAdmissionPolicy({ ...body(), revision: 3, archivedKeys: [] }, authority, key.secretKey);
    await expect(store.install(erased, authority)).rejects.toThrow('permanent');
    await expect(store.install(previous, authority)).rejects.toThrow('rollback');
    expect(readFileSync(options.path)).toEqual(saved);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('accepts a valid archive larger than 64 KiB through encrypted persistence and bounds oversized input', async () => {
  const wide = body();
  for (const entry of [...wide.keys, ...wide.archivedKeys!]) {
    entry.profile.relayUrls = Array.from({ length: 8 }, (_, i) => `wss://relay.example/${i}/` + 'p'.repeat(490));
    entry.witnesses!.members = entry.witnesses!.members.map((member, i) => ({ ...member, endpoint: `wss://witness.example/${i}/` + 'p'.repeat(488) }));
  }
  const policy = await signAdmissionPolicy(wide, authority, key.secretKey);
  expect(Buffer.byteLength(JSON.stringify(policy))).toBeGreaterThan(65536);
  expect(await verifyAdmissionPolicy(policy, authority)).toEqual(policy);
  const directory = mkdtempSync(join(tmpdir(), 'admission-wide-policy-'));
  const options = { path: join(directory, 'policy.json'), encryptionKey: randomBytes(32), now: () => time };
  let store = await openAdmissionPolicyStore(options);
  try {
    await store.install(policy, authority); store.close(); store = await openAdmissionPolicyStore({ ...options, mode: 'open-existing' });
    expect(store.current()).toEqual(policy);
    const huge = structuredClone(wide); huge.keys[0].profile.issuerPublicKey = 'x'.repeat(524288);
    await expect(parseAdmissionPolicyBody(huge)).rejects.toThrow('Invalid signed admission policy');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('prepares, reviews and signs the ninth rotation through the real offline command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admission-archive-command-'));
  const script = fileURLToPath(new URL('../../../../scripts/rotate-admission-policy.ts', import.meta.url));
  const pub = join(directory, 'authority.pub'), secret = join(directory, 'authority.json'), prev = join(directory, 'previous.json');
  const input = join(directory, 'request.json'), plan = join(directory, 'plan.json'), output = join(directory, 'signed.json');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 10000 });
  try {
    writeFileSync(pub, authority); writeFileSync(secret, JSON.stringify({ publicKey: authority, secretKey: Buffer.from(key.secretKey).toString('base64url') }), { mode: 0o600 });
    writeFileSync(prev, JSON.stringify(previous)); writeFileSync(input, JSON.stringify(request()));
    const prepared = run('prepare', pub, prev, input, plan); expect(prepared.status, prepared.stderr).toBe(0);
    const checked = run('check', pub, prev, plan); expect(checked.status, checked.stderr).toBe(0);
    const summary = JSON.parse(checked.stdout);
    expect(summary.approvalDigest).toBe(JSON.parse(prepared.stdout).approvalDigest);
    const signed = run('sign', '--approve', summary.approvalDigest, pub, secret, prev, plan, output); expect(signed.status, signed.stderr).toBe(0);
    expect(await verifyAdmissionPolicy(JSON.parse(readFileSync(output, 'utf8')), authority)).toEqual(archived);
    expect(statSync(output).size).toBe(summary.policyCapacity.signedFileBytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
