/** One monotonic budget for a personal client's complete private operation. */
export const PRIVATE_OPERATION_DEADLINE_MS = 10_000;

export class PrivateOperationError extends Error {
  constructor(
    readonly code: 'PRIVATE_OPERATION_TIMEOUT' | 'PRIVATE_OPERATION_CANCELLED' | 'PRIVATE_OPERATION_FAILED',
    readonly outcome: 'not-sent' | 'unknown',
    cause: Error,
  ) {
    super(`${cause.message}${outcome === 'unknown' ? '; outcome unknown: the destination may have accepted the operation' : ''}`, { cause });
    this.name = 'PrivateOperationError';
  }
}

export function createPrivateOperation() {
  const controller = new AbortController();
  const expiresAt = performance.now() + PRIVATE_OPERATION_DEADLINE_MS;
  let transmitted = false;
  let uncertain = false;
  const timer = setTimeout(expire, PRIVATE_OPERATION_DEADLINE_MS);

  function cancel(cause: Error, code: PrivateOperationError['code'] = 'PRIVATE_OPERATION_CANCELLED'): void {
    if (!controller.signal.aborted) {
      controller.abort(new PrivateOperationError(code, transmitted ? 'unknown' : 'not-sent', cause));
    }
  }

  function expire(): void {
    cancel(new Error('Private operation exceeded its ten-second deadline'), 'PRIVATE_OPERATION_TIMEOUT');
  }

  function check(signal?: AbortSignal): void {
    // Also check elapsed time between stages: a busy event loop can delay timers.
    if (performance.now() >= expiresAt) expire();
    controller.signal.throwIfAborted();
    signal?.throwIfAborted();
  }

  return {
    signal: controller.signal,
    check,
    cancel,
    markSent(): void { check(); transmitted = true; },
    transportError(cause: Error): Error {
      if (controller.signal.aborted) return controller.signal.reason;
      uncertain ||= transmitted;
      return transmitted
        ? new PrivateOperationError('PRIVATE_OPERATION_FAILED', 'unknown', cause)
        : cause;
    },
    failure(cause: Error): Error {
      // A later fallback's rejection cannot undo an earlier unacknowledged send.
      if (controller.signal.aborted) return controller.signal.reason;
      return uncertain && !(cause instanceof PrivateOperationError)
        ? new PrivateOperationError('PRIVATE_OPERATION_FAILED', 'unknown', cause)
        : cause;
    },
    dispose(): void { clearTimeout(timer); },
  };
}

export type PrivateOperation = ReturnType<typeof createPrivateOperation>;
