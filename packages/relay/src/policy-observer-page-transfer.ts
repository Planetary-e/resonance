/** Bounded content-addressed page transfer over the existing observer TLS channel. */
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { admissionPolicyObserversId, parseAdmissionPolicyHead, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { admissionPolicyArchivePageDigest, decodeAdmissionPolicyArchivePage, type AdmissionPolicyArchiveReader } from '@resonance/core/admission-policy-archive';
import { ADMISSION_POLICY_CHUNK_BYTES, ADMISSION_POLICY_CHUNK_REPLY_MAX_BYTES } from '@resonance/core/admission-policy-transfer';
export const POLICY_ARCHIVE_PAGE_TYPE = 'admission_policy_archive_page';
export const POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES = ADMISSION_POLICY_CHUNK_REPLY_MAX_BYTES;
export function parsePolicyArchivePageRequest(value: unknown, context: AdmissionPolicyObservers) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1024 || !exactWitnessFields(value, ['version','type','contextId','head','digest','index'])
    || value.version !== 1 || value.type !== POLICY_ARCHIVE_PAGE_TYPE || value.contextId !== admissionPolicyObserversId(context)
    || typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.index)
    || (value.index as number) < 0 || (value.index as number) >= 8) throw new Error('Invalid policy archive page request');
  return { version: 1 as const, type: POLICY_ARCHIVE_PAGE_TYPE, contextId: value.contextId as string, head: parseAdmissionPolicyHead(value.head), digest: value.digest, index: value.index as number };
}
export async function policyArchivePageReply(value: unknown, context: AdmissionPolicyObservers, head: unknown, reader: AdmissionPolicyArchiveReader) {
  const request = parsePolicyArchivePageRequest(value, context);
  if (!sameAdmissionPolicyHead(request.head, parseAdmissionPolicyHead(head))) throw new Error('Archive transfer requires the exact retained selected head');
  const bytes = await reader(request.digest, new AbortController().signal);
  if (admissionPolicyArchivePageDigest(bytes) !== request.digest) throw new Error('Archive page source digest differs');
  const page = await decodeAdmissionPolicyArchivePage(bytes);
  if (page.contextId !== request.contextId || request.index >= Math.ceil(bytes.length / ADMISSION_POLICY_CHUNK_BYTES)) throw new Error('Archive page source context/index differs');
  return { ...request, type: 'admission_policy_archive_page_reply', bytes: bytes.length, count: Math.ceil(bytes.length / ADMISSION_POLICY_CHUNK_BYTES),
    data: Buffer.from(bytes.subarray(request.index * ADMISSION_POLICY_CHUNK_BYTES, (request.index + 1) * ADMISSION_POLICY_CHUNK_BYTES)).toString('base64url') };
}
/** Per page: <=8 bounded requests, <=512KiB retained bytes and one absolute deadline. */
export async function downloadPolicyObserverArchivePage(options: {
  context: AdmissionPolicyObservers; head: unknown; digest: string; timeoutMs: number; signal?: AbortSignal;
  exchange: (request: unknown, signal: AbortSignal) => Promise<unknown>;
}): Promise<Uint8Array> {
  const context = structuredClone(options.context), head = parseAdmissionPolicyHead(structuredClone(options.head)), digest = options.digest, exchange = options.exchange;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000) throw new Error('Invalid archive transfer timeout');
  const signal = options.signal, deadline = performance.now() + options.timeoutMs;
  const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, options.timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  const live = () => {
    if (controller.signal.aborted || signal?.aborted || performance.now() >= deadline) {
      controller.abort(); throw new Error('Archive page transfer cancelled or timed out');
    }
  };
  async function wait<T>(work: () => Promise<T>): Promise<T> {
    live();
    let reject!: (error: Error) => void;
    const cancelled = new Promise<never>((_, refuse) => { reject = refuse; });
    const refused = () => reject(new Error('Archive page transfer cancelled or timed out'));
    controller.signal.addEventListener('abort', refused, { once: true });
    try { const result = await Promise.race([work(), cancelled]); live(); return result; }
    finally { controller.signal.removeEventListener('abort', refused); }
  }
  const parts: Buffer[] = []; let count = 1, size = 0, total = 0;
  try {
    live();
    for (let index = 0; index < count; index++) {
      live();
      const request = parsePolicyArchivePageRequest({ version: 1, type: POLICY_ARCHIVE_PAGE_TYPE, contextId: admissionPolicyObserversId(context), head, digest, index }, context);
      const raw = await wait(() => exchange(request, controller.signal));
      if (Buffer.byteLength(JSON.stringify(raw) ?? '') > POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES
        || !exactWitnessFields(raw, ['version','type','contextId','head','digest','index','bytes','count','data'])
        || raw.version !== 1 || raw.type !== 'admission_policy_archive_page_reply' || raw.contextId !== request.contextId || raw.digest !== digest || raw.index !== index
        || !sameAdmissionPolicyHead(parseAdmissionPolicyHead(raw.head), head) || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 1 || (raw.bytes as number) > 512 * 1024
        || raw.count !== Math.ceil((raw.bytes as number) / ADMISSION_POLICY_CHUNK_BYTES) || typeof raw.data !== 'string') throw new Error('Invalid archive page chunk');
      if (index && (raw.bytes !== size || raw.count !== count)) throw new Error('Archive page chunks disagree');
      size = raw.bytes as number; count = raw.count as number;
      const bytes = Buffer.from(raw.data, 'base64url');
      if (bytes.toString('base64url') !== raw.data || bytes.length !== Math.min(ADMISSION_POLICY_CHUNK_BYTES, size - index * ADMISSION_POLICY_CHUNK_BYTES)) throw new Error('Invalid archive chunk encoding/length');
      total += bytes.length; parts.push(bytes);
    }
    const bytes = Buffer.concat(parts, total);
    if (total !== size || admissionPolicyArchivePageDigest(bytes) !== digest) throw new Error('Archive page transfer differs from selected digest/context');
    const page = await wait(() => decodeAdmissionPolicyArchivePage(bytes));
    if (page.contextId !== admissionPolicyObserversId(context)) throw new Error('Archive page transfer differs from selected digest/context');
    live(); return bytes;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}

