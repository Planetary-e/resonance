import { openSharedHistoryPool } from '../../history-shared-pool.js';
import { openHistoryCheckpointStore } from '../../history-checkpoint-store.js';
import { openHistoryGenerationProvisioner } from '../../history-generation-provisioner.js';
process.on('message', (input: any) => {
  const localKey = Buffer.from(input.localKey, 'hex'), pool = openSharedHistoryPool({ ...input.options, localKey });
  const store = openHistoryCheckpointStore({ directory: pool.directory, localKey, context: input.options.context, replica: input.options.replica, rootId: input.options.genesisId, generation: 0, sharedPool: pool });
  if (input.boundary === 'after-hold') { const prepare = pool.preparePublication; pool.preparePublication = root => { prepare(root); process.kill(process.pid, 'SIGKILL'); }; }
  const open = pool.openRecord;
  pool.openRecord = ((options: any) => { const handle = open(options);
    if (options.kind === 'provision') { const write = handle.write; handle.write = ((value: any) => {
      if (input.boundary === 'before-creating' && value.phase === 'creating' || input.boundary === 'before-ready' && value.phase === 'ready') process.kill(process.pid, 'SIGKILL');
      write(value); if (input.boundary === 'ready' && value.phase === 'ready') process.kill(process.pid, 'SIGKILL');
    }) as typeof handle.write; }
    return handle;
  }) as typeof pool.openRecord;
  const provision = openHistoryGenerationProvisioner({ directory: pool.directory, localKey, context: input.options.context,
    signingKey: { publicKey: Buffer.from(input.member.publicKey, 'hex'), secretKey: Buffer.from(input.member.secretKey, 'hex') }, parent: store, sharedPool: pool, now: () => 10000 });
  provision.provision(input.request); throw new Error('Missed crash boundary');
});
process.send?.('ready');
