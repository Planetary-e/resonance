/** Bounded, ordered stream delay for local network experiments. This delays
 * bytes after TCP delivery; it does not emulate IP packets, ACKs or congestion. */
import { Transform } from 'node:stream';

export function createRelayTestDelay(delayMs: number) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('Invalid test network delay');
  // Timestamp before the delayed transform's queue. Otherwise a burst would
  // pay another full delay per chunk, accidentally imposing serialization.
  const stamp = new Transform({ readableObjectMode: true, writableHighWaterMark: 65536, readableHighWaterMark: 1,
    transform(bytes: Buffer, _encoding, done) { done(null, { bytes, readyAt: performance.now() + delayMs }); } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delayed = new Transform({ writableObjectMode: true, writableHighWaterMark: 1, readableHighWaterMark: 65536,
    transform(value: { bytes: Buffer; readyAt: number }, _encoding, done) {
      const deliver = () => {
        const remaining = value.readyAt - performance.now();
        if (remaining > 0) timer = setTimeout(deliver, Math.ceil(remaining));
        else { timer = undefined; done(null, value.bytes); }
      };
      deliver();
    },
    destroy(error, done) { if (timer) clearTimeout(timer); done(error); } });
  stamp.pipe(delayed);
  return { input: stamp, output: delayed, close() { stamp.destroy(); delayed.destroy(); } };
}