export interface PolicyObserverRemoteArchive {
  /** Trusted local transport receives only independently pinned context members. */
  exchange: (member: AdmissionPolicyObservers['members'][number], request: unknown, signal: AbortSignal) => Promise<unknown>;
  maxRequests?: number; maxBytes?: number;
}
export function createPolicyObserverRemoteOperation(options: {
  deadline: number; signal?: AbortSignal; check?: () => void; archive: PolicyObserverRemoteArchive;
}) {
  const deadline = Math.min(options.deadline, performance.now() + 3000), signal = options.signal, check = options.check,
    transport = options.archive.exchange, maxRequests = options.archive.maxRequests ?? 16,
    maximumBytes = 16 * POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES,
    maxBytes = options.archive.maxBytes ?? maximumBytes;
  if (!Number.isFinite(deadline) || !Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > 16
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maximumBytes) throw new Error('Invalid remote archive operation envelope');
  const controller = new AbortController(), cancel = () => controller.abort();
  let requests = 0, bytes = 0, exhausted = false;
  const timer = setTimeout(cancel, Math.max(1, deadline - performance.now())); signal?.addEventListener('abort', cancel, { once: true });
  function live() {
    check?.();
    if (exhausted) throw new Error('Remote archive cumulative budget exhausted');
    if (signal?.aborted || controller.signal.aborted || performance.now() >= deadline) { cancel(); throw new Error('Remote archive operation cancelled or timed out'); }
  }
  async function wait<T>(work: () => Promise<T>): Promise<T> {
    live(); let refuse!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { refuse = reject; });
    const aborted = () => refuse(new Error('Remote archive operation cancelled or timed out'));
    controller.signal.addEventListener('abort', aborted, { once: true });
    try { const result = await Promise.race([work(), cancelled]); live(); return result; }
    finally { controller.signal.removeEventListener('abort', aborted); }
  }
  return { deadline, signal: controller.signal, live, wait,
    async page(contextValue: AdmissionPolicyObservers, head: unknown, digest: string, ownKey: string) {
      const context = structuredClone(contextValue), members = context.members.filter(member => member.publicKey !== ownKey);
      for (let peer = 0; peer < members.length; peer++) {
        const member = members[peer];
        live();
        try {
          return await downloadPolicyObserverArchivePage({ context, head, digest, timeoutMs: Math.max(1, Math.floor((deadline - performance.now()) / (members.length - peer))), signal: controller.signal,
            exchange: async (request, pageSignal) => {
              live();
              if (++requests > maxRequests || bytes + POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES > maxBytes) { exhausted = true; live(); }
              // A rejected transport may already have received bytes. Reserve its
              // entire bounded reply before dispatch and never infer a refund.
              bytes += POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES;
              return wait(() => transport(member, request, pageSignal));
            } });
        } catch { live(); }
      }
      throw new Error('No committed pinned observer supplies the required archive page');
    },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); cancel(); },
  };
}
