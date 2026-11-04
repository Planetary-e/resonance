import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Publish from './Publish.js';
import type { Item, PublicationDelivery } from '../api.client.js';
const item: Item = { id: 'one', type: 'offer', rawText: 'A saved offer.', privacyLevel: 'medium', epsilon: 1, status: 'local', createdAt: new Date().toISOString() };
function render(state: PublicationDelivery['state'], mayHaveBeenSent: boolean, privateDeliveryAvailable = true) {
  return renderToStaticMarkup(<Publish privateDeliveryAvailable={privateDeliveryAvailable}
    items={[{ ...item, delivery: { id: 'out_test', state, mayHaveBeenSent, expiresAt: Date.now() + 86_400_000 } }]}
    onPublish={async () => ({ id: '', status: '', dims: 0 })} onWithdraw={async () => ({})}
    onOutboxAction={async () => ({})} onToast={() => {}} />);
}
describe('saved publication controls', () => {
  it('offers explicit send/cancel and no withdrawal or anonymity claim for a local hold', () => {
    const html = render('held', false);
    expect(html).toContain('Saved on this device; not sent'); expect(html).toContain('>Send<'); expect(html).toContain('>Cancel<');
    expect(html).not.toContain('>Withdraw<'); expect(html).toContain('never send automatically');
    expect(render('held', false, false)).not.toContain('id="publication-delivery"');
  });
  it('keeps uncertain delivery honest and permits an exact retry, not a false cancellation', () => {
    const html = render('outcome-unknown', true);
    expect(html).toContain('a relay may have accepted it'); expect(html).toContain('Retry same publication');
    expect(html).not.toContain('>Cancel<'); expect(html).not.toContain('>Withdraw<');
    expect(render('expired', true)).toContain('earlier delivery not confirmed');
    expect(render('cancelled', false)).toContain('Cancelled; not sent');
  });
});
