import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoryStorageResult } from './HistoryStorage';
vi.mock('../api.client', () => ({}));
it('shows observed file counts without claiming a quota or free disk space', () => {
  const html = renderToStaticMarkup(<HistoryStorageResult result={{ kind: 'storage-inventory', selectedDirectories: 3, scannedRoots: 2,
    directories: 5, files: 7, logicalBytes: 1048576, allocatedBytes: null, startedAt: 0, completedAt: 1, atomicSnapshot: false, enforcesQuota: false }} />);
  expect(html).toContain('1.00'); expect(html).toContain('Filesystem allocation is unavailable');
  expect(html).toContain('does not reserve space or enforce a combined quota');
});
