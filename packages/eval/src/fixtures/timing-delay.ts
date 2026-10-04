/** Application-frame delay simulation for local eval only, never production. */
import WebSocket from 'ws';

export function simulateFrameDelay(beforeSend?: (socket: WebSocket, data: unknown) => void) {
  const original = WebSocket.prototype.send;
  let seed = 1;
  let enabled = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  WebSocket.prototype.send = function (data, ...args) {
    beforeSend?.(this, data);
    if (!enabled) return Reflect.apply(original, this, [data, ...args]);
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const delayMs = 20 + ((seed >>> 0) % 41);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (this.readyState === WebSocket.OPEN) Reflect.apply(original, this, [data, ...args]);
      else {
        const callback = args.find(value => typeof value === 'function');
        callback?.(new Error('Simulated link closed before frame delivery'));
      }
    }, delayMs);
    timers.add(timer);
  };
  return {
    configure(delay: boolean, nextSeed: number) { enabled = delay; seed = nextSeed || 1; },
    restore() {
      WebSocket.prototype.send = original;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Epoch timestamps on one host; separate processes have separate time origins. */
export function timingNow(): number { return performance.timeOrigin + performance.now(); }
