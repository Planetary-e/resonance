/**
 * Encrypted local data store backed by SQLite.
 *
 * Sensitive fields (raw_text, embedding) are encrypted with secretbox
 * using a key derived from the user's identity. Perturbed embeddings
 * are stored unencrypted since they're public data sent to relays.
 */

import Database from 'better-sqlite3';
import {
  secretboxEncrypt,
  secretboxDecrypt,
  decodeUTF8,
  encodeUTF8,
  type ItemType,
  type PrivacyLevel,
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

export interface LocalStore {
  insertItem(input: CreateItemInput): void;
  getItem(id: string): StoredItem | null;
  listItems(filter?: { type?: ItemType; status?: string }): StoredItem[];
  updateItemStatus(id: string, status: string): void;
  setPerturbed(id: string, perturbed: Float32Array, epsilon: number): void;

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

// --- Internal helpers ---

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy to an aligned ArrayBuffer to avoid offset issues
  const ab = new ArrayBuffer(buf.byteLength);
  const view = new Uint8Array(ab);
  view.set(buf);
  return new Float32Array(ab);
}

function encryptField(data: Uint8Array, key: Uint8Array): { encrypted: Buffer; nonce: Buffer } {
  const result = secretboxEncrypt(data, key);
  return {
    encrypted: Buffer.from(result.ciphertext),
    nonce: Buffer.from(result.nonce),
  };
}

function decryptField(encrypted: Buffer, nonce: Buffer, key: Uint8Array): Uint8Array {
  const result = secretboxDecrypt(
    new Uint8Array(encrypted),
    new Uint8Array(nonce),
    key,
  );
  if (!result) throw new Error('Decryption failed — wrong key or corrupted data');
  return result;
}

// --- Migration ---

function migrate(db: Database.Database): void {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
  ).get();

  if (!tableExists) {
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
    return;
  }

  // Future: incremental migrations based on current version
}

// --- Store implementation ---

