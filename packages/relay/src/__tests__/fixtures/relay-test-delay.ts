/** Bounded, ordered stream delay for local network experiments. This delays
 * bytes after TCP delivery; it does not emulate IP packets, ACKs or congestion. */
import { Readable, Writable } from 'node:stream';

// One admitted window accommodates the application's <=512 KiB private frames
// and ~175 KiB history frames without charging another delay per TCP fragment.
// The FIFO plus Readable buffer share this byte cap. Writable adds its 64 KiB
// high-water mark and one held chunk (each chunk is capped at this window).
// A producer must respect write(false); exceeding the finite window imposes
// backpressure, so this is not a pure-latency model for arbitrarily large bursts.
export const RELAY_TEST_DELAY_WINDOW_BYTES = 1024 * 1024;
const WRITABLE_HIGH_WATER_MARK = 64 * 1024;

type Entry = { bytes: Buffer; readyAt: number };
type Pending = { bytes: Buffer; done(error?: Error | null): void };

export function createRelayTestDelay(delayMs: number) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('Invalid test network delay');
  let queue: Array<Entry | undefined> = [], head = 0, queuedBytes = 0;
  let pending: Pending | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false, closed = false, reading = false, pumping = false, scheduled = false;
  let input: Writable;
  function schedule() {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function shutdown(error?: Error | null) {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined; queue = []; head = 0; queuedBytes = 0;
    const held = pending; pending = undefined;
    // Release the active Writable callback even during a normal cancellation.
    // Node cancels any later buffered writes when the Writable is destroyed.
    input?.destroy(error ?? undefined); output.destroy(error ?? undefined);
    held?.done(error);
  }
  function admit(bytes: Buffer) {
    queue.push({ bytes, readyAt: performance.now() + delayMs }); queuedBytes += bytes.length;
  }
  function pump() {
    if (closed || pumping) return;
    pumping = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    try {
      while (!closed) {
        const held = pending;
        if (held && queuedBytes + output.readableLength + held.bytes.length <= RELAY_TEST_DELAY_WINDOW_BYTES) {
          pending = undefined; admit(held.bytes); held.done();
        }
        const next = queue[head];
        if (!reading || !next) break;
        const remaining = next.readyAt - performance.now();
        if (remaining > 0) { timer = setTimeout(pump, Math.ceil(remaining)); break; }
        queue[head++] = undefined; queuedBytes -= next.bytes.length;
        if (head === queue.length) { queue = []; head = 0; }
        else if (head >= 1024 && head * 2 >= queue.length) { queue = queue.slice(head); head = 0; }
        reading = output.push(next.bytes);
      }
      if (!closed && ended && !pending && head === queue.length) output.push(null);
    } finally { pumping = false; }
  }
  const output = new Readable({ highWaterMark: WRITABLE_HIGH_WATER_MARK,
    // Readable invokes _read before removing buffered bytes. The microtask sees
    // their updated byte count and can then admit a blocked input chunk.
    read() { reading = true; schedule(); },
    destroy(error, done) { shutdown(error); done(error); } });
  input = new Writable({ highWaterMark: WRITABLE_HIGH_WATER_MARK, autoDestroy: false,
    write(bytes: Buffer, _encoding, done) {
      if (closed) { done(new Error('Test delay stream is closed')); return; }
      if (bytes.length === 0) { done(); return; }
      if (bytes.length > RELAY_TEST_DELAY_WINDOW_BYTES) {
        const error = new RangeError('Test delay chunk exceeds its byte window');
        shutdown(error); done(error); return;
      }
      if (queuedBytes + output.readableLength + bytes.length <= RELAY_TEST_DELAY_WINDOW_BYTES) {
        admit(bytes); done(); pump();
      } else { pending = { bytes, done }; pump(); }
    },
    final(done) { ended = true; done(); pump(); },
    destroy(error, done) { shutdown(error); done(error); } });
  return { input, output, close() { input.destroy(); output.destroy(); } };
}
