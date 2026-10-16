import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openHistoryCheckpointStore, HISTORY_MANIFEST_FILENAME } from '../../history-checkpoint-store.js';
import { openHistoryGenerationProvisioner, HISTORY_PROVISION_FILENAME } from '../../history-generation-provisioner.js';

process.once('message', (input: any) => {
  const localKey = Buffer.from(input.localKey, 'hex');
  const parent = openHistoryCheckpointStore({ ...input.options, localKey });
  const signingKey = { publicKey: Buffer.from(input.member.publicKey, 'hex'), secretKey: Buffer.from(input.member.secretKey, 'hex') };
  const role = openHistoryGenerationProvisioner({ directory: input.directory, localKey, context: input.options.context,
    signingKey, parent, now: () => input.request.issuedAt });
  const rename = fs.renameSync, mkdir = fs.mkdirSync;
  let childManifests = 0, journalWrites = 0;
  const kill = (point: string) => { if (input.boundary === point) process.kill(process.pid, 'SIGKILL'); };
  fs.mkdirSync = ((path: fs.PathLike, options?: any) => {
    const result = mkdir(path, options);
    if (String(path).split('/').at(-1)?.startsWith('.creating-')) kill('directory');
    return result;
  }) as typeof fs.mkdirSync;
  fs.renameSync = (from, to) => {
    const path = String(to);
    const stagedManifest = path.includes('/.creating-') && path.endsWith(HISTORY_MANIFEST_FILENAME);
    if (stagedManifest) childManifests++;
    if (path.endsWith(HISTORY_PROVISION_FILENAME)) journalWrites++;
    if (path.split('/').at(-1)?.startsWith('generation-')) kill('before-publication');
    rename(from, to);
    if (stagedManifest) kill(childManifests === 1 ? 'empty-manifest' : 'root-manifest');
    if (path.endsWith('.block')) kill('root-block');
    if (path.endsWith(HISTORY_PROVISION_FILENAME)) kill(journalWrites === 1 ? 'intent' : 'ready-marker');
    if (path.split('/').at(-1)?.startsWith('generation-')) kill('after-publication');
  };
  syncBuiltinESMExports();
  role.provision(input.request);
  process.send!('durable', () => process.kill(process.pid, 'SIGKILL'));
});
process.send!('ready');
