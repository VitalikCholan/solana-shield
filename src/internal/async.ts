/** Abort-aware sleep. Resolves after `ms`, rejects with the signal's reason on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(toAbortError(signal?.reason));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}
