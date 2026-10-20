/** Node model cache: native ONNX sessions receive a path, never an eager stream. */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const MODEL_CACHE_WEIGHT_BYTES = 2 * 1024 ** 3;
export const MODEL_CACHE_METADATA_BYTES = 16 * 1024 ** 2;
type Progress = (value: { progress: number; loaded: number; total: number }) => void;
interface CacheEnvironment {
  cacheDir: string | null; useFSCache: boolean; useCustomCache: boolean;
  customCache: unknown; remoteHost: string; remotePathTemplate: string;
}

/** Use the documented custom-cache hook for the standard Hugging Face layout.
 * Respect an explicitly configured custom cache or remote repository layout. */
export function configureModelFileCache(env: CacheEnvironment): void {
  if (!env.useFSCache || env.useCustomCache || !env.cacheDir || env.remoteHost !== 'https://huggingface.co/'
    || env.remotePathTemplate !== '{model}/resolve/{revision}/') return;
  env.customCache = createModelFileCache(() => env.cacheDir);
  env.useCustomCache = true;
}

export function createModelFileCache(directory: () => string | null, limits = {
  weights: MODEL_CACHE_WEIGHT_BYTES, metadata: MODEL_CACHE_METADATA_BYTES,
}) {
  if (![limits.weights, limits.metadata].every(limit => Number.isSafeInteger(limit) && limit > 0)) throw new Error('Invalid model cache limits');
  function location(request: string) {
    // Custom caches receive a remote URL (also an initial local-path probe).
    // Reject path aliases, credentials, encoded separators and traversal before
    // URL normalization can erase them. Existing FS-cache main paths stay valid.
    const prefix = 'https://huggingface.co/';
    if (!request.startsWith(prefix) || request.includes('?') || request.includes('#')) return undefined;
    const raw = request.slice(prefix.length).split('/');
    let parts: string[];
    try { parts = raw.map(part => decodeURIComponent(part)); } catch { return undefined; }
    if (parts.length < 5 || parts[2] !== 'resolve' || parts.some(part => !part || part === '.' || part === '..'
      || /[\\/:\x00-\x1f\x7f]/.test(part))) return undefined;
    const root = directory(); if (!root) return undefined;
    const relative = [parts[0], parts[1], ...(parts[3] === 'main' ? [] : [parts[3]]), ...parts.slice(4)];
    const path = join(resolve(root), ...relative), weights = /\.onnx(?:_data)?$/.test(parts.at(-1)!);
    return { path, weights, maximum: weights ? limits.weights : limits.metadata };
  }
  return {
    async match(request: string): Promise<string | Response | undefined> {
      const target = location(request); if (!target) return undefined;
      let stat;
      try { stat = await lstat(target.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      if (!stat.isFile() || stat.size <= 0 || stat.size > target.maximum) throw new Error('Invalid or oversized cached model file');
      if (target.weights) return target.path;
      // Metadata is small and read only on demand. Check the opened descriptor,
      // retain at most the validated size and detect growth before decoding.
      const file = await open(target.path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error('Cached model metadata changed');
        const bytes = Buffer.alloc(stat.size + 1); let used = 0;
        while (used < bytes.length) {
          const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
          if (!bytesRead) break; used += bytesRead;
        }
        const after = await file.stat();
        if (used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Cached model metadata changed');
        return new Response(bytes.subarray(0, used), { headers: { 'content-length': String(used) } });
      } finally { await file.close(); }
    },
    async put(request: string, response: Response, progress?: Progress): Promise<void> {
      const target = location(request);
      if (!target || response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => {}); throw new Error('Invalid model download');
      }
      const declared = response.headers.get('content-encoding') ? null : response.headers.get('content-length');
      const total = declared !== null && /^\d+$/.test(declared) ? Number(declared) : 0;
      if (!Number.isSafeInteger(total) || total > target.maximum) { await response.body.cancel(); throw new Error('Model download exceeds capacity'); }
      const temporary = `${target.path}.tmp.${process.pid}.${randomBytes(12).toString('hex')}`;
      const reader = response.body.getReader();
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let loaded = 0, committed = false;
      try {
        await mkdir(dirname(target.path), { recursive: true });
        file = await open(temporary, 'wx', 0o600);
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (value.byteLength > target.maximum - loaded) throw new Error('Model download exceeds capacity');
          let offset = 0;
          while (offset < value.byteLength) {
            const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
            if (!bytesWritten) throw new Error('Model cache write made no progress'); offset += bytesWritten;
          }
          loaded += value.byteLength;
          progress?.({ loaded, total, progress: total ? 100 * loaded / total : 0 });
        }
        if (!loaded || declared !== null && total !== loaded) throw new Error('Incomplete model download');
        await file.sync(); await file.close();
        await rename(temporary, target.path); committed = true;
      } finally {
        try { await reader.cancel(); } finally {
          reader.releaseLock(); await file?.close();
          if (file && !committed) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
    },
  };
}
