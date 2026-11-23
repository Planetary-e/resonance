import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { OfflineRequestStore } from '@resonance/node';

const ROTATION_ENTRY_THRESHOLD = 48;

export class MailboxState {
  store?: OfflineRequestStore;
  generation = 0;

  constructor(readonly root: string, readonly coordinator: number) {}

  rotate(): OfflineRequestStore {
    this.store?.close();
    this.generation++;
    this.store = OfflineRequestStore.open({
      path: join(this.root, `mailbox-${this.coordinator}-${this.generation}.json`),
      encryptionKey: randomBytes(32),
    });
    return this.store;
  }

  current(): OfflineRequestStore {
    if (this.store && this.store.listOutbox().length >= ROTATION_ENTRY_THRESHOLD) this.rotate();
    return this.store ?? this.rotate();
  }

  close(): void {
    this.store?.close();
  }
}
