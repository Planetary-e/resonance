/** Durable protocol v2 consent and pairwise channel establishment. */

import {
  createChannelCloseOperationV2,
  createChannelMessageOperationV2,
  createConsentAcceptV2,
  createConsentOfferV2,
  createMailboxEnvelopeId,
  createPairwiseChannelId,
  decodeBase64,
  deriveSharedSecret,
  decryptChannelOperationV2,
  decryptChannelContentV2,
  encryptChannelOperationV2,
  encryptRelationshipMessage,
  generateRelationshipKeyMaterial,
  type ConsentAcceptV2,
  type ConsentOfferV2,
  type ChannelContentV2,
  type ChannelOperationV2,
  type PublicationMailboxRecipient,
  type RelationshipMessageV2,
} from '@resonance/core';
import type { RelayClient } from './relay-client.js';
import type {
  LocalStore,
  StoredMailboxMatch,
  StoredPairwiseChannel,
  StoredPairwiseMessage,
  StoredPublication,
} from './store.js';

export interface PairwiseChannelSyncResult {
  matchesAdded: number;
  messagesProcessed: number;
  channelsActivated: number;
  channelOperationsProcessed: number;
}

export interface PairwiseChannelManagerV2 {
  initiate(matchId: string): Promise<StoredPairwiseChannel>;
  syncMailboxes(): Promise<PairwiseChannelSyncResult>;
  sendDisclosure(
    channelId: string,
    text: string,
    level: ChannelContentV2['level'],
  ): Promise<StoredPairwiseMessage>;
  close(channelId: string): Promise<StoredPairwiseChannel>;
  getByMatchId(matchId: string): StoredPairwiseChannel | null;
  getByChannelId(channelId: string): StoredPairwiseChannel | null;
  listMessages(channelId: string): StoredPairwiseMessage[];
  list(): StoredPairwiseChannel[];
}

