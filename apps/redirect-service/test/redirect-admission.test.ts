import type { Pool, PoolClient } from "pg";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createRedirectCheckout } from "../src/redirect-admission.js";

function setup() {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  onTestFinished(() => {
    clock.mockRestore();
    vi.useRealTimers();
  });
  const pending = Promise.withResolvers<PoolClient>();
  const release = vi.fn();
  const client = { release } as unknown as PoolClient;
  const pool = {
    waitingCount: 0,
    totalCount: 5,
    idleCount: 0,
    connect: vi.fn(() => pending.promise),
  };
  const observe = vi.fn();
  const checkout = createRedirectCheckout(
    pool as unknown as Pool,
    128,
    50,
    observe,
  );
  return { clock, pending, release, client, pool, observe, checkout };
}

describe("redirect database checkout diagnostics", () => {
  test("reports queue admission rejection without starting a checkout", async () => {
    const { pool, checkout, observe } = setup();
    pool.waitingCount = 128;
    await expect(checkout()).rejects.toThrow("Postgres pool queue is full");
    expect(pool.connect).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      outcome: "queue_full",
      elapsedMs: 0,
      totalCount: 5,
      idleCount: 0,
      waitingCount: 128,
    });
  });

  test("reports successful acquisition and leaves ownership with the caller", async () => {
    const { checkout, clock, pending, client, release, observe } = setup();
    const result = checkout();
    clock.mockReturnValue(12);
    pending.resolve(client);
    expect(await result).toBe(client);
    expect(release).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "acquired", elapsedMs: 12 }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  test("counts a deadline once and releases a connection that arrives afterward", async () => {
    const { checkout, clock, pending, client, release, observe } = setup();
    const result = checkout().catch((error: unknown) => error);
    clock.mockReturnValue(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({
      message: "Postgres pool checkout timed out",
    });
    pending.resolve(client);
    await Promise.resolve();
    expect(release).toHaveBeenCalledExactlyOnceWith();
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "timeout", elapsedMs: 50 }),
    );
  });

  test("counts a deadline once if the pending pg checkout later rejects", async () => {
    const { checkout, clock, pending, observe } = setup();
    const result = checkout().catch((error: unknown) => error);
    clock.mockReturnValue(70);
    await vi.advanceTimersByTimeAsync(50);
    await result;
    pending.reject(new Error("connection failed later"));
    await Promise.resolve();
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "timeout", elapsedMs: 70 }),
    );
  });

  test("detects an overdue completion even before the timer callback can run", async () => {
    const { checkout, clock, pending, client, release, observe } = setup();
    const result = checkout();
    // Advance the elapsed clock without running timers, as when Node is delayed.
    clock.mockReturnValue(85);
    pending.resolve(client);
    await expect(result).rejects.toThrow("Postgres pool checkout timed out");
    expect(release).toHaveBeenCalledExactlyOnceWith();
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "timeout", elapsedMs: 85 }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  test("preserves a pg error before the deadline instead of classifying it as overload", async () => {
    const { checkout, pending, observe } = setup();
    const error = new Error("connection failed");
    const result = checkout();
    pending.reject(error);
    await expect(result).rejects.toBe(error);
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "error" }),
    );
  });
});
