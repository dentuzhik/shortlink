import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createRedisReadBreaker } from "../src/redis-read-breaker.js";

function setup() {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  onTestFinished(() => clock.mockRestore());
  const read = vi.fn<Parameters<typeof createRedisReadBreaker>[0]>();
  const log = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { clock, read, log, lookup: createRedisReadBreaker(read, log) };
}

describe("Redis read circuit breaker", () => {
  test("a successful miss resets consecutive failures", async () => {
    const { read, log, lookup } = setup();
    read.mockRejectedValue(new Error("Redis timed out"));
    for (let i = 0; i < 4; i++) await lookup("code");

    read.mockResolvedValueOnce(null);
    expect(await lookup("code")).toBeNull();
    for (let i = 0; i < 4; i++) await lookup("code");

    read.mockResolvedValueOnce("https://example.com");
    expect(await lookup("code")).toBe("https://example.com");
    expect(read).toHaveBeenCalledTimes(10);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("opens after five failures and allows only one recovery probe", async () => {
    const { clock, read, log, lookup } = setup();
    read.mockRejectedValue(new Error("Redis timed out"));
    for (let i = 0; i < 5; i++) expect(await lookup("code")).toBeUndefined();
    expect(await lookup("another-code")).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(5);

    const probe = Promise.withResolvers<string | null>();
    read.mockReturnValueOnce(probe.promise);
    clock.mockReturnValue(1000);
    const recovering = lookup("probe-code");
    expect(await lookup("concurrent-code")).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(6);
    probe.resolve("https://example.com");
    expect(await recovering).toBe("https://example.com");

    read.mockResolvedValueOnce("https://example.com/next");
    expect(await lookup("next-code")).toBe("https://example.com/next");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("Redis read circuit closed");
  });

  test("a failed probe restarts the cooldown and a successful miss closes it", async () => {
    const { clock, read, lookup } = setup();
    read.mockRejectedValue(new Error("Redis timed out"));
    for (let i = 0; i < 5; i++) await lookup("code");
    clock.mockReturnValue(1000);
    expect(await lookup("probe")).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(6);

    clock.mockReturnValue(1999);
    expect(await lookup("still-open")).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(6);
    clock.mockReturnValue(2000);
    read.mockResolvedValueOnce(null);
    expect(await lookup("missing-probe")).toBeNull();

    read.mockResolvedValueOnce("https://example.com");
    expect(await lookup("next-code")).toBe("https://example.com");
    expect(read).toHaveBeenCalledTimes(8);
  });

  test("late results from an earlier circuit state cannot change recovery", async () => {
    const { clock, read, log, lookup } = setup();
    const lateHit = Promise.withResolvers<string | null>();
    const lateError = Promise.withResolvers<string | null>();
    read
      .mockReturnValueOnce(lateHit.promise)
      .mockReturnValueOnce(lateError.promise);
    const hitRequest = lookup("old-hit");
    const errorRequest = lookup("old-error");
    read.mockRejectedValue(new Error("Redis timed out"));
    for (let i = 0; i < 5; i++) await lookup("code");

    clock.mockReturnValue(500);
    lateHit.resolve("https://example.com");
    expect(await hitRequest).toBe("https://example.com");
    expect(await lookup("still-open")).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(7);

    clock.mockReturnValue(1000);
    read.mockResolvedValueOnce(null);
    expect(await lookup("probe")).toBeNull();
    lateError.reject(new Error("Late Redis timeout"));
    expect(await errorRequest).toBeUndefined();
    for (let i = 0; i < 4; i++) await lookup("code");
    read.mockResolvedValueOnce("https://example.com/next");
    expect(await lookup("next-code")).toBe("https://example.com/next");
    expect(read).toHaveBeenCalledTimes(13);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
