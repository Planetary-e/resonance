import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openAdmissionRestorationReadiness } from '../../admission-history-readiness.js';

process.once('message', async (input: any) => {
  try {
    const readiness = await openAdmissionRestorationReadiness({ ...input.options, encryptionKey: Buffer.from(input.key, 'hex'),
      protection: { ...input.options.protection, signingKey: { publicKey: Buffer.from(input.owner.publicKey, 'hex'), secretKey: Buffer.from(input.owner.secretKey, 'hex') } } });
    const root = fs.realpathSync(input.options.directory), rename = fs.renameSync;
    const targets: Record<string, string> = { writer: join(root, 'admission-history-writer', 'history-writer.json'),
      archive: join(root, 'admission-history-writer', 'payloads', 'history-writer-payloads.json'), apply: join(root, 'admission-spends-v2.jsonl') };
    const [when, stage] = input.boundary.split('-'); let observed = false;
    fs.renameSync = (from, to) => {
      const target = !observed && String(to) === targets[stage];
      if (target) { observed = true; if (when === 'before') process.kill(process.pid, 'SIGKILL'); }
      rename(from, to);
      if (target && when === 'after') process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports(); await readiness.apply(readiness.review().approvalDigest);
    throw new Error('Readiness interruption boundary was not reached');
  } catch (error) { process.send!({ error: error instanceof Error ? error.message : 'Readiness crash fixture failed' }); process.exitCode = 1; process.disconnect?.(); }
});
process.send!('ready');
