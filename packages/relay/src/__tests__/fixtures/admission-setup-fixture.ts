import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointFixture } from './history-checkpoint-fixture.js';
import { witnessFixture } from './admission-witness-fixture.js';
import { reviewAdmissionOwnerConfiguration } from '../../admission-history-setup.js';

export async function admissionSetupFixture() {
  const h = historyCheckpointFixture(), issuer = await witnessFixture();
  const directory = mkdtempSync(join(tmpdir(), 'owner-setup-'));
  const close = () => { h.key.fill(0); h.owner.secretKey.fill(0); rmSync(directory, { recursive: true, force: true }); };
  try {
    const policy = await signAdmissionPolicy({ ...issuer.body, keys: issuer.body.keys.map(({ witnesses, ...key }) => key) }, issuer.authority, issuer.authorityKey.secretKey);
    const json = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; };
    const key = (name: string, value: typeof h.owner) => json(name, { publicKey: Buffer.from(value.publicKey).toString('base64url'), secretKey: Buffer.from(value.secretKey).toString('base64url') });
    const configInput = { ownerKeyFile: key('owner-private.json', h.owner), authorityFile: join(directory, 'authority.pub'),
      policyFile: json('policy.json', policy), membersFile: json('members.json', h.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${i + 1}/history-checkpoint` }))),
      output: join(directory, 'history.json') };
    writeFileSync(configInput.authorityFile, issuer.authority);
    const storageKeyFile = join(directory, 'owner-storage.hex'); writeFileSync(storageKeyFile, h.key.toString('hex'), { mode: 0o600 });
    const input = { historyConfigFile: configInput.output, policyFile: configInput.policyFile, storageKeyFile,
      directory: join(directory, 'owner-history'), output: join(directory, 'enrollment.json'), mode: 'new' as const };
    const createConfig = async () => { const prepared = await reviewAdmissionOwnerConfiguration(configInput); return prepared.apply(prepared.review.approvalDigest); };
    const desktopDirectory = join(directory, 'desktop'), runtimeDirectory = join(desktopDirectory, 'relay-data'); mkdirSync(runtimeDirectory, { recursive: true });
    return { ...h, issuer, policy, directory, desktopDirectory, runtimeDirectory, configInput, input, createConfig, json, keyFile: key, close };
  } catch (error) { close(); throw error; }
}
