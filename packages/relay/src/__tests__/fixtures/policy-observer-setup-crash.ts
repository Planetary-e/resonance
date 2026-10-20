import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openPolicyObserverSetup } from '../../policy-observer-setup.js';

process.once('message', async (message: { input: Parameters<typeof openPolicyObserverSetup>[0]; boundary: string; marker: string }) => {
  try {
    const setup = await openPolicyObserverSetup(message.input), review = setup.review();
    const original = { open: fs.openSync, close: fs.closeSync, write: fs.writeSync, sync: fs.fsyncSync, marker: fs.writeFileSync };
    const descriptors = new Map<number, string>();
    const interrupt = () => { original.marker(message.marker, message.boundary); process.kill(process.pid, 'SIGKILL'); };
    fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
      const fd = (original.open as Function)(path, ...args), target = resolve(String(path));
      const role = target === review.anchor ? 'anchor' : target === review.output ? 'export' : undefined;
      if (role) { descriptors.set(fd, role); if (message.boundary === `${role}-empty`) interrupt(); }
      return fd;
    }) as typeof fs.openSync;
    fs.closeSync = fd => { descriptors.delete(fd); original.close(fd); };
    fs.writeSync = ((fd: number, ...args: unknown[]) => {
      if (message.boundary === `${descriptors.get(fd)}-partial`) { original.write(fd, Buffer.from('partial')); interrupt(); }
      return (original.write as Function)(fd, ...args);
    }) as typeof fs.writeSync;
    fs.fsyncSync = fd => { original.sync(fd); if (message.boundary === `after-${descriptors.get(fd)}`) interrupt(); };
    syncBuiltinESMExports(); await setup.apply(review.approvalDigest);
    throw new Error('Policy setup interruption boundary was not reached');
  } catch (error) { process.send?.({ error: error instanceof Error ? error.message : 'Policy setup interruption failed' }); process.exitCode = 1; process.disconnect?.(); }
});
process.send?.('ready');
