import { beforeAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createAdmissionRequestBindingV2, generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyKey, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import type { AdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { createConfiguredAdmissionVerifier, createAdmissionWitness, createAdmissionQuorumGate, openAdmissionSpendHistory, type AdmissionWitnessTransport } from '@resonance/relay';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import { openAdmissionIssuerLedger } from '../admission-issuer-ledger.js';
import { issueAdmissionBatch } from '../blind-admission-issuance.js';

const authorityKey = generateSigningKeyPair(), authority = Buffer.from(authorityKey.publicKey).toString('base64url');
const witnesses = Array.from({ length: 5 }, generateSigningKeyPair), coordinator = generateSigningKeyPair();
const start = Date.now() - 60000;
let keys: CryptoKeyPair[], first: SignedAdmissionPolicy, ninth: SignedAdmissionPolicy;
beforeAll(async () => {
  keys = []; const entries: AdmissionPolicyKey[] = [];
  for (let i = 0; i < 9; i++) {
    const pair = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }); keys.push(pair);
    const der = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
    entries.push({ profile: { version: 1, scope: { issuer: 'archive-integration', community: 'public', epoch: `period-${i}` },
      issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----\n`, relayUrls: ['ws://127.0.0.1:48500/'] },
      notBefore: start - 1000, issueUntil: start + (i ? 3600000 : 10000), spendUntil: start + (i ? 7200000 : 20000), retryUntil: start + (i ? 10800000 : 30000),
      witnesses: { version: 1, quorum: 4, members: witnesses.map((key, n) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${48501 + n}/` })),
        coordinators: [Buffer.from(coordinator.publicKey).toString('base64url')] } });
  }
  const common = { kind: 'admission-policy' as const, expiresAt: start + 86400000 };
  first = await signAdmissionPolicy({ ...common, version: 1, revision: 1, issuedAt: start - 1000,
    keys: entries.slice(0, 8), activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey) }, authority, authorityKey.secretKey);
  ninth = await signAdmissionPolicy({ ...common, version: 2, revision: 2, issuedAt: start + 30000,
    keys: [...first.keys.slice(1), entries[8]], activeKey: admissionKeyFingerprint(entries[8].profile.issuerPublicKey), archivedKeys: [first.keys[0]] }, authority, authorityKey.secretKey);
}, 30000);

