/**
 * Encrypted local data store backed by SQLite (sql.js — pure WASM, no native code).
 *
 * Sensitive fields (raw_text, embedding) are encrypted with secretbox
 * using a key derived from the user's identity. Perturbed embeddings
 * are stored unencrypted since they're public data sent to relays.
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  secretboxEncrypt,
  secretboxDecrypt,
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  encodeUTF8,
  type ItemType,
  type MatchNoticePayload,
  type Message,
  type ConsentOfferV2,
  type ConsentAcceptV2,
  type ChannelContentV2,
  type ChannelOperationV2,
  type PublicationKeyMaterial,
  type PublicationRecord,
  type PublicationTombstone,
  type PrivacyLevel,
  type RelationshipKeyMaterial,
  type RelationshipMailboxV2,
  verifyConsentOfferV2,
  verifyConsentAcceptV2,
  verifyChannelOperationV2,
  verifyPublicationRecord,
  verifyPublicationTombstone,
  verifyMatchNoticeMessage,
} from '@resonance/core';

// --- Public types ---

export interface StoredItem {
  id: string;
  type: ItemType;
  rawText: string;
  embedding: Float32Array;
  perturbed: Float32Array | null;
  privacyLevel: PrivacyLevel;
  epsilon: number | null;
  status: 'local' | 'published' | 'withdrawn';
  createdAt: string;
  updatedAt: string;
}

export interface CreateItemInput {
  id: string;
  type: ItemType;
  rawText: string;
  embedding: Float32Array;
  privacyLevel: PrivacyLevel;
  perturbed?: Float32Array;
  epsilon?: number;
}

export interface StoredMatch {
  id: string;
  itemId: string;
  partnerDID: string;
  similarity: number;
  relayId: string | null;
  status: 'pending' | 'consented' | 'confirmed' | 'rejected' | 'expired';
  createdAt: string;
}

export interface CreateMatchInput {
  id: string;
  itemId: string;
  partnerDID: string;
  similarity: number;
  relayId?: string;
}

export interface StoredChannel {
  id: string;
  matchId: string;
  partnerDID: string;
  sharedKey: Uint8Array | null;
  status: 'pending' | 'active' | 'closed';
  createdAt: string;
}

export interface CreateChannelInput {
  id: string;
  matchId: string;
  partnerDID: string;
  sharedKey?: Uint8Array;
}

export interface StoredPublication {
  itemId: string;
  publicationId: string;
  record: PublicationRecord;
  tombstone: PublicationTombstone | null;
  keys: PublicationKeyMaterial;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMailboxMatch {
  matchId: string;
  itemId: string;
  publicationId: string;
  partnerPublicationId: string;
  partnerMailboxId: string;
  similarity: number;
  notice: Message<MatchNoticePayload>;
  createdAt: string;
}

export interface StoredPairwiseChannel {
  channelId: string | null;
  matchId: string;
  localPublicationId: string;
  partnerPublicationId: string;
  role: 'initiator' | 'responder';
  status: 'offer-sent' | 'active' | 'closing' | 'closed';
  localKeys: RelationshipKeyMaterial;
  partnerRelationshipId: string | null;
  partnerRelationshipKey: string | null;
  partnerChannelKey: string | null;
  partnerMailbox: RelationshipMailboxV2 | null;
  sharedKey: Uint8Array | null;
  nextOutboundSequence: number;
  lastInboundSequence: number;
  pendingOutbound: ChannelOperationV2 | null;
  offer: ConsentOfferV2;
  accept: ConsentAcceptV2 | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredPairwiseMessage {
  messageId: string;
  channelId: string;
  direction: 'sent' | 'received';
  sequence: number;
  kind: 'disclosure' | 'close';
  content: ChannelContentV2 | null;
  createdAt: string;
}

export interface LocalStore {
  insertItem(input: CreateItemInput): void;
  getItem(id: string): StoredItem | null;
  listItems(filter?: { type?: ItemType; status?: string }): StoredItem[];
  updateItemStatus(id: string, status: string): void;
  setPerturbed(id: string, perturbed: Float32Array, epsilon: number): void;

  insertPublication(itemId: string, record: PublicationRecord, keys: PublicationKeyMaterial): void;
  getPublication(publicationId: string): StoredPublication | null;
  getPublicationForItem(itemId: string): StoredPublication | null;
  setPublicationTombstone(itemId: string, tombstone: PublicationTombstone): void;
  listPublications(): StoredPublication[];
  insertMailboxMatch(itemId: string, notice: Message<MatchNoticePayload>): boolean;
  listMailboxMatches(): StoredMailboxMatch[];
  upsertPairwiseChannel(channel: StoredPairwiseChannel): void;
  getPairwiseChannelByMatchId(matchId: string): StoredPairwiseChannel | null;
  listPairwiseChannels(): StoredPairwiseChannel[];
  insertPairwiseMessage(message: StoredPairwiseMessage): boolean;
  listPairwiseMessages(channelId: string): StoredPairwiseMessage[];
  commitPairwiseOutbound(channel: StoredPairwiseChannel, message: StoredPairwiseMessage): void;
  commitPairwiseInbound(
    channel: StoredPairwiseChannel,
    message: StoredPairwiseMessage,
    envelopeId: string,
    mailboxId: string,
  ): void;
  hasMailboxReceipt(envelopeId: string): boolean;
  recordMailboxReceipt(envelopeId: string, mailboxId: string, payloadType: string): void;

  insertMatch(input: CreateMatchInput): void;
  getMatch(id: string): StoredMatch | null;
  listMatches(filter?: { status?: string }): StoredMatch[];
  updateMatchStatus(id: string, status: StoredMatch['status']): void;

  insertChannel(input: CreateChannelInput): void;
  getChannel(id: string): StoredChannel | null;
  getChannelByMatchId(matchId: string): StoredChannel | null;
  updateChannelStatus(id: string, status: StoredChannel['status']): void;
  updateChannelSharedKey(id: string, sharedKey: Uint8Array): void;

  close(): void;
}

// --- Schema ---

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL CHECK(type IN ('need', 'offer')),
  raw_text_encrypted   BLOB NOT NULL,
  raw_text_nonce       BLOB NOT NULL,
  embedding_encrypted  BLOB NOT NULL,
  embedding_nonce      BLOB NOT NULL,
  perturbed            BLOB,
  privacy_level        TEXT NOT NULL DEFAULT 'medium' CHECK(privacy_level IN ('low', 'medium', 'high')),
  epsilon              REAL,
  status               TEXT NOT NULL DEFAULT 'local' CHECK(status IN ('local', 'published', 'withdrawn')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES items(id),
  partner_did  TEXT NOT NULL,
  similarity   REAL NOT NULL,
  relay_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'consented', 'confirmed', 'rejected', 'expired')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id                   TEXT PRIMARY KEY,
  match_id             TEXT NOT NULL REFERENCES matches(id),
  partner_did          TEXT NOT NULL,
  shared_key_encrypted BLOB,
  shared_key_nonce     BLOB,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'closed')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_matches_item_id ON matches(item_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS publication_secrets (
  item_id                      TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  publication_id               TEXT NOT NULL UNIQUE,
  record_json                  TEXT NOT NULL,
  tombstone_json               TEXT,
  signing_secret_encrypted     BLOB NOT NULL,
  signing_secret_nonce         BLOB NOT NULL,
  mailbox_secret_encrypted     BLOB NOT NULL,
  mailbox_secret_nonce         BLOB NOT NULL,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_publication_secrets_publication_id
  ON publication_secrets(publication_id);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS mailbox_matches (
  match_id          TEXT NOT NULL,
  item_id           TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  publication_id    TEXT NOT NULL,
  notice_encrypted  BLOB NOT NULL,
  notice_nonce      BLOB NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (match_id, publication_id)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_matches_item_id ON mailbox_matches(item_id);
CREATE INDEX IF NOT EXISTS idx_mailbox_matches_publication_id ON mailbox_matches(publication_id);
`;

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS pairwise_channels (
  match_id          TEXT PRIMARY KEY,
  channel_id        TEXT UNIQUE,
  state_encrypted   BLOB NOT NULL,
  state_nonce       BLOB NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_receipts (
  envelope_id       TEXT PRIMARY KEY,
  mailbox_id        TEXT NOT NULL,
  payload_type      TEXT NOT NULL,
  received_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pairwise_channels_channel_id ON pairwise_channels(channel_id);
CREATE INDEX IF NOT EXISTS idx_mailbox_receipts_mailbox_id ON mailbox_receipts(mailbox_id);
`;

const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS pairwise_messages (
  message_id          TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
  sequence            INTEGER NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN ('disclosure', 'close')),
  content_encrypted   BLOB,
  content_nonce       BLOB,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairwise_messages_channel_sequence
  ON pairwise_messages(channel_id, sequence, created_at);
`;

// --- Internal helpers ---

function float32ToBytes(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bytesToFloat32(bytes: Uint8Array): Float32Array {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Float32Array(ab);
}

function encryptField(data: Uint8Array, key: Uint8Array): { encrypted: Uint8Array; nonce: Uint8Array } {
  const result = secretboxEncrypt(data, key);
  return { encrypted: result.ciphertext, nonce: result.nonce };
}

function decryptField(encrypted: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  const result = secretboxDecrypt(encrypted, nonce, key);
  if (!result) throw new Error('Decryption failed — wrong key or corrupted data');
  return result;
}

// --- sql.js initialization (cached) ---

let sqlPromise: Promise<any> | null = null;
function getSqlJs(): Promise<any> {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise!;
}

// --- Migration ---

function migrate(db: SqlJsDatabase): void {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'");
  if (result.length === 0 || result[0].values.length === 0) {
    db.run(SCHEMA_V1);
    db.run('INSERT INTO schema_version (version) VALUES (?)', [1]);
  }

  const versionRow = queryOne(db, 'SELECT version FROM schema_version LIMIT 1');
  const version = Number(versionRow?.version ?? 0);
  if (version > 5) throw new Error(`Database schema version ${version} is newer than this client supports`);

  if (version < 2) {
    db.run('BEGIN');
    try {
      db.run(SCHEMA_V2);
      db.run('UPDATE schema_version SET version = 2');
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  if (version < 3) {
    db.run('BEGIN');
    try {
      db.run(SCHEMA_V3);
      db.run('UPDATE schema_version SET version = 3');
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  if (version < 4) {
    db.run('BEGIN');
    try {
      db.run(SCHEMA_V4);
      db.run('UPDATE schema_version SET version = 4');
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  if (version < 5) {
    db.run('BEGIN');
    try {
      db.run(SCHEMA_V5);
      db.run('UPDATE schema_version SET version = 5');
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }
}

// --- Query helpers ---

function queryOne(db: SqlJsDatabase, sql: string, params: any[] = []): Record<string, any> | null {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject();
  stmt.free();
  return row as Record<string, any>;
}

function queryAll(db: SqlJsDatabase, sql: string, params: any[] = []): Record<string, any>[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: Record<string, any>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, any>);
  }
  stmt.free();
  return rows;
}

// --- Store implementation ---

export function openStore(dbPath: string, encryptionKey: Uint8Array): LocalStore {
  // sql.js requires async init, but we cache the SQL module.
  // For openStore to remain sync, we initialize sql.js eagerly before calling openStore.
  // Use openStoreAsync for the first call.
  throw new Error('Use openStoreAsync() instead');
}

export async function openStoreAsync(dbPath: string, encryptionKey: Uint8Array): Promise<LocalStore> {
  const SQL = await getSqlJs();

  let db: SqlJsDatabase;
  if (dbPath === ':memory:') {
    db = new SQL.Database();
  } else if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  migrate(db);

  const key = encryptionKey;
  const filePath = dbPath === ':memory:' ? null : dbPath;

  function persist(): void {
    if (!filePath) return;
    const data = db.export();
    writeFileSync(filePath, Buffer.from(data));
  }

  function decryptRow(row: Record<string, any>): StoredItem {
    const rawTextBytes = decryptField(
      new Uint8Array(row.raw_text_encrypted),
      new Uint8Array(row.raw_text_nonce),
      key,
    );
    const embeddingBytes = decryptField(
      new Uint8Array(row.embedding_encrypted),
      new Uint8Array(row.embedding_nonce),
      key,
    );

    return {
      id: row.id as string,
      type: row.type as ItemType,
      rawText: encodeUTF8(rawTextBytes),
      embedding: bytesToFloat32(embeddingBytes),
      perturbed: row.perturbed ? bytesToFloat32(new Uint8Array(row.perturbed)) : null,
      privacyLevel: row.privacy_level as PrivacyLevel,
      epsilon: row.epsilon as number | null,
      status: row.status as StoredItem['status'],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  function decryptChannelRow(row: Record<string, any>): StoredChannel {
    let sharedKey: Uint8Array | null = null;
    if (row.shared_key_encrypted && row.shared_key_nonce) {
      sharedKey = decryptField(
        new Uint8Array(row.shared_key_encrypted),
        new Uint8Array(row.shared_key_nonce),
        key,
      );
    }
    return {
      id: row.id as string,
      matchId: row.match_id as string,
      partnerDID: row.partner_did as string,
      sharedKey,
      status: row.status as StoredChannel['status'],
      createdAt: row.created_at as string,
    };
  }

  function decryptPublicationRow(row: Record<string, any>): StoredPublication {
    const record: unknown = JSON.parse(row.record_json as string);
    if (!verifyPublicationRecord(record)) throw new Error('Stored publication record is invalid');

    let tombstone: PublicationTombstone | null = null;
    if (row.tombstone_json) {
      const parsed: unknown = JSON.parse(row.tombstone_json as string);
      if (!verifyPublicationTombstone(parsed) || parsed.publicationId !== record.publicationId) {
        throw new Error('Stored publication tombstone is invalid');
      }
      tombstone = parsed;
    }

    const signingSecret = decryptField(
      new Uint8Array(row.signing_secret_encrypted),
      new Uint8Array(row.signing_secret_nonce),
      key,
    );
    const mailboxSecret = decryptField(
      new Uint8Array(row.mailbox_secret_encrypted),
      new Uint8Array(row.mailbox_secret_nonce),
      key,
    );

    return {
      itemId: row.item_id as string,
      publicationId: row.publication_id as string,
      record,
      tombstone,
      keys: {
        publicationId: record.publicationId,
        signingKeyPair: {
          publicKey: decodeBase64(record.publicationKey),
          secretKey: signingSecret,
        },
        mailboxId: record.mailbox.id,
        mailboxKeyPair: {
          publicKey: decodeBase64(record.mailbox.encryptionKey),
          secretKey: mailboxSecret,
        },
      },
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  function decryptMailboxMatchRow(row: Record<string, any>): StoredMailboxMatch {
    const plaintext = decryptField(
      new Uint8Array(row.notice_encrypted),
      new Uint8Array(row.notice_nonce),
      key,
    );
    const notice: unknown = JSON.parse(encodeUTF8(plaintext));
    if (!verifyMatchNoticeMessage(notice)) throw new Error('Stored mailbox match notice is invalid');
    return {
      matchId: notice.payload.matchId,
      itemId: row.item_id as string,
      publicationId: notice.payload.recipientPublicationId,
      partnerPublicationId: notice.payload.partnerPublicationId,
      partnerMailboxId: notice.payload.partnerMailbox.id,
      similarity: notice.payload.similarity,
      notice,
      createdAt: row.created_at as string,
    };
  }

  function encryptPairwiseChannel(channel: StoredPairwiseChannel): {
    encrypted: Uint8Array;
    nonce: Uint8Array;
  } {
    validatePairwiseChannel(channel);
    const serializable = {
      ...channel,
      localKeys: {
        relationshipId: channel.localKeys.relationshipId,
        signingPublicKey: encodeBase64(channel.localKeys.signingKeyPair.publicKey),
        signingSecretKey: encodeBase64(channel.localKeys.signingKeyPair.secretKey),
        channelPublicKey: encodeBase64(channel.localKeys.channelKeyPair.publicKey),
        channelSecretKey: encodeBase64(channel.localKeys.channelKeyPair.secretKey),
        mailboxId: channel.localKeys.mailboxId,
        mailboxPublicKey: encodeBase64(channel.localKeys.mailboxKeyPair.publicKey),
        mailboxSecretKey: encodeBase64(channel.localKeys.mailboxKeyPair.secretKey),
      },
      sharedKey: channel.sharedKey ? encodeBase64(channel.sharedKey) : null,
    };
    return encryptField(decodeUTF8(JSON.stringify(serializable)), key);
  }

  function decryptPairwiseChannelRow(row: Record<string, any>): StoredPairwiseChannel {
    const plaintext = decryptField(
      new Uint8Array(row.state_encrypted),
      new Uint8Array(row.state_nonce),
      key,
    );
    const parsed = JSON.parse(encodeUTF8(plaintext)) as Record<string, any>;
    const channel: StoredPairwiseChannel = {
      channelId: parsed.channelId,
      matchId: parsed.matchId,
      localPublicationId: parsed.localPublicationId,
      partnerPublicationId: parsed.partnerPublicationId,
      role: parsed.role,
      status: parsed.status,
      localKeys: {
        relationshipId: parsed.localKeys?.relationshipId,
        signingKeyPair: {
          publicKey: decodeBase64(parsed.localKeys?.signingPublicKey),
          secretKey: decodeBase64(parsed.localKeys?.signingSecretKey),
        },
        channelKeyPair: {
          publicKey: decodeBase64(parsed.localKeys?.channelPublicKey),
          secretKey: decodeBase64(parsed.localKeys?.channelSecretKey),
        },
        mailboxId: parsed.localKeys?.mailboxId,
        mailboxKeyPair: {
          publicKey: decodeBase64(parsed.localKeys?.mailboxPublicKey),
          secretKey: decodeBase64(parsed.localKeys?.mailboxSecretKey),
        },
      },
      partnerRelationshipId: parsed.partnerRelationshipId,
      partnerRelationshipKey: parsed.partnerRelationshipKey,
      partnerChannelKey: parsed.partnerChannelKey,
      partnerMailbox: parsed.partnerMailbox,
      sharedKey: parsed.sharedKey ? decodeBase64(parsed.sharedKey) : null,
      nextOutboundSequence: parsed.nextOutboundSequence,
      lastInboundSequence: parsed.lastInboundSequence,
      pendingOutbound: parsed.pendingOutbound,
      offer: parsed.offer,
      accept: parsed.accept,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
    validatePairwiseChannel(channel);
    if (row.match_id !== channel.matchId || row.channel_id !== channel.channelId) {
      throw new Error('Stored pairwise channel index does not match encrypted state');
    }
    return channel;
  }

  function validatePairwiseChannel(channel: StoredPairwiseChannel): void {
    if (!channel || typeof channel !== 'object'
      || typeof channel.matchId !== 'string'
      || typeof channel.localPublicationId !== 'string'
      || typeof channel.partnerPublicationId !== 'string'
      || (channel.role !== 'initiator' && channel.role !== 'responder')
      || !['offer-sent', 'active', 'closing', 'closed'].includes(channel.status)
      || !verifyConsentOfferV2(channel.offer)
      || (channel.accept !== null && !verifyConsentAcceptV2(channel.accept))
      || channel.offer.matchId !== channel.matchId
      || channel.localKeys.relationshipId.length === 0
      || channel.localKeys.signingKeyPair.publicKey.length !== 32
      || channel.localKeys.signingKeyPair.secretKey.length !== 64
      || channel.localKeys.channelKeyPair.publicKey.length !== 32
      || channel.localKeys.channelKeyPair.secretKey.length !== 32
      || typeof channel.localKeys.mailboxId !== 'string'
      || channel.localKeys.mailboxKeyPair.publicKey.length !== 32
      || channel.localKeys.mailboxKeyPair.secretKey.length !== 32
      || !Number.isSafeInteger(channel.nextOutboundSequence)
      || channel.nextOutboundSequence < 0
      || !Number.isSafeInteger(channel.lastInboundSequence)
      || channel.lastInboundSequence < -1
      || (channel.pendingOutbound !== null && !verifyChannelOperationV2(channel.pendingOutbound))
      || typeof channel.createdAt !== 'string'
      || typeof channel.updatedAt !== 'string') {
      throw new Error('Invalid pairwise channel state');
    }
    if ((channel.status === 'active' || channel.status === 'closing' || channel.status === 'closed') && (!channel.channelId
      || !channel.partnerRelationshipId
      || !channel.partnerRelationshipKey
      || !channel.partnerChannelKey
      || !channel.partnerMailbox
      || !channel.sharedKey
      || channel.sharedKey.length !== 32)) {
      throw new Error('Active pairwise channel is missing established key material');
    }
    if (channel.pendingOutbound && (channel.pendingOutbound.channelId !== channel.channelId
      || channel.pendingOutbound.senderRelationshipId !== channel.localKeys.relationshipId
      || channel.pendingOutbound.recipientRelationshipId !== channel.partnerRelationshipId
      || channel.pendingOutbound.sequence !== channel.nextOutboundSequence - 1)) {
      throw new Error('Pending channel operation does not match its channel state');
    }
  }

  function decryptPairwiseMessageRow(row: Record<string, any>): StoredPairwiseMessage {
    let content: ChannelContentV2 | null = null;
    if (row.content_encrypted !== null && row.content_nonce !== null) {
      const plaintext = decryptField(
        new Uint8Array(row.content_encrypted),
        new Uint8Array(row.content_nonce),
        key,
      );
      content = JSON.parse(encodeUTF8(plaintext)) as ChannelContentV2;
    }
    return {
      messageId: row.message_id,
      channelId: row.channel_id,
      direction: row.direction,
      sequence: row.sequence,
      kind: row.kind,
      content,
      createdAt: row.created_at,
    };
  }

  function writePairwiseChannel(channel: StoredPairwiseChannel): void {
    const state = encryptPairwiseChannel(channel);
    db.run(
      `INSERT INTO pairwise_channels (
         match_id, channel_id, state_encrypted, state_nonce, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         state_encrypted = excluded.state_encrypted,
         state_nonce = excluded.state_nonce,
         updated_at = excluded.updated_at`,
      [channel.matchId, channel.channelId, state.encrypted, state.nonce,
       channel.createdAt, channel.updatedAt],
    );
  }

  function writePairwiseMessage(message: StoredPairwiseMessage): boolean {
    if (!message.messageId || !message.channelId
      || (message.direction !== 'sent' && message.direction !== 'received')
      || !Number.isSafeInteger(message.sequence) || message.sequence < 0
      || (message.kind !== 'disclosure' && message.kind !== 'close')
      || (message.kind === 'disclosure' && !message.content)
      || (message.kind === 'close' && message.content !== null)) {
      throw new Error('Invalid pairwise message');
    }
    const encrypted = message.content
      ? encryptField(decodeUTF8(JSON.stringify(message.content)), key)
      : null;
    db.run(
      `INSERT OR IGNORE INTO pairwise_messages (
         message_id, channel_id, direction, sequence, kind,
         content_encrypted, content_nonce, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [message.messageId, message.channelId, message.direction, message.sequence, message.kind,
       encrypted?.encrypted ?? null, encrypted?.nonce ?? null, message.createdAt],
    );
    return db.getRowsModified() > 0;
  }

  function writeMailboxReceipt(envelopeId: string, mailboxId: string, payloadType: string): void {
    db.run(
      'INSERT OR IGNORE INTO mailbox_receipts (envelope_id, mailbox_id, payload_type) VALUES (?, ?, ?)',
      [envelopeId, mailboxId, payloadType],
    );
  }

  return {
    insertItem(input: CreateItemInput): void {
      const textEnc = encryptField(decodeUTF8(input.rawText), key);
      const embEnc = encryptField(float32ToBytes(input.embedding), key);
      const perturbedBytes = input.perturbed ? float32ToBytes(input.perturbed) : null;

      db.run(
        `INSERT INTO items (id, type, raw_text_encrypted, raw_text_nonce, embedding_encrypted, embedding_nonce, perturbed, privacy_level, epsilon, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.type, textEnc.encrypted, textEnc.nonce, embEnc.encrypted, embEnc.nonce,
         perturbedBytes, input.privacyLevel, input.epsilon ?? null, 'local'],
      );
      persist();
    },

    getItem(id: string): StoredItem | null {
      const row = queryOne(db, 'SELECT * FROM items WHERE id = ?', [id]);
      if (!row) return null;
      return decryptRow(row);
    },

    listItems(filter?: { type?: ItemType; status?: string }): StoredItem[] {
      let sql = 'SELECT * FROM items';
      const conditions: string[] = [];
      const params: any[] = [];

      if (filter?.type) { conditions.push('type = ?'); params.push(filter.type); }
      if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
      if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at DESC';

      return queryAll(db, sql, params).map(decryptRow);
    },

    updateItemStatus(id: string, status: string): void {
      db.run("UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id]);
      persist();
    },

    setPerturbed(id: string, perturbed: Float32Array, epsilon: number): void {
      db.run("UPDATE items SET perturbed = ?, epsilon = ?, updated_at = datetime('now') WHERE id = ?",
        [float32ToBytes(perturbed), epsilon, id]);
      persist();
    },

    // --- Protocol v2 publication methods ---

    insertPublication(itemId: string, record: PublicationRecord, keys: PublicationKeyMaterial): void {
      if (!verifyPublicationRecord(record)) throw new Error('Cannot store an invalid publication record');
      if (record.publicationId !== keys.publicationId) throw new Error('Publication ID does not match key material');
      if (record.publicationKey !== encodeBase64(keys.signingKeyPair.publicKey)) {
        throw new Error('Publication signing key does not match record');
      }
      if (record.mailbox.id !== keys.mailboxId
        || record.mailbox.encryptionKey !== encodeBase64(keys.mailboxKeyPair.publicKey)) {
        throw new Error('Publication mailbox key does not match record');
      }
      if (keys.signingKeyPair.secretKey.length !== 64 || keys.mailboxKeyPair.secretKey.length !== 32) {
        throw new Error('Invalid publication secret key material');
      }

      const signing = encryptField(keys.signingKeyPair.secretKey, key);
      const mailbox = encryptField(keys.mailboxKeyPair.secretKey, key);
      db.run('BEGIN');
      try {
        db.run(
          `INSERT INTO publication_secrets (
             item_id, publication_id, record_json,
             signing_secret_encrypted, signing_secret_nonce,
             mailbox_secret_encrypted, mailbox_secret_nonce
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [itemId, record.publicationId, JSON.stringify(record),
           signing.encrypted, signing.nonce, mailbox.encrypted, mailbox.nonce],
        );
        // A stored v2 record is pending until its relay acknowledgement. This
        // also clears a misleading v0.1 "published" status during upgrade.
        db.run("UPDATE items SET status = 'local', updated_at = datetime('now') WHERE id = ?", [itemId]);
        db.run('COMMIT');
        persist();
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    },

    getPublication(publicationId: string): StoredPublication | null {
      const row = queryOne(db, 'SELECT * FROM publication_secrets WHERE publication_id = ?', [publicationId]);
      return row ? decryptPublicationRow(row) : null;
    },

    getPublicationForItem(itemId: string): StoredPublication | null {
      const row = queryOne(db, 'SELECT * FROM publication_secrets WHERE item_id = ?', [itemId]);
      return row ? decryptPublicationRow(row) : null;
    },

    setPublicationTombstone(itemId: string, tombstone: PublicationTombstone): void {
      if (!verifyPublicationTombstone(tombstone)) throw new Error('Cannot store an invalid publication tombstone');
      const row = queryOne(db, 'SELECT record_json FROM publication_secrets WHERE item_id = ?', [itemId]);
      if (!row) throw new Error(`No publication exists for item ${itemId}`);
      const record: unknown = JSON.parse(row.record_json as string);
      if (!verifyPublicationRecord(record)
        || tombstone.publicationId !== record.publicationId
        || tombstone.publicationKey !== record.publicationKey
        || tombstone.sequence <= record.sequence) {
        throw new Error('Publication tombstone does not supersede the stored record');
      }
      db.run(
        "UPDATE publication_secrets SET tombstone_json = ?, updated_at = datetime('now') WHERE item_id = ?",
        [JSON.stringify(tombstone), itemId],
      );
      persist();
    },

    listPublications(): StoredPublication[] {
      return queryAll(db, 'SELECT * FROM publication_secrets ORDER BY created_at DESC')
        .map(decryptPublicationRow);
    },

    insertMailboxMatch(itemId: string, notice: Message<MatchNoticePayload>): boolean {
      if (!verifyMatchNoticeMessage(notice)) throw new Error('Cannot store an invalid mailbox match notice');
      const publication = queryOne(
        db,
        'SELECT publication_id FROM publication_secrets WHERE item_id = ?',
        [itemId],
      );
      if (!publication || publication.publication_id !== notice.payload.recipientPublicationId) {
        throw new Error('Mailbox match notice recipient does not match local item');
      }
      const encrypted = encryptField(decodeUTF8(JSON.stringify(notice)), key);
      db.run(
        `INSERT OR IGNORE INTO mailbox_matches (
           match_id, item_id, publication_id, notice_encrypted, notice_nonce
         ) VALUES (?, ?, ?, ?, ?)`,
        [notice.payload.matchId, itemId, notice.payload.recipientPublicationId,
         encrypted.encrypted, encrypted.nonce],
      );
      const inserted = db.getRowsModified() > 0;
      persist();
      return inserted;
    },

    listMailboxMatches(): StoredMailboxMatch[] {
      return queryAll(db, 'SELECT * FROM mailbox_matches ORDER BY created_at DESC')
        .map(decryptMailboxMatchRow);
    },

    upsertPairwiseChannel(channel: StoredPairwiseChannel): void {
      writePairwiseChannel(channel);
      persist();
    },

    getPairwiseChannelByMatchId(matchId: string): StoredPairwiseChannel | null {
      const row = queryOne(db, 'SELECT * FROM pairwise_channels WHERE match_id = ?', [matchId]);
      return row ? decryptPairwiseChannelRow(row) : null;
    },

    listPairwiseChannels(): StoredPairwiseChannel[] {
      return queryAll(db, 'SELECT * FROM pairwise_channels ORDER BY created_at DESC')
        .map(decryptPairwiseChannelRow);
    },

    insertPairwiseMessage(message: StoredPairwiseMessage): boolean {
      const inserted = writePairwiseMessage(message);
      persist();
      return inserted;
    },

    listPairwiseMessages(channelId: string): StoredPairwiseMessage[] {
      return queryAll(
        db,
        'SELECT * FROM pairwise_messages WHERE channel_id = ? ORDER BY created_at ASC, sequence ASC',
        [channelId],
      ).map(decryptPairwiseMessageRow);
    },

    commitPairwiseOutbound(channel, message): void {
      db.run('BEGIN');
      try {
        writePairwiseMessage(message);
        writePairwiseChannel(channel);
        db.run('COMMIT');
        persist();
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    },

    commitPairwiseInbound(channel, message, envelopeId, mailboxId): void {
      db.run('BEGIN');
      try {
        writePairwiseMessage(message);
        writePairwiseChannel(channel);
        writeMailboxReceipt(envelopeId, mailboxId, 'channel-operation');
        db.run('COMMIT');
        persist();
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    },

    hasMailboxReceipt(envelopeId: string): boolean {
      return queryOne(db, 'SELECT envelope_id FROM mailbox_receipts WHERE envelope_id = ?', [envelopeId]) !== null;
    },

    recordMailboxReceipt(envelopeId: string, mailboxId: string, payloadType: string): void {
      writeMailboxReceipt(envelopeId, mailboxId, payloadType);
      persist();
    },

    // --- Match methods ---

    insertMatch(input: CreateMatchInput): void {
      db.run(
        'INSERT INTO matches (id, item_id, partner_did, similarity, relay_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        [input.id, input.itemId, input.partnerDID, input.similarity, input.relayId ?? null, 'pending'],
      );
      persist();
    },

    getMatch(id: string): StoredMatch | null {
      const row = queryOne(db, 'SELECT * FROM matches WHERE id = ?', [id]);
      if (!row) return null;
      return {
        id: row.id, itemId: row.item_id, partnerDID: row.partner_did,
        similarity: row.similarity, relayId: row.relay_id, status: row.status, createdAt: row.created_at,
      };
    },

    listMatches(filter?: { status?: string }): StoredMatch[] {
      let sql = 'SELECT * FROM matches';
      const params: any[] = [];
      if (filter?.status) { sql += ' WHERE status = ?'; params.push(filter.status); }
      sql += ' ORDER BY created_at DESC';
      return queryAll(db, sql, params).map(row => ({
        id: row.id, itemId: row.item_id, partnerDID: row.partner_did,
        similarity: row.similarity, relayId: row.relay_id, status: row.status, createdAt: row.created_at,
      }));
    },

    updateMatchStatus(id: string, status: StoredMatch['status']): void {
      db.run('UPDATE matches SET status = ? WHERE id = ?', [status, id]);
      persist();
    },

    // --- Channel methods ---

    insertChannel(input: CreateChannelInput): void {
      let keyEnc: Uint8Array | null = null;
      let keyNonce: Uint8Array | null = null;
      if (input.sharedKey) {
        const enc = encryptField(input.sharedKey, key);
        keyEnc = enc.encrypted;
        keyNonce = enc.nonce;
      }
      db.run(
        'INSERT INTO channels (id, match_id, partner_did, shared_key_encrypted, shared_key_nonce, status) VALUES (?, ?, ?, ?, ?, ?)',
        [input.id, input.matchId, input.partnerDID, keyEnc, keyNonce, 'pending'],
      );
      persist();
    },

    getChannel(id: string): StoredChannel | null {
      const row = queryOne(db, 'SELECT * FROM channels WHERE id = ?', [id]);
      if (!row) return null;
      return decryptChannelRow(row);
    },

    getChannelByMatchId(matchId: string): StoredChannel | null {
      const row = queryOne(db, 'SELECT * FROM channels WHERE match_id = ?', [matchId]);
      if (!row) return null;
      return decryptChannelRow(row);
    },

    updateChannelStatus(id: string, status: StoredChannel['status']): void {
      db.run('UPDATE channels SET status = ? WHERE id = ?', [status, id]);
      persist();
    },

    updateChannelSharedKey(id: string, sharedKey: Uint8Array): void {
      const enc = encryptField(sharedKey, key);
      db.run('UPDATE channels SET shared_key_encrypted = ?, shared_key_nonce = ? WHERE id = ?',
        [enc.encrypted, enc.nonce, id]);
      persist();
    },

    close(): void {
      persist();
      db.close();
    },
  };
}
