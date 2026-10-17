import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openRelayStorageOwner } from '@resonance/relay';
import { desktopRelayStorageControls } from '../../relay-storage.js';
import { reviewDesktopStoragePublication } from '../../relay-storage-publication.js';
const [raw, boundary] = process.argv.slice(2), input = JSON.parse(raw);
const owner = openRelayStorageOwner(input, 'maintenance', desktopRelayStorageControls(input.dataDirectory));
const handle = reviewDesktopStoragePublication(owner, input), review = handle.review();
const open = fs.openSync, close = fs.closeSync, write = fs.writeSync, outputs = new Set<number>();
fs.openSync = (path, flags, mode) => { const fd = open(path, flags, mode); if (String(path) === review.output && flags === 'wx') outputs.add(fd); return fd; };
fs.writeSync = ((fd: number, ...args: unknown[]) => {
  if (outputs.has(fd) && boundary === 'partial') { write(fd, Buffer.from('{')); process.kill(process.pid, 'SIGKILL'); }
  return Reflect.apply(write, fs, [fd, ...args]);
}) as typeof fs.writeSync;
fs.closeSync = fd => { const output = outputs.delete(fd); close(fd); if (output && boundary === 'complete') process.kill(process.pid, 'SIGKILL'); };
syncBuiltinESMExports(); handle.apply(review.approvalDigest); throw new Error('Expected interrupted selection publication');
