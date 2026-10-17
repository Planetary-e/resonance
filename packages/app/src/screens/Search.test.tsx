import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Search from './Search.js';
import { savedRequestLabel } from '../components/SavedRequests.js';
import type { HeldPrivateRequest } from '../api.client.js';
vi.mock('../api.client', () => ({ search: vi.fn(), getPrivateRequests: vi.fn(), privateRequestAction: vi.fn(), holdMailboxCheck: vi.fn(), setAutomaticMailboxChecks: vi.fn() }));
describe('private search and mailbox hold presentation', () => {
  it('shows an explicit save choice only in the private transport pilot', () => {
    const render = (enabled: boolean) => renderToStaticMarkup(<Search privateDeliveryAvailable={enabled} onToast={() => {}} onSearchComplete={() => {}} />);
    expect(render(true)).toContain('Save search on this device'); expect(render(false)).not.toContain('Save search on this device');
  });
  it('does not label an uncertain or expired attempt as unsent', () => {
    const entry = { state: 'outcome-unknown', mayHaveBeenSent: true } as HeldPrivateRequest;
    expect(savedRequestLabel(entry)).toContain('may have reached');
    expect(savedRequestLabel({ ...entry, state: 'expired' })).toContain('earlier attempt');
    expect(savedRequestLabel({ ...entry, state: 'held', mayHaveBeenSent: false })).toContain('not sent');
  });
});
