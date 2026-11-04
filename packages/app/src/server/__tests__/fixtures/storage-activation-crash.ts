import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { writeOperatorJsonAtomic } from '@resonance/relay';
import { openDesktopStorageActivationReview } from '../../relay-storage-activation.js';
import { relayServiceOutputPaths } from '../../relay-supervisor.js';
const [raw, home, boundary] = process.argv.slice(2), input = JSON.parse(raw);
// Only OS service execution is substituted. Ownership, ledger, selection,
// definitions and settings use their production filesystem writers.
os.homedir = () => home;
cp.execFileSync = (() => process.platform === 'win32' ? '{"state":"absent"}' : '') as unknown as typeof cp.execFileSync;
syncBuiltinESMExports();
const configFile = join(input.dataDirectory, 'relay-config.json');
const h = await openDesktopStorageActivationReview({ ...input, saveConfig: config => writeOperatorJsonAtomic(configFile, config, 65536) });
const review = h.review(), native = relayServiceOutputPaths(input.dataDirectory), rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (boundary === 'native' ? native.includes(String(to)) : String(to) === configFile) process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports(); h.apply(review.approvalDigest); throw new Error('Expected activation interruption');
