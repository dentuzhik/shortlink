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
  let inFlightReads = 0;

  return async (key: string): Promise<string | null | undefined> => {
    if (state.status === "open") {
      if (performance.now() < state.retryAt) return undefined;
      state = { status: "half-open" };
    } else if (state.status === "half-open") {
      return undefined;
    }

    // Replacing the state object invalidates results from older attempts.
    const attemptState = state;
    const startedAt = performance.now();
    inFlightReads++;
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
      // ioredis uses a plain Error for this deadline. Do not log arbitrary error
      // messages, which could contain connection details.
      const failureKind =
        error instanceof Error && error.message === "Command timed out"
          ? "command-timeout"
          : "other";
      const failure = {
        errorType: error instanceof Error ? error.name : "unknown",
        failureKind,
        readElapsedMs: Number((performance.now() - startedAt).toFixed(3)),
        otherInFlightReads: inFlightReads - 1,
      };
      log.debug(failure, "Redis redirect lookup failed");
      if (
        state === attemptState &&
        (attemptState.status === "half-open" ||
          ++attemptState.failures >= failureThreshold)
      ) {
        state = { status: "open", retryAt: performance.now() + cooldownMs };
        log.warn(
          {
            ...failure,
            cooldownMs,
            trigger:
              attemptState.status === "half-open" ? "probe" : "threshold",
          },
          "Redis read circuit opened",
        );
      }
      return undefined;
    } finally {
      inFlightReads--;
    }
  };
}
