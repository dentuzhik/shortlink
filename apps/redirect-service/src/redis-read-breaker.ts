import type { FastifyBaseLogger } from "fastify";

const failureThreshold = 5;
const cooldownMs = 1000;

type CircuitState =
  | { status: "closed"; failures: number }
  | { status: "open"; retryAt: number }
  | { status: "half-open" };

export function createRedisReadBreaker(
  read: (key: string) => Promise<string | null>,
  log: Pick<FastifyBaseLogger, "debug" | "warn" | "info">,
) {
  let state: CircuitState = { status: "closed", failures: 0 };

  return async (key: string): Promise<string | null | undefined> => {
    if (state.status === "open") {
      if (performance.now() < state.retryAt) return undefined;
      state = { status: "half-open" };
    } else if (state.status === "half-open") {
      return undefined;
    }

    // Replacing the state object invalidates results from older attempts.
    const attemptState = state;
    try {
      const value = await read(key);
      if (state === attemptState) {
        if (attemptState.status === "half-open") {
          state = { status: "closed", failures: 0 };
          log.info("Redis read circuit closed");
        } else {
          attemptState.failures = 0;
        }
      }
      return value;
    } catch (error) {
      log.debug(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "Redis redirect lookup failed",
      );
      if (
        state === attemptState &&
        (attemptState.status === "half-open" ||
          ++attemptState.failures >= failureThreshold)
      ) {
        state = { status: "open", retryAt: performance.now() + cooldownMs };
        log.warn({ cooldownMs }, "Redis read circuit opened");
      }
      return undefined;
    }
  };
}
