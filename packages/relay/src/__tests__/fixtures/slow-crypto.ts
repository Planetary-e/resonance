/** Opt-in load fixture: retain real signature checks but make each one cost 20 ms more. */
import nacl from 'tweetnacl';
import { afterAll, beforeAll, vi } from 'vitest';

const verify = nacl.sign.detached.verify;
let restore: (() => void) | undefined;
beforeAll(() => {
  const spy = vi.spyOn(nacl.sign.detached, 'verify').mockImplementation((...args) => {
    const until = performance.now() + 20;
    while (performance.now() < until) { /* Model synchronous crypto work on a slower CPU. */ }
    return verify(...args);
  });
  restore = () => spy.mockRestore();
});
afterAll(() => restore?.());
