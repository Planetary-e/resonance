import { connect } from 'node:net';

/** A refused loopback connection is evidence of a closed configured listener.
 * Timeout, a live but unauthenticated listener and other errors remain unknown. */
export function relayPortClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (closed: boolean) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(closed); };
    const timer = setTimeout(() => finish(false), 500);
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
  });
}
