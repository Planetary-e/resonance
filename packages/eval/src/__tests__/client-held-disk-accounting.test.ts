import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAtomic } from '../../../relay/src/atomic-file.js';
import {
  HarnessDiskAccounting,
  summarizeDiskActivity,
} from '../client-held-disk-accounting.js';

const directories: string[] = [];
const accounting: HarnessDiskAccounting[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'resonance-disk-accounting-'));
  directories.push(root);
  const tracker = new HarnessDiskAccounting(root);
  accounting.push(tracker);
  return { root, tracker };
}

afterEach(() => {
  for (const tracker of accounting.splice(0)) tracker.restore();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('client-held synchronous disk accounting', () => {
  it('captures the real atomic writer temporary-file and replacement peak', () => {
    const root = mkdtempSync(join(tmpdir(), 'resonance-disk-accounting-'));
    directories.push(root);
    const path = join(root, 'state.json');
    fs.writeFileSync(path, 'old');
    const tracker = new HarnessDiskAccounting(root);
    accounting.push(tracker);

    writeAtomic(path, 'replacement');

    expect(tracker.snapshot()).toMatchObject({ finalBytes: 11, eventOrderedPeakBytes: 14 });
    expect(tracker.events().map(event => event.operation)).toEqual(expect.arrayContaining([
      'openSync', 'writeFileSync', 'renameSync', 'rmSync',
    ]));
    expect(tracker.reconcile()).toMatchObject({ actualFinalBytes: 11, matchesActualFinalBytes: true });
  });

  it('records descriptor writes that do not extend a file and truncate reductions', () => {
    const { root, tracker } = fixture();
    const path = join(root, 'journal.ndjson');
    const fd = fs.openSync(path, 'w');
    fs.writeSync(fd, Buffer.alloc(10, 1));
    fs.writeSync(fd, Buffer.alloc(4, 2), 0, 4, 0);
    fs.closeSync(fd);

    expect(tracker.snapshot().finalBytes).toBe(10);
    expect(tracker.events().filter(event => event.operation === 'writeSync').map(event => event.deltaBytes))
      .toEqual([10, 0]);

    fs.truncateSync(path, 4);
    expect(tracker.snapshot()).toMatchObject({ finalBytes: 4, eventOrderedPeakBytes: 10 });
    expect(tracker.events().at(-1)).toMatchObject({ operation: 'truncateSync', deltaBytes: -6 });
    expect(tracker.reconcile().matchesActualFinalBytes).toBe(true);
  });

  it('accounts for rename replacement and deletion without losing the earlier peak', () => {
    const { root, tracker } = fixture();
    const destination = join(root, 'current.json');
    const temporary = join(root, '.current.tmp');
    fs.writeFileSync(destination, 'old');
    fs.writeFileSync(temporary, '12345678');
    expect(tracker.snapshot()).toMatchObject({ finalBytes: 11, eventOrderedPeakBytes: 11 });

    fs.renameSync(temporary, destination);
    expect(tracker.snapshot().finalBytes).toBe(8);
    fs.unlinkSync(destination);
    expect(tracker.snapshot()).toMatchObject({ finalBytes: 0, eventOrderedPeakBytes: 11 });
    expect(tracker.events().map(event => event.operation)).toEqual(expect.arrayContaining(['renameSync', 'unlinkSync']));
    expect(tracker.reconcile()).toMatchObject({ actualFinalBytes: 0, matchesActualFinalBytes: true });
  });

  it('bounds cross-process same-timestamp ordering and detects uncovered final changes', () => {
    const summary = summarizeDiskActivity(100, [
      { atMicros: 10, sequence: 1, operation: 'writeSync', deltaBytes: 20 },
      { atMicros: 10, sequence: 1, operation: 'rmSync', deltaBytes: -5 },
    ]);
    expect(summary).toMatchObject({
      finalBytes: 115,
      eventOrderedPeakBytes: 115,
      peakUpperBoundBytes: 120,
      peakLowerBoundBytes: 115,
    });

    const { root, tracker } = fixture();
    fs.writeFileSync(join(root, 'covered'), '1234');
    tracker.restore();
    fs.writeFileSync(join(root, 'external'), 'uncovered');
    expect(tracker.reconcile()).toMatchObject({ finalBytes: 4, actualFinalBytes: 13, matchesActualFinalBytes: false });
  });
});
