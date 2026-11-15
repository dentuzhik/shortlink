import { describe, expect, test, vi } from "vitest";
import { createLinkCreator } from "../src/link-creation.js";
import {
  decodeWatch,
  type MaintenanceSource,
  startMaintenanceWatch,
} from "../src/maintenance-watch.js";
import { RuntimeMaintenance } from "../src/runtime-maintenance.js";

function activate(
  control: RuntimeMaintenance,
  revision: number,
  creationMode: "accept" | "reject",
) {
  control.observe({ revision, creationMode });
  control.setConnected(true);
}

describe("runtime creation admission", () => {
  test("starts closed, requires current configuration, and fails closed on loss of control", async () => {
    const control = new RuntimeMaintenance();
    const insert = vi.fn();
    const create = createLinkCreator({ insert }, undefined, control);
    expect(control.configurationLoaded).toBe(false);
    expect((await create("https://example.com")).status).toBe("maintenance");
    control.observe({ revision: 1, creationMode: "accept" });
    expect(control.enterCreation()).toBeUndefined();
    expect(control.configurationInitialized).toBe(false);
    control.setConnected(true);
    expect(control.configurationInitialized).toBe(true);
    const release = control.enterCreation();
    expect(release).toBeTypeOf("function");
    release?.();
    release?.();
    expect(control.status().inflightCreations).toBe(0);
    control.setConnected(false);
    expect((await create("https://example.com")).status).toBe("maintenance");
    expect(insert).not.toHaveBeenCalled();
    expect(control.configurationLoaded).toBe(true);
    expect(control.configurationInitialized).toBe(true);
  });

  test("drains the complete admitted creation including collision retries", async () => {
    const control = new RuntimeMaintenance();
    activate(control, 1, "accept");
    const first = Promise.withResolvers<undefined>();
    const insert = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        code: "fresh123",
        targetUrl: "https://example.com/",
        createdAt: new Date(),
      });
    const create = createLinkCreator({ insert }, () => "fresh123", control);
    const admitted = create("https://example.com");
    activate(control, 2, "reject");
    expect(control.status()).toMatchObject({
      inflightCreations: 1,
      drained: false,
    });
    expect((await create("https://example.com")).status).toBe("maintenance");
    expect(insert).toHaveBeenCalledTimes(1);
    first.resolve(undefined);
    expect((await admitted).status).toBe("created");
    expect(insert).toHaveBeenCalledTimes(2);
    expect(control.status()).toMatchObject({
      inflightCreations: 0,
      drained: true,
    });
  });

  test("releases admitted work after validation, collision exhaustion and database errors", async () => {
    const control = new RuntimeMaintenance();
    activate(control, 1, "accept");
    const insert = vi.fn().mockResolvedValue(undefined);
    const create = createLinkCreator({ insert }, undefined, control);
    expect((await create("ftp://example.com")).status).toBe("invalid-url");
    expect((await create("https://example.com")).status).toBe(
      "codes-exhausted",
    );
    insert.mockRejectedValueOnce(new Error("connection lost"));
    await expect(create("https://example.com")).rejects.toThrow(
      "connection lost",
    );
    activate(control, 2, "reject");
    expect(control.status().drained).toBe(true);
  });

  test.each([
    { revision: 1, creationMode: "accept" },
    { revision: 0, creationMode: "accept" },
    { revision: 3, creationMode: "typo" },
    { revision: 3, creationMode: "accept", activeDatabase: "ha" },
    { revision: "3", creationMode: "accept" },
    null,
  ])(
    "rejects invalid, stale or conflicting configuration without reopening: %j",
    (value) => {
      const control = new RuntimeMaintenance();
      activate(control, 2, "reject");
      expect(() => control.observe(value)).toThrow();
      expect(control.status()).toMatchObject({
        observedRevision: 2,
        creationMode: "reject",
        configurationCurrent: false,
      });
      expect(control.enterCreation()).toBeUndefined();
      activate(control, 3, "reject");
      expect(control.status().drained).toBe(true);
    },
  );

  test("requires a new revision to change modes", () => {
    const control = new RuntimeMaintenance();
    activate(control, 2, "reject");
    expect(() =>
      control.observe({ revision: 2, creationMode: "accept" }),
    ).toThrow();
    activate(control, 3, "accept");
    expect(control.status().acceptingCreations).toBe(true);
  });
});

describe("ConfigMap stream", () => {
  test("decodes split UTF8 events and rejects a truncated final event", async () => {
    const bytes = Buffer.from(
      JSON.stringify({ type: "MODIFIED", object: { data: { note: "é" } } }) +
        "\n",
    );
    const chunks = async function* () {
      for (const byte of bytes) yield Buffer.from([byte]);
    };
    const events = [];
    for await (const event of decodeWatch(chunks())) events.push(event);
    expect(events).toEqual([
      { type: "MODIFIED", object: { data: { note: "é" } } },
    ]);
    await expect(async () => {
      for await (const _event of decodeWatch(
        (async function* () {
          yield Buffer.from('{"type":');
        })(),
      )) {
        /* consume */
      }
    }).rejects.toThrow("Incomplete");
  });

  test("refetches after expired watch history and preserves maintenance after reconnect", async () => {
    const control = new RuntimeMaintenance();
    const failure = vi.fn();
    const read = vi.fn<MaintenanceSource["read"]>();
    read.mockImplementation(async () => ({
      metadata: { resourceVersion: String(read.mock.calls.length) },
      data: {
        "control.json": JSON.stringify({
          revision: read.mock.calls.length,
          creationMode: read.mock.calls.length === 1 ? "accept" : "reject",
        }),
      },
    }));
    const source: MaintenanceSource = {
      read,
      async *watch(version, signal, opened) {
        opened();
        if (version === "1") {
          yield { type: "ERROR", object: {} };
          return;
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    };
    const watcher = startMaintenanceWatch(control, source, failure, 1);
    try {
      await vi.waitFor(() =>
        expect(control.status()).toMatchObject({
          observedRevision: 2,
          drained: true,
        }),
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(failure).toHaveBeenCalledOnce();
    } finally {
      await watcher.stop();
    }
    expect(control.status().acceptingCreations).toBe(false);
  });
});
