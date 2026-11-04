import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoryMaintenanceView } from './HistoryMaintenance.js';
vi.mock('../api.client', () => ({}));

it('distinguishes a retained pause from proof of a stopped process and explains the finish action', () => {
  const render = (checked: boolean, busy = false) => renderToStaticMarkup(<HistoryMaintenanceView
    state={{ active: true, createdAt: 1 }} checked={checked} busy={busy} error="" onChange={async () => {}} />);
  expect(render(false)).toContain('does not confirm the running process has stopped');
  expect(render(false)).not.toContain('last check confirmed');
  expect(render(true)).toContain('last check confirmed');
  expect(render(true)).toContain('does not start the relay, complete recovery or erase pending work');
  expect(render(true, true).match(/disabled=""/g)).toHaveLength(2);
  const unknown = renderToStaticMarkup(<HistoryMaintenanceView state={null} checked={false} busy={false}
    error="Saved marker is invalid" onChange={async () => {}} />);
  expect(unknown).toContain('disabled=""'); expect(unknown).toContain('role="alert"');
});
