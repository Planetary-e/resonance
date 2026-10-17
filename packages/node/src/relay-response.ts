/** Application schemas checked after authenticating the signed relay envelope. */
import { MAILBOX_RESPONSE_MESSAGE_TYPE, MessageTypes, verifyMailboxEnvelope,
  type AckPayload, type EncryptedMailboxEnvelope, type Message } from '@resonance/core';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseRelayAcknowledgement(value: unknown): AckPayload {
  if (!object(value) || Object.keys(value).sort().join(',') !== (Object.hasOwn(value, 'message') ? 'message,ref,status' : 'ref,status')
    || typeof value.ref !== 'string' || !value.ref.length || value.ref.length > 256
    || (value.status !== 'ok' && value.status !== 'error')
    || (Object.hasOwn(value, 'message') && (typeof value.message !== 'string' || value.message.length > 4096))) {
    throw new Error('Invalid relay acknowledgement payload');
  }
  return value as unknown as AckPayload;
}

export function parseRelayMailbox(message: Message, requestId: string, mailboxId: string): EncryptedMailboxEnvelope[] {
  if (message.type === MessageTypes.ACK) {
    const ack = parseRelayAcknowledgement(message.payload);
    if (ack.ref !== requestId || ack.status !== 'error') throw new Error('Unexpected mailbox acknowledgement');
    throw new Error(ack.message ?? 'Relay rejected mailbox fetch');
  }
  if (message.type !== MAILBOX_RESPONSE_MESSAGE_TYPE) throw new Error('Unexpected mailbox response type');
  const payload = message.payload;
  if (!object(payload) || Object.keys(payload).sort().join(',') !== 'envelopes,mailboxId,requestId'
    || payload.requestId !== requestId || payload.mailboxId !== mailboxId
    || !Array.isArray(payload.envelopes) || payload.envelopes.length > 100) throw new Error('Mailbox response does not match request or exceeds its bound');
  const seen = new Set<string>();
  for (const envelope of payload.envelopes) {
    if (!verifyMailboxEnvelope(envelope) || envelope.mailboxId !== mailboxId || seen.has(envelope.envelopeId)) {
      throw new Error('Invalid or duplicate envelope in mailbox response');
    }
    seen.add(envelope.envelopeId);
  }
  return payload.envelopes;
}
