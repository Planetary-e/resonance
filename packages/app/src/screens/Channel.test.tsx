import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ChannelScreen from './Channel.js';

describe('protocol v2 channel controls', () => {
  it('lets an open pairwise channel send disclosures without offering obsolete consent actions', () => {
    const html = renderToStaticMarkup(
      <ChannelScreen
        channels={[]}
        activeChannel={{
          id: 'channel-test', matchId: 'match-test', partnerDID: 'rel-test',
          state: 'open', protocolVersion: 2,
        }}
        messages={[]}
        onSelect={async () => {}}
        onDisclose={async () => ({})}
        onAccept={async () => ({})}
        onReject={async () => ({})}
        onClose={async () => ({})}
        onToast={() => {}}
      />,
    );

    expect(html).toContain('Share a disclosure...');
    expect(html).toContain('Send');
    expect(html).toContain('Close');
    expect(html).not.toContain('>Accept<');
    expect(html).not.toContain('>Reject<');
  });
});