export function openStore(dbPath: string, encryptionKey: Uint8Array): LocalStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const key = encryptionKey;

  // Prepared statements
  const insertStmt = db.prepare(`
    INSERT INTO items (id, type, raw_text_encrypted, raw_text_nonce, embedding_encrypted, embedding_nonce, perturbed, privacy_level, epsilon, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getStmt = db.prepare('SELECT * FROM items WHERE id = ?');

  const updateStatusStmt = db.prepare(`
    UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?
  `);

  const setPerturbedStmt = db.prepare(`
    UPDATE items SET perturbed = ?, epsilon = ?, updated_at = datetime('now') WHERE id = ?
  `);

  function decryptRow(row: Record<string, unknown>): StoredItem {
    const rawTextBytes = decryptField(
      row.raw_text_encrypted as Buffer,
      row.raw_text_nonce as Buffer,
      key,
    );
    const embeddingBytes = decryptField(
      row.embedding_encrypted as Buffer,
      row.embedding_nonce as Buffer,
      key,
    );

    return {
      id: row.id as string,
      type: row.type as ItemType,
      rawText: encodeUTF8(rawTextBytes),
      embedding: bufferToFloat32(Buffer.from(embeddingBytes)),
      perturbed: row.perturbed ? bufferToFloat32(row.perturbed as Buffer) : null,
      privacyLevel: row.privacy_level as PrivacyLevel,
      epsilon: row.epsilon as number | null,
      status: row.status as StoredItem['status'],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  return {
    insertItem(input: CreateItemInput): void {
      const textEnc = encryptField(decodeUTF8(input.rawText), key);
      const embEnc = encryptField(float32ToBuffer(input.embedding), key);
      const perturbedBuf = input.perturbed ? float32ToBuffer(input.perturbed) : null;

      insertStmt.run(
        input.id,
        input.type,
        textEnc.encrypted,
        textEnc.nonce,
        embEnc.encrypted,
        embEnc.nonce,
        perturbedBuf,
        input.privacyLevel,
        input.epsilon ?? null,
        'local',
      );
    },

    getItem(id: string): StoredItem | null {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return decryptRow(row);
    },

    listItems(filter?: { type?: ItemType; status?: string }): StoredItem[] {
      let sql = 'SELECT * FROM items';
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter?.type) {
        conditions.push('type = ?');
        params.push(filter.type);
      }
      if (filter?.status) {
        conditions.push('status = ?');
        params.push(filter.status);
      }
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY created_at DESC';

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.map(decryptRow);
    },

    updateItemStatus(id: string, status: string): void {
      updateStatusStmt.run(status, id);
    },

    setPerturbed(id: string, perturbed: Float32Array, epsilon: number): void {
      setPerturbedStmt.run(float32ToBuffer(perturbed), epsilon, id);
    },

    // --- Match methods ---

    insertMatch(input: CreateMatchInput): void {
      db.prepare(
        'INSERT INTO matches (id, item_id, partner_did, similarity, relay_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(input.id, input.itemId, input.partnerDID, input.similarity, input.relayId ?? null, 'pending');
    },

    getMatch(id: string): StoredMatch | null {
      const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        itemId: row.item_id as string,
        partnerDID: row.partner_did as string,
        similarity: row.similarity as number,
        relayId: row.relay_id as string | null,
        status: row.status as StoredMatch['status'],
        createdAt: row.created_at as string,
      };
    },

    listMatches(filter?: { status?: string }): StoredMatch[] {
      let sql = 'SELECT * FROM matches';
      const params: unknown[] = [];
      if (filter?.status) {
        sql += ' WHERE status = ?';
        params.push(filter.status);
      }
      sql += ' ORDER BY created_at DESC';
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.map(row => ({
        id: row.id as string,
        itemId: row.item_id as string,
        partnerDID: row.partner_did as string,
        similarity: row.similarity as number,
        relayId: row.relay_id as string | null,
        status: row.status as StoredMatch['status'],
        createdAt: row.created_at as string,
      }));
    },

    updateMatchStatus(id: string, status: StoredMatch['status']): void {
      db.prepare('UPDATE matches SET status = ? WHERE id = ?').run(status, id);
    },

    // --- Channel methods ---

    insertChannel(input: CreateChannelInput): void {
      let keyEnc: Buffer | null = null;
      let keyNonce: Buffer | null = null;
      if (input.sharedKey) {
        const enc = encryptField(input.sharedKey, key);
        keyEnc = enc.encrypted;
        keyNonce = enc.nonce;
      }
      db.prepare(
        'INSERT INTO channels (id, match_id, partner_did, shared_key_encrypted, shared_key_nonce, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(input.id, input.matchId, input.partnerDID, keyEnc, keyNonce, 'pending');
    },

    getChannel(id: string): StoredChannel | null {
      const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return decryptChannelRow(row);
    },

    getChannelByMatchId(matchId: string): StoredChannel | null {
      const row = db.prepare('SELECT * FROM channels WHERE match_id = ?').get(matchId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return decryptChannelRow(row);
    },

    updateChannelStatus(id: string, status: StoredChannel['status']): void {
      db.prepare('UPDATE channels SET status = ? WHERE id = ?').run(status, id);
    },

    updateChannelSharedKey(id: string, sharedKey: Uint8Array): void {
      const enc = encryptField(sharedKey, key);
      db.prepare('UPDATE channels SET shared_key_encrypted = ?, shared_key_nonce = ? WHERE id = ?').run(enc.encrypted, enc.nonce, id);
    },

    close(): void {
      db.close();
    },
  };

  function decryptChannelRow(row: Record<string, unknown>): StoredChannel {
    let sharedKey: Uint8Array | null = null;
    if (row.shared_key_encrypted && row.shared_key_nonce) {
      sharedKey = decryptField(row.shared_key_encrypted as Buffer, row.shared_key_nonce as Buffer, key);
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
}
