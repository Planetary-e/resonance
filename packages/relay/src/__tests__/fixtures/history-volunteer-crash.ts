import fs, { type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { historyContinuationRootId } from '@resonance/core/history-continuation';
import { openHistoryVolunteerService } from '../../history-volunteer-service.js';

process.once('message', (message: any) => {
  try {
    const service = openHistoryVolunteerService({ ...message.options, localKey: Buffer.from(message.localKey, 'hex'),
      signingKey: { publicKey: Buffer.from(message.member.publicKey, 'hex'), secretKey: Buffer.from(message.member.secretKey, 'hex') } });
    const name = `successors-${historyContinuationRootId(message.request.root).slice(7)}`, original = fs.renameSync;
    const hook = (from: PathLike, to: PathLike) => {
      const target = String(to).replaceAll('\\', '/'), chosen = target.endsWith(`${name}/history-provision.json`);
      if (chosen && message.boundary === 'before-slot') process.kill(process.pid, 'SIGKILL');
      original(from, to);
      if (chosen && message.boundary === 'after-slot') process.kill(process.pid, 'SIGKILL');
    };
    Object.assign(fs, { renameSync: hook }); syncBuiltinESMExports(); service.provision(message.request);
    process.send?.('unexpected-completion'); service.close(); process.exit(2);
  } catch { process.send?.('error'); process.exit(1); }
});
process.send?.('ready');
