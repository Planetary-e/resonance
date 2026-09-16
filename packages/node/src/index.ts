export {
  openStore,
  openStoreAsync,
  type LocalStore,
  type StoredItem,
  type CreateItemInput,
  type StoredPublication,
  type StoredMailboxMatch,
  type StoredPairwiseChannel,
  type StoredPairwiseMessage,
  type StoredMatch,
  type CreateMatchInput,
  type StoredChannel,
  type CreateChannelInput,
} from './store.js';
export { createIdentityManager, type IdentityManager } from './identity.js';
export { getDataDir, getDbPath, getIdentityPath, ensureDataDir, deriveStoreKey } from './config.js';
export {
  createRelayClient,
  type RelayClient,
  type RelayClientConfig,
  type AdmissionCapabilityProviderV2,
  type AdmissionCapabilityRequestContextV2,
  type RelayClientEvents,
  type MailboxFetchResult,
  type RelationshipMailboxFetchResult,
} from './relay-client.js';
export { createChannelManager, type ChannelManager, type ChannelManagerConfig, type ChannelInfo, type ChannelState } from './channel.js';
export {
  createPairwiseChannelManagerV2,
  type PairwiseChannelManagerV2,
  type PairwiseChannelSyncResult,
} from './pairwise-channel-v2.js';
export {
  upgradeLegacyItemsToV2,
  type UpgradeV2Options,
  type UpgradeV2Report,
} from './upgrade-v2.js';
