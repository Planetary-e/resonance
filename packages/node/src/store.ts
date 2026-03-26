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
  return sqlPromise;
}

// --- Migration ---

function migrate(db: SqlJsDatabase): void {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'");
  if (result.length === 0 || result[0].values.length === 0) {
    db.run(SCHEMA_V1);
    db.run('INSERT INTO schema_version (version) VALUES (?)', [1]);
    return;
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