export function createPairwiseChannelManagerV2(
  store: LocalStore,
  relayClient: RelayClient,
): PairwiseChannelManagerV2 {
  function channelById(channelId: string): StoredPairwiseChannel {
    const channel = store.listPairwiseChannels().find((candidate) => candidate.channelId === channelId);
    if (!channel) throw new Error(`No protocol v2 channel found for ${channelId}`);
    return channel;
  }

  function findMatch(matchId: string, localPublicationId?: string): StoredMailboxMatch {
    const match = store.listMailboxMatches().find((candidate) => (
      candidate.matchId === matchId
      && (!localPublicationId || candidate.publicationId === localPublicationId)
    ));
    if (!match) throw new Error(`No protocol v2 mailbox match found for ${matchId}`);
    return match;
  }

  function publicationForMatch(match: StoredMailboxMatch): StoredPublication {
    const publication = store.getPublication(match.publicationId);
    if (!publication || publication.tombstone) {
      throw new Error(`Active local publication is unavailable for match ${match.matchId}`);
    }
    return publication;
  }

  function partnerRecipient(match: StoredMailboxMatch): PublicationMailboxRecipient {
    return {
      publicationId: match.notice.payload.partnerPublicationId,
      mailbox: match.notice.payload.partnerMailbox,
    };
  }

  function verifyCounterparty(
    message: RelationshipMessageV2,
    match: StoredMailboxMatch,
  ): void {
    if (message.matchId !== match.matchId
      || message.recipientPublicationId !== match.publicationId
      || message.senderPublicationId !== match.partnerPublicationId
      || message.senderPublicationKey !== match.notice.payload.partnerPublicationKey) {
      throw new Error('Relationship message is not from the matched publication');
    }
    if (message.expiresAt <= Date.now()) throw new Error('Relationship message has expired');
  }

  async function sendAcceptance(
    acceptance: ConsentAcceptV2,
    publication: StoredPublication,
    match: StoredMailboxMatch,
  ): Promise<void> {
    const recipient = partnerRecipient(match);
    const envelope = encryptRelationshipMessage(acceptance, recipient);
    await relayClient.depositMailboxEnvelope(
      match.matchId,
      publication.record,
      recipient,
      publication.keys,
      envelope,
    );
  }

  async function handleOffer(
    offer: ConsentOfferV2,
    publication: StoredPublication,
    match: StoredMailboxMatch,
  ): Promise<boolean> {
    const existing = store.getPairwiseChannelByMatchId(match.matchId);
    if (existing?.status === 'closed') throw new Error('Pairwise channel is closed locally');

    const existingAcceptance = existing?.accept;
    if (existingAcceptance?.offerId === offer.messageId) {
      await sendAcceptance(existingAcceptance, publication, match);
      return false;
    }

    const localKeys = existing?.localKeys ?? generateRelationshipKeyMaterial();
    const acceptance = createConsentAcceptV2(
      offer,
      publication.record,
      publication.keys,
      localKeys,
      Date.now(),
      offer.expiresAt,
    );
    if (existing?.channelId && existing.channelId !== acceptance.channelId) {
      throw new Error('Matched publication attempted to replace established relationship keys');
    }
    const sharedKey = deriveSharedSecret(
      localKeys.channelKeyPair.secretKey,
      decodeBase64(offer.senderChannelKey),
    );
    const now = new Date().toISOString();
    const active: StoredPairwiseChannel = {
      channelId: acceptance.channelId,
      matchId: match.matchId,
      localPublicationId: publication.publicationId,
      partnerPublicationId: match.partnerPublicationId,
      role: existing?.role ?? 'responder',
      status: 'active',
      localKeys,
      partnerRelationshipId: offer.senderRelationshipId,
      partnerRelationshipKey: offer.senderRelationshipKey,
      partnerChannelKey: offer.senderChannelKey,
      partnerMailbox: offer.senderMailbox,
      sharedKey,
      nextOutboundSequence: existing?.nextOutboundSequence ?? 0,
      lastInboundSequence: existing?.lastInboundSequence ?? -1,
      pendingOutbound: existing?.pendingOutbound ?? null,
      offer: existing?.offer ?? offer,
      accept: acceptance,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Persist the established keys before acknowledging either the sender or relay.
    store.upsertPairwiseChannel(active);
    await sendAcceptance(acceptance, publication, match);
    return existing?.status !== 'active';
  }

  function handleAcceptance(
    acceptance: ConsentAcceptV2,
    publication: StoredPublication,
    match: StoredMailboxMatch,
  ): boolean {
    const existing = store.getPairwiseChannelByMatchId(match.matchId);
    if (!existing || existing.offer.messageId !== acceptance.offerId) {
      throw new Error('Consent acceptance does not reference a local offer');
    }
    if (acceptance.recipientRelationshipId !== existing.localKeys.relationshipId) {
      throw new Error('Consent acceptance targets a different relationship identity');
    }
    const expectedChannelId = createPairwiseChannelId(
      match.matchId,
      existing.localKeys.relationshipId,
      acceptance.senderRelationshipId,
    );
    if (acceptance.channelId !== expectedChannelId
      || (existing.channelId && existing.channelId !== expectedChannelId)) {
      throw new Error('Consent acceptance channel binding is invalid');
    }
    const sharedKey = deriveSharedSecret(
      existing.localKeys.channelKeyPair.secretKey,
      decodeBase64(acceptance.senderChannelKey),
    );
    const wasActive = existing.status === 'active';
    store.upsertPairwiseChannel({
      ...existing,
      channelId: acceptance.channelId,
      status: 'active',
      partnerRelationshipId: acceptance.senderRelationshipId,
      partnerRelationshipKey: acceptance.senderRelationshipKey,
      partnerChannelKey: acceptance.senderChannelKey,
      partnerMailbox: acceptance.senderMailbox,
      sharedKey,
      accept: acceptance,
      updatedAt: new Date().toISOString(),
    });
    return !wasActive;
  }

  async function flushPending(channel: StoredPairwiseChannel): Promise<StoredPairwiseChannel> {
    if (!channel.pendingOutbound) return channel;
    if (!channel.partnerMailbox || !channel.partnerRelationshipId) {
      throw new Error('Pairwise channel is missing its partner mailbox');
    }
    const envelope = encryptChannelOperationV2(channel.pendingOutbound, channel.partnerMailbox);
    await relayClient.depositRelationshipMailboxEnvelope(
      channel.partnerRelationshipId,
      channel.localKeys,
      envelope,
    );
    const sent = {
      ...channel,
      status: channel.pendingOutbound.kind === 'channel-close' ? 'closed' as const : channel.status,
      pendingOutbound: null,
      updatedAt: new Date().toISOString(),
    };
    store.upsertPairwiseChannel(sent);
    return sent;
  }

  async function syncRelationshipMailboxes(): Promise<number> {
    let processed = 0;
    for (const listed of store.listPairwiseChannels()) {
      let channel = listed.pendingOutbound ? await flushPending(listed) : listed;
      if (!channel.channelId || !channel.partnerRelationshipId || !channel.partnerRelationshipKey
        || !channel.sharedKey || channel.status === 'offer-sent') continue;
      const inbox = await relayClient.fetchRelationshipMailbox(channel.localKeys);
      const acknowledgements: string[] = [];
      const incoming: Array<{ envelope: (typeof inbox.envelopes)[number]; operation: ChannelOperationV2 }> = [];
      for (const envelope of inbox.envelopes) {
        try {
          incoming.push({ envelope, operation: decryptChannelOperationV2(envelope, channel.localKeys) });
        } catch {
          // A malformed opaque deposit must not permanently poison a mailbox.
          store.recordMailboxReceipt(envelope.envelopeId, channel.localKeys.mailboxId, 'invalid-channel-operation');
          acknowledgements.push(envelope.envelopeId);
        }
      }
      incoming.sort((a, b) => a.operation.sequence - b.operation.sequence);
      for (const { envelope, operation } of incoming) {
        if (store.hasMailboxReceipt(envelope.envelopeId)) {
          acknowledgements.push(envelope.envelopeId);
          continue;
        }
        if (operation.channelId !== channel.channelId
          || operation.senderRelationshipId !== channel.partnerRelationshipId
          || operation.senderRelationshipKey !== channel.partnerRelationshipKey
          || operation.recipientRelationshipId !== channel.localKeys.relationshipId) {
          store.recordMailboxReceipt(envelope.envelopeId, channel.localKeys.mailboxId, 'foreign-channel-operation');
          acknowledgements.push(envelope.envelopeId);
          continue;
        }
        if (operation.expiresAt <= Date.now()) {
          store.recordMailboxReceipt(envelope.envelopeId, channel.localKeys.mailboxId, 'expired-channel-operation');
          acknowledgements.push(envelope.envelopeId);
          continue;
        }
        if (operation.sequence <= channel.lastInboundSequence) {
          store.recordMailboxReceipt(envelope.envelopeId, channel.localKeys.mailboxId, 'duplicate-channel-operation');
          acknowledgements.push(envelope.envelopeId);
          continue;
        }
        if (operation.sequence !== channel.lastInboundSequence + 1) continue;

        let message: StoredPairwiseMessage;
        if (operation.kind === 'channel-message') {
          const content = decryptChannelContentV2(operation, channel.sharedKey!);
          message = {
            messageId: operation.messageId,
            channelId: operation.channelId,
            direction: 'received',
            sequence: operation.sequence,
            kind: 'disclosure',
            content,
            createdAt: new Date(operation.createdAt).toISOString(),
          };
        } else {
          message = {
            messageId: operation.messageId,
            channelId: operation.channelId,
            direction: 'received',
            sequence: operation.sequence,
            kind: 'close',
            content: null,
            createdAt: new Date(operation.createdAt).toISOString(),
          };
        }
        // Persist content and the sequence watermark before acknowledging the relay.
        channel = {
          ...channel,
          status: operation.kind === 'channel-close' ? 'closed' : channel.status,
          lastInboundSequence: operation.sequence,
          updatedAt: new Date().toISOString(),
        };
        store.commitPairwiseInbound(channel, message, envelope.envelopeId, channel.localKeys.mailboxId);
        acknowledgements.push(envelope.envelopeId);
        processed++;
      }
      if (acknowledgements.length > 0) {
        await relayClient.acknowledgeRelationshipMailbox(channel.localKeys, acknowledgements);
      }
    }
    return processed;
  }

  return {
    async initiate(matchId: string): Promise<StoredPairwiseChannel> {
      const match = findMatch(matchId);
      const publication = publicationForMatch(match);
      const recipient = partnerRecipient(match);
      let channel = store.getPairwiseChannelByMatchId(matchId);
      if (!channel) {
        const localKeys = generateRelationshipKeyMaterial();
        const now = Date.now();
        const offer = createConsentOfferV2(
          matchId,
          publication.record,
          recipient,
          publication.keys,
          localKeys,
          now,
          Math.min(match.notice.payload.expiresAt, publication.record.expiresAt),
        );
        const timestamp = new Date(now).toISOString();
        channel = {
          channelId: null,
          matchId,
          localPublicationId: publication.publicationId,
          partnerPublicationId: match.partnerPublicationId,
          role: 'initiator',
          status: 'offer-sent',
          localKeys,
          partnerRelationshipId: null,
          partnerRelationshipKey: null,
          partnerChannelKey: null,
          partnerMailbox: null,
          sharedKey: null,
          nextOutboundSequence: 0,
          lastInboundSequence: -1,
          pendingOutbound: null,
          offer,
          accept: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        // Persist first so a failed send can safely retry the identical offer.
        store.upsertPairwiseChannel(channel);
      }

      if (channel.status === 'offer-sent') {
        const envelope = encryptRelationshipMessage(channel.offer, recipient);
        await relayClient.depositMailboxEnvelope(
          matchId,
          publication.record,
          recipient,
          publication.keys,
          envelope,
        );
      }
      return store.getPairwiseChannelByMatchId(matchId)!;
    },

    async syncMailboxes(): Promise<PairwiseChannelSyncResult> {
      let matchesAdded = 0;
      let messagesProcessed = 0;
      let channelsActivated = 0;

      for (const publication of store.listPublications()) {
        if (publication.tombstone) continue;
        const inbox = await relayClient.fetchMailbox(publication.record, publication.keys);

        for (const notice of inbox.notices) {
          if (store.insertMailboxMatch(publication.itemId, notice)) matchesAdded++;
        }

        for (const message of inbox.relationshipMessages) {
          const envelopeId = createMailboxEnvelopeId(message.messageId, publication.record.mailbox.id);
          if (store.hasMailboxReceipt(envelopeId)) continue;
          const match = findMatch(message.matchId, publication.publicationId);
          verifyCounterparty(message, match);
          const activated = message.kind === 'consent-offer'
            ? await handleOffer(message, publication, match)
            : handleAcceptance(message, publication, match);
          store.recordMailboxReceipt(envelopeId, publication.record.mailbox.id, 'relationship-message');
          messagesProcessed++;
          if (activated) channelsActivated++;
        }

        if (inbox.envelopes.length > 0) {
          await relayClient.acknowledgeMailbox(
            publication.record,
            publication.keys,
            inbox.envelopes.map((envelope) => envelope.envelopeId),
          );
        }
      }
      const channelOperationsProcessed = await syncRelationshipMailboxes();
      return { matchesAdded, messagesProcessed, channelsActivated, channelOperationsProcessed };
    },

    async sendDisclosure(channelId, text, level): Promise<StoredPairwiseMessage> {
      let channel = await flushPending(channelById(channelId));
      if (channel.status !== 'active' || !channel.sharedKey || !channel.partnerRelationshipId) {
        throw new Error('Pairwise channel is not active');
      }
      const createdAt = Date.now();
      const content: ChannelContentV2 = { kind: 'disclosure', text, level, createdAt };
      const operation = createChannelMessageOperationV2(
        channelId,
        channel.partnerRelationshipId,
        channel.nextOutboundSequence,
        content,
        channel.sharedKey,
        channel.localKeys,
        createdAt,
      );
      const message: StoredPairwiseMessage = {
        messageId: operation.messageId,
        channelId,
        direction: 'sent',
        sequence: operation.sequence,
        kind: 'disclosure',
        content,
        createdAt: new Date(createdAt).toISOString(),
      };
      channel = {
        ...channel,
        nextOutboundSequence: channel.nextOutboundSequence + 1,
        pendingOutbound: operation,
        updatedAt: new Date().toISOString(),
      };
      store.commitPairwiseOutbound(channel, message);
      await flushPending(channel);
      return message;
    },

    async close(channelId): Promise<StoredPairwiseChannel> {
      let channel = await flushPending(channelById(channelId));
      if (channel.status === 'closed') return channel;
      if (channel.status !== 'active' || !channel.partnerRelationshipId) {
        throw new Error('Pairwise channel is not active');
      }
      const createdAt = Date.now();
      const operation: ChannelOperationV2 = createChannelCloseOperationV2(
        channelId,
        channel.partnerRelationshipId,
        channel.nextOutboundSequence,
        channel.localKeys,
        createdAt,
      );
      const message: StoredPairwiseMessage = {
        messageId: operation.messageId,
        channelId,
        direction: 'sent',
        sequence: operation.sequence,
        kind: 'close',
        content: null,
        createdAt: new Date(createdAt).toISOString(),
      };
      channel = {
        ...channel,
        status: 'closing',
        nextOutboundSequence: channel.nextOutboundSequence + 1,
        pendingOutbound: operation,
        updatedAt: new Date().toISOString(),
      };
      store.commitPairwiseOutbound(channel, message);
      return flushPending(channel);
    },

    getByMatchId(matchId: string): StoredPairwiseChannel | null {
      return store.getPairwiseChannelByMatchId(matchId);
    },

    getByChannelId(channelId: string): StoredPairwiseChannel | null {
      return store.listPairwiseChannels().find((channel) => channel.channelId === channelId) ?? null;
    },

    listMessages(channelId: string): StoredPairwiseMessage[] {
      return store.listPairwiseMessages(channelId);
    },

    list(): StoredPairwiseChannel[] {
      return store.listPairwiseChannels();
    },
  };
}
