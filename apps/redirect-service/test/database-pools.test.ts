import type { PeerCertificate } from "node:tls";
import type { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";
import { createDatabasePool } from "../src/database.js";
import { DatabasePools } from "../src/database-pools.js";
import {
  type MaintenanceConfig,
  RuntimeMaintenance,
} from "../src/runtime-maintenance.js";

function setup(boot = false) {
  const control = new RuntimeMaintenance(!boot);
  const pools: {
    name: string;
    end: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  }[] = [];
  const factory = vi.fn((url: string) => {
    const name = new URL(url).pathname.slice(1);
    const client = {
      query: vi.fn(async () => ({
        rows: [
          {
            database: name,
            role: "app",
            recovery: false,
            read_only: "off",
            tls: false,
            superuser: false,
            can_insert: true,
            can_allocate: true,
            history: true,
          },
        ],
      })),
      release: vi.fn(),
    };
    const pool = {
      name,
      end: vi.fn(async () => {}),
      on: vi.fn(),
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    };
    pools.push(pool);
    return pool as unknown as Pool;
  });
  const database = new DatabasePools(
    "postgres://app:password@localhost/source",
    control,
    {
      poolMax: 2,
      maxWaiters: 2,
      checkoutTimeoutMs: 50,
      observeCheckout: () => {},
      onPoolError: () => {},
      targets: {
        ha: { connectionString: "postgres://app:password@localhost/ha" },
      },
    },
    factory,
  );
  const apply = async (config: MaintenanceConfig) => {
    control.observe(config);
    control.setConnected(true);
    await database.configure(config);
  };
  return { control, database, pools, factory, apply };
}

describe("database pool handoff", () => {
  test("prepares without changing traffic, pins an ongoing read and retires it only after completion", async () => {
    const { database, apply, pools } = setup();
    const hold = Promise.withResolvers<void>();
    const ongoing = database.use(async (g) => {
      await hold.promise;
      return g.name;
    });
    try {
      await apply({
        revision: 1,
        creationMode: "accept",
        prepareDatabase: "ha",
      });
      expect(database.status()).toMatchObject({
        activeDatabase: "source",
        preparedDatabase: "ha",
        candidateReady: true,
      });
      expect(await database.use(async (g) => g.name)).toBe("source");
      await apply({
        revision: 2,
        creationMode: "reject",
        prepareDatabase: "ha",
      });
      await apply({
        revision: 3,
        creationMode: "reject",
        activeDatabase: "ha",
      });
      expect(database.status()).toMatchObject({
        activeDatabase: "ha",
        retiringPools: [{ database: "source", inflightOperations: 1 }],
      });
      expect(pools[0]?.end).not.toHaveBeenCalled();
      expect(await database.use(async (g) => g.name)).toBe("ha");
      expect(database.cacheGeneration()).toBe(1);
      hold.resolve();
      expect(await ongoing).toBe("source");
      await vi.waitFor(() => expect(pools[0]?.end).toHaveBeenCalledOnce());
      await apply({
        revision: 4,
        creationMode: "accept",
        activeDatabase: "ha",
      });
    } finally {
      hold.resolve();
      await ongoing;
      await database.close();
    }
    expect(pools.every((p) => p.end.mock.calls.length === 1)).toBe(true);
  });

  test("refuses a switch without a separately prepared candidate", async () => {
    const { database, apply } = setup();
    try {
      await apply({ revision: 1, creationMode: "reject" });
      await apply({
        revision: 2,
        creationMode: "reject",
        activeDatabase: "ha",
      });
      expect(database.status()).toMatchObject({
        activeDatabase: "source",
        error: "database_configuration_failed",
      });
    } finally {
      await database.close();
    }
  });

  test("failed activation revalidation keeps the original pool and cannot reopen writes on the wrong database", async () => {
    const { database, apply, pools, control } = setup();
    try {
      await apply({
        revision: 1,
        creationMode: "reject",
        prepareDatabase: "ha",
      });
      pools[1]?.connect.mockRejectedValueOnce(
        new Error("sensitive connection details"),
      );
      await apply({
        revision: 2,
        creationMode: "reject",
        activeDatabase: "ha",
      });
      expect(database.status()).toMatchObject({
        activeDatabase: "source",
        candidateReady: false,
        error: "database_configuration_failed",
      });
      await apply({
        revision: 3,
        creationMode: "accept",
        activeDatabase: "ha",
      });
      expect(control.status().acceptingCreations).toBe(false);
      expect(database.status().activeDatabase).toBe("source");
      expect(JSON.stringify(database.status())).not.toContain("sensitive");
    } finally {
      await database.close();
    }
  });

  test("restarted process connects directly to configured HA instead of opening a source pool", async () => {
    const { database, apply, factory, control } = setup(true);
    try {
      expect(factory).not.toHaveBeenCalled();
      expect(control.status().acceptingCreations).toBe(false);
      await apply({
        revision: 8,
        creationMode: "accept",
        activeDatabase: "ha",
      });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0]?.[0]).toContain("/ha");
      expect(control.status().acceptingCreations).toBe(true);
    } finally {
      await database.close();
    }
  });

  test("shutdown closes active and prepared pools and waits for admitted operations", async () => {
    const { database, apply, pools } = setup();
    await apply({ revision: 1, creationMode: "accept", prepareDatabase: "ha" });
    const hold = Promise.withResolvers<void>();
    const read = database.use(async () => hold.promise);
    const closing = database.close();
    await expect(database.probe()).rejects.toThrow("No active");
    expect(pools[0]?.end).not.toHaveBeenCalled();
    hold.resolve();
    await read;
    await closing;
    expect(pools.every((p) => p.end.mock.calls.length === 1)).toBe(true);
  });

  test("a database selection change requires maintenance in a previous revision and zero creations", () => {
    const control = new RuntimeMaintenance(true);
    expect(() =>
      control.observe({
        revision: 1,
        creationMode: "reject",
        activeDatabase: "ha",
      }),
    ).toThrow("separate");
    control.observe({ revision: 2, creationMode: "accept" });
    const release = control.enterCreation();
    control.observe({ revision: 3, creationMode: "reject" });
    expect(() =>
      control.observe({
        revision: 4,
        creationMode: "reject",
        activeDatabase: "ha",
      }),
    ).toThrow("separate");
    release?.();
    expect(() =>
      control.observe({
        revision: 5,
        creationMode: "reject",
        activeDatabase: "ha",
      }),
    ).not.toThrow();
  });

  test("shutdown waits for candidate validation and closes its pool", async () => {
    const { database, apply, pools } = setup();
    await apply({ revision: 1, creationMode: "accept", prepareDatabase: "ha" });
    const candidate = pools[1];
    if (!candidate) throw new Error("Missing prepared pool");
    const client = await candidate.connect();
    const hold = Promise.withResolvers<typeof client>();
    candidate.connect.mockReturnValueOnce(hold.promise);
    const applying = apply({
      revision: 2,
      creationMode: "accept",
      prepareDatabase: "ha",
    });
    await vi.waitFor(() => expect(candidate.connect).toHaveBeenCalledTimes(3));
    const closing = database.close();
    hold.resolve(client);
    await Promise.all([applying, closing]);
    expect(pools.every((p) => p.end.mock.calls.length === 1)).toBe(true);
  });

  test("a superseded switch cannot activate after a later cancellation revision", async () => {
    const { database, apply, pools, control } = setup();
    try {
      await apply({
        revision: 1,
        creationMode: "reject",
        prepareDatabase: "ha",
      });
      const candidate = pools[1];
      if (!candidate) throw new Error("Missing candidate");
      const client = await candidate.connect();
      const hold = Promise.withResolvers<typeof client>();
      candidate.connect.mockReturnValueOnce(hold.promise);
      const first = apply({
        revision: 2,
        creationMode: "reject",
        activeDatabase: "ha",
      });
      await vi.waitFor(() =>
        expect(candidate.connect).toHaveBeenCalledTimes(3),
      );
      const newer = {
        revision: 3,
        creationMode: "reject",
        activeDatabase: "source",
      } as const;
      control.observe(newer);
      const cancelled = database.configure(newer);
      hold.resolve(client);
      await Promise.all([first, cancelled]);
      expect(database.status()).toMatchObject({
        activeDatabase: "source",
        preparedDatabase: null,
        appliedRevision: 3,
      });
      expect(database.cacheGeneration()).toBe(0);
    } finally {
      await database.close();
    }
  });

  test("TLS checks the configured certificate name even when pg supplies the proxy hostname", async () => {
    const pool = createDatabasePool(
      "postgres://app:secret@proxy.internal/ha",
      1,
      { ca: "fixture CA", servername: "database.internal" },
    );
    try {
      const tls = pool.options.ssl;
      if (!tls || typeof tls !== "object")
        throw new Error("Missing TLS configuration");
      const certificate = {
        subjectaltname: "DNS:database.internal",
        subject: { CN: "database.internal" },
      } as PeerCertificate;
      expect(tls.rejectUnauthorized).toBe(true);
      expect(
        tls.checkServerIdentity?.("proxy.internal", certificate),
      ).toBeUndefined();
      expect(
        tls.checkServerIdentity?.("proxy.internal", {
          ...certificate,
          subjectaltname: "DNS:other.internal",
        }),
      ).toBeInstanceOf(Error);
    } finally {
      await pool.end();
    }
  });

  test("explicit verified TLS cannot be overridden by connection-string SSL options", () => {
    expect(() =>
      createDatabasePool(
        "postgres://app:secret@localhost/ha?sslmode=require",
        1,
        { ca: "test CA" },
      ),
    ).toThrow("one database configuration");
  });
});
