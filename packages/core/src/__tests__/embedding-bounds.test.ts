import { afterEach, expect, it, vi } from 'vitest';
import { pipeline } from '@huggingface/transformers';
import { EmbeddingEngine, EmbeddingInputError, MAX_EMBEDDING_OPERATIONS, EMBEDDING_OPERATION_MS } from '../embedding.js';

vi.mock('@huggingface/transformers', () => ({ pipeline: vi.fn(), env: { useFSCache: false } }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const result = { data: new Float32Array([1]) };
async function fixture(callback: (text: string, options?: unknown) => Promise<typeof result> = async () => result) {
  const tokenizer = Object.assign(vi.fn(() => ({ input_ids: { dims: [1, 16] } })), { model_max_length: 8192 });
  const pipe = Object.assign(vi.fn(callback), { tokenizer, dispose: vi.fn(async () => {}) });
  vi.mocked(pipeline).mockResolvedValue(pipe as any);
  const engine = new EmbeddingEngine(); await engine.initialize(); return { engine, pipe };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

it('serializes native inference, preserves FIFO order and leaves no active sessions at disposal', async () => {
  const waits = [gate<typeof result>(), gate<typeof result>(), gate<typeof result>()]; let index = 0;
  const { engine, pipe } = await fixture(() => waits[index++].promise);
  const requests = ['first', 'second', 'third'].map(text => engine.embed(text));
  expect(pipe).toHaveBeenCalledTimes(1); expect(pipe.tokenizer).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) { waits[i].resolve(result); await requests[i]; await settle(); expect(pipe).toHaveBeenCalledTimes(Math.min(3, i + 2)); }
  expect(pipe.mock.calls.map(call => call[0])).toEqual(['search_document: first', 'search_document: second', 'search_document: third']);
  await engine.dispose(); expect(pipe.dispose).toHaveBeenCalledTimes(1);
});

it('bounds accepted work, cancels waiting jobs on disposal and drains the already-running native call', async () => {
  const waiting = gate<typeof result>(), { engine, pipe } = await fixture(() => waiting.promise);
  const active = engine.embed('active');
  const pending = Array.from({ length: MAX_EMBEDDING_OPERATIONS - 1 }, (_, i) => engine.embed(`queued ${i}`));
  const cancelled = pending.map(promise => expect(promise).rejects.toThrow('disposed'));
  await expect(engine.embed('overflow')).rejects.toThrow('busy'); expect(pipe.tokenizer).toHaveBeenCalledTimes(1);
  const closed = engine.dispose(); await Promise.all(cancelled); expect(pipe.dispose).not.toHaveBeenCalled();
  waiting.resolve(result); await active; await closed;
  expect(pipe).toHaveBeenCalledTimes(1); expect(pipe.dispose).toHaveBeenCalledTimes(1);
});

it('aborts queued callers without native work and holds an aborted active slot until native settlement', async () => {
  const waiting = gate<typeof result>(), { engine, pipe } = await fixture(() => waiting.promise);
  const activeController = new AbortController(), queuedController = new AbortController();
  const active = engine.embed('active', 'search_document', { signal: activeController.signal });
  const queued = engine.embed('queued', 'search_document', { signal: queuedController.signal });
  const activeRejected = expect(active).rejects.toThrow('cancel active'), queuedRejected = expect(queued).rejects.toThrow('cancel queued');
  queuedController.abort(new Error('cancel queued')); await queuedRejected;
  activeController.abort(new Error('cancel active')); await activeRejected;
  const next = engine.embed('next'); expect(pipe).toHaveBeenCalledTimes(1);
  waiting.resolve(result); await next; expect(pipe).toHaveBeenCalledTimes(2);
  expect(pipe.mock.calls[1][0]).toBe('search_document: next'); await engine.dispose();
});

it('charges queue waiting against the original deadline and drains timed-out native work', async () => {
  vi.useFakeTimers();
  const first = gate<typeof result>(), second = gate<typeof result>(); let calls = 0;
  const { engine, pipe } = await fixture(() => ++calls === 1 ? first.promise : second.promise);
  const firstResult = engine.embed('first'), queued = engine.embed('second'); const rejected = expect(queued).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(EMBEDDING_OPERATION_MS - 1000); first.resolve(result); await firstResult; await settle();
  expect(pipe).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000); await rejected;
  const closed = engine.dispose(); await settle(); expect(pipe.dispose).not.toHaveBeenCalled();
  second.resolve(result); await closed; expect(pipe.dispose).toHaveBeenCalledTimes(1);
});

it('rechecks monotonic expiry before queued inference even if timer callbacks have not run', async () => {
  let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time);
  const waiting = gate<typeof result>(), { engine, pipe } = await fixture(() => waiting.promise);
  const active = engine.embed('first'), queued = engine.embed('second');
  const done = Promise.all([expect(active).rejects.toThrow('timed out'), expect(queued).rejects.toThrow('timed out')]);
  time = EMBEDDING_OPERATION_MS + 1; waiting.resolve(result); await done;
  expect(pipe).toHaveBeenCalledTimes(1); await engine.dispose();
});

it.each([null, {}, 1, '', '   ', 'x'.repeat(8193), '😀'.repeat(2049)])('rejects invalid or excessive raw input before tokenization (%#)', async value => {
  const { engine, pipe } = await fixture();
  await expect(engine.embedForMatching(value as string, 'need')).rejects.toBeInstanceOf(EmbeddingInputError);
  expect(pipe.tokenizer).not.toHaveBeenCalled(); expect(pipe).not.toHaveBeenCalled(); await engine.dispose();
});

it('bounds UTF-8 bytes without stripping or truncating accepted text', async () => {
  const { engine, pipe } = await fixture(), text = '😀'.repeat(2048);
  await engine.embed(text); expect(pipe.mock.calls[0][0]).toBe(`search_document: ${text}`);
  expect(pipe.tokenizer).toHaveBeenCalledWith(`search_document: ${text}`, { padding: true, truncation: false }); await engine.dispose();
});

it('refuses token overflow before model inference and permits a subsequent valid request', async () => {
  const { engine, pipe } = await fixture(); pipe.tokenizer.mockReturnValueOnce({ input_ids: { dims: [1, 513] } });
  await expect(engine.embed('too many tokens')).rejects.toBeInstanceOf(EmbeddingInputError); expect(pipe).not.toHaveBeenCalled();
  pipe.tokenizer.mockReturnValueOnce({ input_ids: { dims: [1, 512] } });
  await engine.embed('fits'); expect(pipe).toHaveBeenCalledTimes(1); await engine.dispose();
});

it('respects a smaller tokenizer limit and rejects a pre-aborted request before tokenization', async () => {
  const { engine, pipe } = await fixture(); pipe.tokenizer.model_max_length = 8;
  await expect(engine.embed('would otherwise truncate')).rejects.toBeInstanceOf(EmbeddingInputError);
  const controller = new AbortController(); controller.abort(new Error('already cancelled'));
  await expect(engine.embed('cancelled', 'search_document', { signal: controller.signal })).rejects.toThrow('already cancelled');
  expect(pipe).not.toHaveBeenCalled(); expect(pipe.tokenizer).toHaveBeenCalledTimes(1); await engine.dispose();
});
