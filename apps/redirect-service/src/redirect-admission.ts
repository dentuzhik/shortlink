import type { Pool, PoolClient } from "pg";

export class RedirectPoolBusyError extends Error {}

export function createRedirectCheckout(
  pool: Pool,
  maxWaiters: number,
  timeoutMs: number,
) {
  if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 1) {
    throw new Error("REDIRECT_DB_MAX_WAITERS must be a positive integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 500) {
    throw new Error(
      "REDIRECT_DB_CHECKOUT_TIMEOUT_MS must be between 1 and 500",
    );
  }

  return async (): Promise<PoolClient> => {
    if (pool.waitingCount >= maxWaiters) {
      throw new RedirectPoolBusyError("Postgres pool queue is full");
    }

    const startedAt = performance.now();
    const checkout = pool.connect();
    return new Promise((resolve, reject) => {
      let expired = false;
      const expire = () => {
        expired = true;
        reject(new RedirectPoolBusyError("Postgres pool checkout timed out"));
      };
      const timer = setTimeout(expire, timeoutMs);

      void checkout.then(
        (client) => {
          clearTimeout(timer);
          if (expired || performance.now() - startedAt >= timeoutMs) {
            // pg keeps the waiter until checkout or its own timeout.
            client.release();
            if (!expired) expire();
            return;
          }
          resolve(client);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (performance.now() - startedAt >= timeoutMs) {
            expire();
          } else {
            reject(error);
          }
        },
      );
    });
  };
}
