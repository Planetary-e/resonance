import type { IncomingMessage } from 'node:http';

export const MAX_LOCAL_JSON_BYTES = 1024 * 1024;
export class LocalJsonBodyError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

/** Bound bytes and retained buffers before decoding one complete UTF-8 object. */
export function readLocalJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // One bounded allocation avoids retaining arbitrarily many tiny chunks.
    const body = Buffer.allocUnsafe(MAX_LOCAL_JSON_BYTES);
    let size = 0, done = false;
    const fail = (error: LocalJsonBodyError) => { if (!done) { done = true; body.fill(0, 0, size); reject(error); } };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      if (chunk.length > MAX_LOCAL_JSON_BYTES - size) {
        fail(new LocalJsonBodyError('JSON body exceeds 1 MiB', 413)); req.destroy(); return;
      }
      chunk.copy(body, size); size += chunk.length;
    });
    req.once('end', () => {
      if (done) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, size)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        done = true; body.fill(0, 0, size); resolve(value as Record<string, unknown>);
      } catch { fail(new LocalJsonBodyError('Request body must be a valid UTF-8 JSON object')); }
    });
    req.once('aborted', () => fail(new LocalJsonBodyError('Request body was interrupted')));
    req.once('error', () => fail(new LocalJsonBodyError('Request body could not be read')));
  });
}
