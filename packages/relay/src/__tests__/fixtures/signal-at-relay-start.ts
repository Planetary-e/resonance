/** Signal synchronously at the first externally visible readiness marker. */
const signal = process.env.RESONANCE_TEST_SHUTDOWN_SIGNAL;
if (signal !== 'SIGTERM' && signal !== 'SIGINT') throw new Error('Invalid fixture signal');
const original = process.stdout.write;
let signalled = false;
process.stdout.write = function (this: NodeJS.WriteStream, ...args: Parameters<typeof original>) {
  const result = Reflect.apply(original, this, args);
  if (!signalled && String(args[0]).includes('"event":"started"')) {
    signalled = true;
    process.kill(process.pid, signal);
  }
  return result;
} as typeof original;
