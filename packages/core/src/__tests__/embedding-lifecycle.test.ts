import { afterEach, expect, it, vi } from 'vitest';
import { EmbeddingEngine } from '../embedding.js';
import { pipeline } from '@huggingface/transformers';

vi.mock('@huggingface/transformers', () => ({ pipeline: vi.fn(), env: { useFSCache: false } }));
afterEach(() => vi.clearAllMocks());
function pending<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

it('shares concurrent initialization and releases a late model after disposal during loading', async () => {
  const loading = pending<any>(), dispose = vi.fn(async () => {}), engine = new EmbeddingEngine();
  vi.mocked(pipeline).mockReturnValue(loading.promise);
  const first = engine.initialize(), second = engine.initialize();
  const rejected = Promise.all([expect(first).rejects.toThrow('disposed'), expect(second).rejects.toThrow('disposed')]);
  const closing = engine.dispose(); expect(engine.isInitialized()).toBe(false);
  loading.resolve(Object.assign(vi.fn(), { dispose })); await rejected; await closing;
  expect(pipeline).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
  expect(engine.dispose()).toBe(closing); await expect(engine.initialize()).rejects.toThrow('disposed');
});

it.each([false, true])('waits for active inference before native release (inference rejects: %s)', async fails => {
  const inference = pending<any>(), dispose = vi.fn(async () => {}), pipe = Object.assign(vi.fn(() => inference.promise), {
    dispose, tokenizer: vi.fn(() => ({ input_ids: { dims: [1, 16] } })),
  });
  vi.mocked(pipeline).mockResolvedValue(pipe as any); const engine = new EmbeddingEngine(); await engine.initialize();
  const running = engine.embed('private text'), outcome = fails ? expect(running).rejects.toThrow('inference failed') : expect(running).resolves.toEqual(new Float32Array([1]));
  const closing = engine.dispose(); await Promise.resolve(); expect(dispose).not.toHaveBeenCalled();
  await expect(engine.embed('must not start')).rejects.toThrow('not initialized'); expect(pipe).toHaveBeenCalledTimes(1);
  if (fails) inference.reject(new Error('inference failed')); else inference.resolve({ data: new Float32Array([1]) });
  await outcome; await closing; expect(dispose).toHaveBeenCalledTimes(1);
});

it('retains a native cleanup failure and never reopens the closed model', async () => {
  const dispose = vi.fn(async () => { throw new Error('native cleanup failed'); });
  vi.mocked(pipeline).mockResolvedValue(Object.assign(vi.fn(), { dispose }) as any);
  const engine = new EmbeddingEngine(); await engine.initialize();
  const closing = engine.dispose(); await expect(closing).rejects.toThrow('native cleanup failed');
  expect(engine.dispose()).toBe(closing); await expect(engine.initialize()).rejects.toThrow('disposed');
  expect(dispose).toHaveBeenCalledTimes(1);
});
