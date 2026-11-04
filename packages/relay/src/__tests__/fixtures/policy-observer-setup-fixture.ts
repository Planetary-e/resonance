import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { policyObserverFixture } from './policy-observer-fixture.js';
import { createRelayTestEndpoints } from './relay-test-endpoint.js';
import { runPolicyObserverCommand } from '../../policy-observer-command.js';

export async function policyObserverSetupFixture(register: (close: () => void | Promise<void>) => void) {
  const n = await policyObserverFixture({ policyLifetimeMs: 300000 }); register(n.close);
  const endpoints = await createRelayTestEndpoints(5); for (const endpoint of endpoints) register(endpoint.close);
  const keyFiles = n.keys.map((key, i) => {
    const path = join(n.directory, `member-${i}.json`);
    writeFileSync(path, JSON.stringify({ publicKey: Buffer.from(key.publicKey).toString('base64url'), secretKey: Buffer.from(key.secretKey).toString('base64url') }), { mode: 0o600 }); return path;
  });
  const storageFiles = n.keys.map((_, i) => {
    const path = join(n.directory, `storage-${i}.key`); writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 }); return path;
  });
  const storagePath = join(n.directory, 'owner.key'); writeFileSync(storagePath, Buffer.from(n.options.encryptionKey).toString('hex'), { mode: 0o600 });
  const policyPath = join(n.directory, 'policy.json'); writeFileSync(policyPath, JSON.stringify(n.first));
  const input = { version: 1, kind: 'policy-observer-setup', context: n.context,
    members: n.keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${endpoints[i].port}/history-checkpoint` })),
    directory: 'owner', signingKeyFile: 'member-0.json', storageKeyFile: 'owner.key', policyFile: 'policy.json',
    limits: { archiveBytes: 64 * 1024 * 1024, archiveBlocks: 10001 }, listen: { port: 0, maxConnections: 4, connectionTimeoutMs: 10000 } };
  const setupFile = join(n.directory, 'setup.json'); writeFileSync(setupFile, JSON.stringify(input));
  const configPath = join(n.directory, 'config.json'), enrollmentPath = join(n.directory, 'public-enrollment.json'), ownerDirectory = join(n.directory, 'owner');
  const args = [setupFile, configPath], call = async (command: string, arguments_ = args) => (await runPolicyObserverCommand(command, arguments_)).result as Record<string, any>;
  const prepare = async () => {
    const plan = await call('setup-plan'); await call('setup-create', ['--approve', plan.approvalDigest, ...args]);
    await call('enrollment-export', [configPath, enrollmentPath]);
  };
  const replicaArgs = (i: number) => [enrollmentPath, keyFiles[i], storageFiles[i], join(n.directory, `replica-${i}`)];
  const enroll = async (i: number) => { const review = await call('replica-plan', replicaArgs(i)); await call('replica-enroll', ['--approve', review.approvalDigest, ...replicaArgs(i)]); };
  const start = async (i: number) => {
    const serving = await runPolicyObserverCommand('replica-serve', [...replicaArgs(i), '0']); if (!serving.close) throw new Error('Missing volunteer service');
    register(serving.close); endpoints[i].forwardTo(Number(new URL((serving.result as { checkpointEndpoint: string }).checkpointEndpoint).port)); return serving;
  };
  const initialize = async () => { const review = await call('initialize-plan', [configPath]); return call('initialize', ['--approve', review.approvalDigest, configPath]); };
  return { ...n, input, setupFile, configPath, enrollmentPath, ownerDirectory, keyFiles, storageFiles, storagePath, endpoints, args, call, prepare, replicaArgs, enroll, start, initialize };
}
