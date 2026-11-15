import { describe, expect, test } from "vitest";
import { readDatabaseUser } from "../src/database.js";

describe("HA connection identity", () => {
  test("accepts the configured runtime role and the previous owner role", () => {
    expect(
      readDatabaseUser("postgresql://shortlink_app:secret@db/shortener"),
    ).toBe("shortlink_app");
    expect(
      readDatabaseUser("postgresql://shortlink_lab:secret@db/shortener"),
    ).toBe("shortlink_lab");
  });
  test("decodes the explicitly configured user and rejects a missing principal", () => {
    expect(
      readDatabaseUser("postgresql://runtime%2Bapp:secret@db/shortener"),
    ).toBe("runtime+app");
    expect(() => readDatabaseUser("postgresql://db/shortener")).toThrow(
      "explicit application user",
    );
  });
});
