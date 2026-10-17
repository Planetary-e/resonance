import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Dashboard from './Dashboard.js';
import type { RelayStatus } from '../api.client.js';
vi.mock('../components/AdmissionWallet.js', () => ({ default: () => null }));

it('distinguishes a listening relay from prepared admission without implying current quorum health', () => {
  const state: RelayStatus = { enabled: true, running: true, admissionReady: false, port: 9091, contacts: [], controls: {}, stats: null };
  const render = (changes: Partial<RelayStatus>) => renderToStaticMarkup(<Dashboard status={null} channelCount={0}
    relayStatus={{ ...state, ...changes }} onRelayToggle={() => {}} activities={[]} onWalletChange={async () => {}} />);
  expect(render({})).toContain('Relay Preparing');
  expect(render({})).toContain('New user requests are unavailable');
  expect(render({})).not.toContain('Relay Active');
  expect(render({ admissionReady: true })).toContain('Relay Active');
  expect(render({ admissionReady: null })).toContain('Admission readiness has not been reported');
  expect(render({ admissionReady: null })).not.toContain('Relay Active');
  expect(render({ running: false })).toContain('Relay Starting');
  expect(render({ enabled: false, running: false })).toContain('Relay Off');
});
