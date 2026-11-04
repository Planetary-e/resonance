import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureModelFileCache, createModelFileCache } from '../model-file-cache.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const url = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1/resolve/main/onnx/model.onnx';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'resonance-model-cache-')); directories.push(root);
  const cache = createModelFileCache(() => root, { weights: 64, metadata: 32 });
  const path = join(root, 'nomic-ai/nomic-embed-text-v1/onnx/model.onnx');
  return { root, path, cache };
}

it('returns the existing ONNX path without reading, copying or opening a body stream', async () => {
  const { cache, path } = await fixture(); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'model');
  expect(await cache.match(url)).toBe(path);
  await writeFile(path, 'replacement');
  expect(await cache.match(url)).toBe(path);
});

it('reads bounded metadata and keeps immutable revisions in separate existing-layout paths', async () => {
  const { cache, root } = await fixture();
  const metadataUrl = url.replace('onnx/model.onnx', 'config.json');
  await cache.put(metadataUrl, new Response('{"model":"test"}'));
  expect(await (await cache.match(metadataUrl) as Response).json()).toEqual({ model: 'test' });
  const revisionUrl = url.replace('/main/', '/revision-2/'); await cache.put(revisionUrl, new Response('other'));
  expect(await cache.match(url)).toBeUndefined();
  expect(await cache.match(revisionUrl)).toBe(join(root, 'nomic-ai/nomic-embed-text-v1/revision-2/onnx/model.onnx'));
});

it('publishes only complete downloads, preserving an old model while its replacement streams', async () => {
  const { cache, path } = await fixture(); await cache.put(url, new Response('old'));
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  let firstWritten!: () => void; const written = new Promise<void>(resolve => { firstWritten = resolve; });
  const progress: number[] = [];
  const pending = cache.put(url, new Response(body, { headers: { 'content-length': '6' } }), value => { progress.push(value.loaded); firstWritten(); });
  controller.enqueue(new TextEncoder().encode('new')); await written;
  expect(await readFile(path, 'utf8')).toBe('old');
  controller.enqueue(new TextEncoder().encode('new')); controller.close(); await pending;
  expect(await readFile(path, 'utf8')).toBe('newnew'); expect(progress).toEqual([3, 6]);
  expect(await readdir(join(path, '..'))).toEqual(['model.onnx']);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it.each(['declared-too-large', 'stream-too-large', 'truncated', 'read-error', 'empty'] as const)(
  'retains the prior complete file after %s and removes partial files', async failure => {
    const { cache, path } = await fixture(); await cache.put(url, new Response('old'));
    let response: Response;
    if (failure === 'declared-too-large') response = new Response('short', { headers: { 'content-length': '65' } });
    else if (failure === 'stream-too-large') response = new Response('x'.repeat(65));
    else if (failure === 'truncated') response = new Response('short', { headers: { 'content-length': '6' } });
    else if (failure === 'read-error') response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('offline')); } }));
    else response = new Response('');
    await expect(cache.put(url, response)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('old');
    expect(await readdir(join(path, '..'))).toEqual(['model.onnx']);
  });

it('enforces metadata limits independently and rejects oversized preexisting cache entries', async () => {
  const { cache, path } = await fixture();
  await expect(cache.put(url.replace('onnx/model.onnx', 'config.json'), new Response('x'.repeat(33)))).rejects.toThrow('capacity');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'x'.repeat(65));
  await expect(cache.match(url)).rejects.toThrow('oversized');
});

it('cancels the response when the cache directory cannot be created', async () => {
  const { root } = await fixture(), blocked = join(root, 'file'); await writeFile(blocked, 'keep');
  const cache = createModelFileCache(() => blocked); let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await expect(cache.put(url, response)).rejects.toThrow();
  expect(cancelled).toBe(true); expect(await readFile(blocked, 'utf8')).toBe('keep');
});

it('keeps overlapping downloads separate until each complete atomic replacement', async () => {
  const { cache, path } = await fixture();
  let controller!: ReadableStreamDefaultController<Uint8Array>, notify!: () => void;
  const written = new Promise<void>(resolve => { notify = resolve; });
  const slow = cache.put(url, new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } })), notify);
  controller.enqueue(new TextEncoder().encode('first-')); await written;
  await cache.put(url, new Response('second-complete')); expect(await readFile(path, 'utf8')).toBe('second-complete');
  controller.enqueue(new TextEncoder().encode('complete')); controller.close(); await slow;
  expect(await readFile(path, 'utf8')).toBe('first-complete'); expect(await readdir(join(path, '..'))).toEqual(['model.onnx']);
});

it.each(['https://evil.example/nomic-ai/nomic-embed-text-v1/resolve/main/onnx/model.onnx',
  url.replace('/onnx/', '/%2e%2e/'), url.replace('/onnx/', '/%2fetc/'), url.replace('/onnx/', '/%5cetc/'),
  url.replace('/onnx/', '/C%3a/'), url + '?redirect=yes', url + '#fragment', url.replace('/onnx/', '/%00/'),
  '/models/nomic-ai/nomic-embed-text-v1/onnx/model.onnx'])('does not cache an unsafe or unrelated request: %s', async request => {
  const { cache, root } = await fixture();
  expect(await cache.match(request)).toBeUndefined();
  await expect(cache.put(request, new Response('data'))).rejects.toThrow('Invalid');
  expect(await readdir(root)).toEqual([]);
});

describe('installation', () => {
  const defaults = () => ({ cacheDir: '/cache', useFSCache: true, useCustomCache: false, customCache: null as unknown,
    remoteHost: 'https://huggingface.co/', remotePathTemplate: '{model}/resolve/{revision}/' });
  it('installs once and preserves the selected cache', () => {
    const env = defaults(); configureModelFileCache(env); const selected = env.customCache;
    expect(env.useCustomCache).toBe(true); expect(selected).toBeTruthy(); configureModelFileCache(env); expect(env.customCache).toBe(selected);
  });
  it.each([{ useCustomCache: true }, { useFSCache: false }, { cacheDir: null }, { remoteHost: 'https://models.example/' },
    { remotePathTemplate: '{model}/{revision}/' }])('respects nonstandard configuration %j', configuration => {
    const env = { ...defaults(), ...configuration }; const before = { ...env }; configureModelFileCache(env); expect(env).toEqual(before);
  });
});