it('admits a ninth real issuer after restart while old reservations, votes, certificates and spends remain denied and explicitly cleanable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admission-ninth-')), encryptionKey = randomBytes(32);
  let time = start; const now = () => time;
  const walletOptions = { directory: join(directory, 'wallet'), encryptionKey, now };
  let wallet = await openManagedAdmissionWallet(walletOptions);
  const issuerOptions = { path: join(directory, 'issuer.json'), privateKey: keys[0].privateKey, expectedProfile: first.keys[0].profile, now };
  let issuer = await openAdmissionIssuerLedger({ ...issuerOptions, create: { batchSize: 2, maxPermits: 2 } });
  type Verifier = Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>>;
  const instances = new Set<Verifier>(), peers = new Map<string, Verifier>();
  const requests: AdmissionWitnessRequest[] = [];
  const transport: AdmissionWitnessTransport = async (member, request) => { requests.push(request); return peers.get(member.publicKey)!.witness!.vote(request); };
  const shared = { encryptionKey, authority, now };
  const destination = { ...shared, directory: join(directory, 'destination'), coordinatorKey: coordinator, witnessTransport: transport };
  async function openRoles(policy: SignedAdmissionPolicy, initialize = false) {
    for (let i = 0; i < 5; i++) {
      const peer = await createConfiguredAdmissionVerifier({ ...shared, directory: join(directory, `witness-${i}`), policy, witnessKey: witnesses[i], initialize });
      instances.add(peer); peers.set(Buffer.from(witnesses[i].publicKey).toString('base64url'), peer);
    }
    const relay = await createConfiguredAdmissionVerifier({ ...destination, policy, initialize }); instances.add(relay); return relay;
  }
  function closeRoles() { for (const role of instances) role.close(); instances.clear(); peers.clear(); }
  try {
    let relay = await openRoles(first, true);
    await wallet.installPolicy(first, authority); await issuer.installPolicy(first, authority);
    const permit = issuer.grant(), batch = await wallet.requestTokens(2), response = await issuer.approve(permit, batch);
    await wallet.completeIssuance(response);
    const context = { relayUrl: first.keys[0].profile.relayUrls[0], action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { text: 'old' }) };
    const old = wallet.capabilityFor(context)!;
    expect(await relay.verifyAndSpend(old, { ...context, now: time })).toEqual({ status: 'accepted' });
    const oldRequest = requests[0]; expect(oldRequest.issuerKey).toBe(first.activeKey);
    const paths = ['wallet/admission-wallet.json', 'witness-0/admission-witness-votes.json',
      'destination/admission-witness-certificates.json', 'destination/admission-spends-v2.jsonl'].map(p => join(directory, p));
    const history = paths.map(p => readFileSync(p));
    closeRoles(); wallet.close(); issuer.close();

    time = start + 30000;
    // Returning devices load old v1 histories first, then install the archive without resetting files.
    wallet = await openManagedAdmissionWallet(walletOptions); await wallet.installPolicy(ninth, authority);
    issuer = await openAdmissionIssuerLedger(issuerOptions); await issuer.installPolicy(ninth, authority);
    relay = await openRoles(ninth);
    expect(wallet.status()).toMatchObject({ policy: { revision: 2, currentKeys: 8, archivedKeys: 1 }, archived: expect.any(Array) });
    expect(wallet.status().archived).toHaveLength(8); // Nine historical local profiles.
    expect(wallet.status().archived.find(p => p.keyFingerprint === first.activeKey)).toMatchObject({ available: 1, reserved: 1, canRetire: true });
    paths.forEach((p, i) => expect(readFileSync(p)).toEqual(history[i]));
    expect(() => issuer.grant()).toThrow('retired');
    await expect(issuer.approve(permit, batch)).rejects.toThrow('retired');
    for (const peer of peers.values()) expect(() => peer.witness!.vote(oldRequest)).toThrow('permanently retired');
    expect(await relay.verifyAndSpend(old, { ...context, now: time })).toMatchObject({ status: 'rejected' });

    const freshBatch = await wallet.requestTokens(2);
    await wallet.completeIssuance(await issueAdmissionBatch({ request: freshBatch, expectedProfile: ninth.keys[7].profile, privateKey: keys[8].privateKey }));
    const available = wallet.status().available;
    expect(() => wallet.capabilityFor(context)).toThrow('not active');
    expect(wallet.status().available).toBe(available); // No replacement token for a denied old request.
    const freshContext = { ...context, requestBinding: createAdmissionRequestBindingV2('search', { text: 'ninth' }) };
    const fresh = wallet.capabilityFor(freshContext)!;
    expect(await relay.verifyAndSpend(fresh, { ...freshContext, now: time })).toEqual({ status: 'accepted' });
    expect(requests.some(r => r.issuerKey === ninth.activeKey)).toBe(true);
    const cleanup = wallet.planRetirement(first.activeKey); wallet.retire(first.activeKey, cleanup.approvalDigest);
    const issuerCleanup = issuer.planRetirement(authority); issuer.retire(authority, issuerCleanup.approvalDigest);
    wallet.close(); issuer.close(); closeRoles();

    // Explicit local maintenance can still verify archived pins and replace evidence with permanent fences.
    for (let i = 0; i < 5; i++) {
      const witness = createAdmissionWitness({ ...shared, directory: join(directory, `witness-${i}`), policy: ninth, signingKey: witnesses[i] });
      try { const p = witness.planRetirement(first.activeKey); expect(p.recordsRemoved).toBe(1); witness.retire(first.activeKey, p.approvalDigest); }
      finally { witness.close(); }
    }
    const gate = createAdmissionQuorumGate({ ...destination, policy: ninth, signingKey: coordinator, transport });
    try {
      await expect(gate.authorize(first.activeKey, oldRequest.spend, context)).rejects.toThrow('permanently retired');
      const p = gate.planRetirement(first.activeKey); expect(p.recordsRemoved).toBe(1); gate.retire(first.activeKey, p.approvalDigest);
    } finally { gate.close(); }
    const spends = openAdmissionSpendHistory({ ...destination, policy: ninth });
    try {
      expect(spends.isRetired(first.activeKey)).toBe(true);
      const row = spends.get(oldRequest.spend)!; expect(row.issuerKey).toBe(first.activeKey);
      expect(() => spends.write({ ...row, issuerKey: first.activeKey })).toThrow('permanently retired');
      const p = spends.planRetirement(first.activeKey); expect(p.recordsRemoved).toBe(1); spends.retire(first.activeKey, p.approvalDigest);
    } finally { spends.close(); }

    wallet = await openManagedAdmissionWallet(walletOptions); issuer = await openAdmissionIssuerLedger(issuerOptions); relay = await openRoles(ninth);
    expect(issuer.status()).toMatchObject({ permanentlyRetired: true, allocatedPermits: 1 });
    expect(() => wallet.capabilityFor(context)).toThrow('permanently retired');
    expect(wallet.status().available).toBe(available - 1);
    expect(await relay.verifyAndSpend(fresh, { ...freshContext, now: time })).toEqual({ status: 'replay' });
    for (const peer of peers.values()) expect(() => peer.witness!.vote(oldRequest)).toThrow('permanently retired');
    await expect(wallet.installPolicy(first, authority)).rejects.toThrow('rollback');
    // Permanent denial files remain mandatory, even though the issuer appears only in the signed archive.
    wallet.close(); rmSync(join(walletOptions.directory, 'admission-wallet.json'));
    await expect(openManagedAdmissionWallet(walletOptions)).rejects.toThrow('missing');
  } finally { wallet.close(); issuer.close(); closeRoles(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it('installs only current wallets on a new device and retains signed archive counts after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admission-archive-new-wallet-'));
  const options = { directory, encryptionKey: randomBytes(32), now: () => start + 30000 };
  let wallet = await openManagedAdmissionWallet(options);
  try {
    await wallet.installPolicy(ninth, authority); wallet.close(); wallet = await openManagedAdmissionWallet(options);
    expect(wallet.status().policy).toMatchObject({ currentKeys: 8, archivedKeys: 1 });
    expect(wallet.status().archived).toHaveLength(7);
    expect(wallet.status().archived.some(p => p.keyFingerprint === first.activeKey)).toBe(false);
    expect(readdirSync(directory).filter(name => /^admission-wallet.*\.json$/.test(name))).toHaveLength(8);
  } finally { wallet.close(); rmSync(directory, { recursive: true, force: true }); }
});
