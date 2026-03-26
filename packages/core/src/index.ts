export {
  type PrivacyLevel,
  type ItemType,
  type PerturbationResult,
  type MatchResult,
  type BenchmarkResult,
  type EvalReport,
  EPSILON_MAP,
  type PerturbMode,
  EMBEDDING_CONFIG,
  HNSW_DEFAULTS,
  PROTOCOL_DEFAULTS,
} from './types.js';

export {
  dotProduct,
  l2Norm,
  normalize,
  cosineSimilarity,
  cosineSimilaritySafe,
} from './vectors.js';

export {
  sampleLaplace,
  calibrateScale,
  perturbVector,
  perturbWithLevel,
  privacyLevelToEpsilon,
} from './perturbation.js';

export { EmbeddingEngine, rewriteForMatching, type EmbeddingPrefix } from './embedding.js';

export {
  generateProjectionMatrix,
  hashEmbedding,
  hammingDistance,
  hammingSimilarity,
  expectedHammingSimilarity,
} from './lsh.js';

export {
  type Identity,
  type KeyPair,
  type BoxResult,
  type SecretBoxResult,
  generateIdentity,
  publicKeyToDid,
  didToPublicKey,
  sign,
  verify,
  boxEncrypt,
  boxDecrypt,
  generateEphemeralKeyPair,
  deriveSharedSecret,
  secretboxEncrypt,
  secretboxDecrypt,
  exportIdentity,
  importIdentity,
  encodeBase64,
  decodeBase64,
  encodeUTF8,
  decodeUTF8,
} from './crypto.js';

export {
  type Message,
  type PublishPayload,
  type SearchPayload,
  type ConsentPayload,
  type WithdrawPayload,
  type MatchPayload,
  type SearchResultsPayload,
  type ConsentForwardPayload,
  type AckPayload,
  type ConfirmEmbeddingPayload,
  type ConfirmResultPayload,
  type DisclosurePayload,
  type AcceptPayload,
  type RejectPayload,
  type ClosePayload,
  type AuthPayload,
  type ChannelMessagePayload,
  type ChannelForwardPayload,
  MessageTypes,
  createMessage,
  verifyMessage,
  parseMessage,
  serializeMessage,
} from './protocol.js';
