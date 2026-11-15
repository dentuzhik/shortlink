import type { ConnectionOptions } from "node:tls";
import { createLinkStore } from "@url-shortener/db/links";
import type { Pool } from "pg";
import { createDatabasePool } from "./database.js";
import {
  createRedirectCheckout,
  type RedirectCheckoutObservation,
} from "./redirect-admission.js";
import type {
  DatabaseName,
  MaintenanceConfig,
  RuntimeMaintenance,
} from "./runtime-maintenance.js";

export type DatabaseTarget = {
  connectionString: string;
  expectedDatabase?: string;
  expectedRole?: string;
  ssl?: ConnectionOptions;
  requireTLS?: boolean;
  requireNonSuperuser?: boolean;
};
type Generation = {
  name: DatabaseName;
  pool: Pool;
  store: ReturnType<typeof createLinkStore>;
  inflight: number;
  retiring: boolean;
  ending: boolean;
  healthy: boolean;
  finished: ReturnType<typeof Promise.withResolvers<void>>;
};
export class DatabasePools {
  private active: Generation | undefined;
  private candidate: Generation | undefined;
  private generations = new Set<Generation>();
  private closed = false;
  private epoch = 0;
  private appliedRevision: number | null = null;
  private lastError: string | null = null;
  private configuring: Promise<void> = Promise.resolve();
  private readonly targets: Partial<Record<DatabaseName, DatabaseTarget>>;

  constructor(
    sourceUrl: string,
    private readonly maintenance: RuntimeMaintenance,
    private readonly options: {
      poolMax: number;
      maxWaiters: number;
      checkoutTimeoutMs: number;
      observeCheckout: (observation: RedirectCheckoutObservation) => void;
      onPoolError: () => void;
      targets?: Partial<Record<DatabaseName, DatabaseTarget>>;
    },
    private readonly makePool = createDatabasePool,
  ) {
    this.targets = {
      source: { connectionString: sourceUrl },
      ...options.targets,
    };
    if (maintenance.configurationLoaded) {
      this.active = this.create("source");
      this.appliedRevision = maintenance.status().observedRevision;
    } else maintenance.setActiveDatabase(null);
  }

  private create(name: DatabaseName) {
    const target = this.targets[name];
    if (!target) throw new Error("Database target is not configured");
    const pool = this.makePool(
      target.connectionString,
      this.options.poolMax,
      target.ssl,
      true,
    );
    const checkout = createRedirectCheckout(
      pool,
      this.options.maxWaiters,
      this.options.checkoutTimeoutMs,
      this.options.observeCheckout,
    );
    const generation: Generation = {
      name,
      pool,
      store: createLinkStore(pool, checkout),
      inflight: 0,
      retiring: false,
      ending: false,
      healthy: false,
      finished: Promise.withResolvers<void>(),
    };
    generation.finished.promise.catch(() => {});
    pool.on("error", () => {
      generation.healthy = false;
      this.options.onPoolError();
    });
    this.generations.add(generation);
    return generation;
  }

  private async validate(generation: Generation) {
    const target = this.targets[generation.name];
    if (!target) throw new Error("Database target is not configured");
    const url = new URL(target.connectionString);
    const expectedRole =
      target.expectedRole ??
      (url.username ? decodeURIComponent(url.username) : undefined);
    generation.healthy = false;
    const client = await generation.pool.connect();
    let failed = true;
    try {
      const {
        rows: [identity],
      } =
        await client.query(`SELECT current_database() AS database, current_user AS role,
        pg_is_in_recovery() AS recovery, current_setting('transaction_read_only') AS read_only,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
        (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
        has_table_privilege(current_user,'public.links','INSERT') AS can_insert,
        has_sequence_privilege(current_user,'public.links_id_seq','USAGE') AS can_allocate,
        to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS history`);
      if (
        !identity ||
        identity.database !==
          (target.expectedDatabase ??
            decodeURIComponent(url.pathname.slice(1))) ||
        (expectedRole !== undefined && identity.role !== expectedRole) ||
        identity.recovery ||
        identity.read_only !== "off" ||
        !identity.can_insert ||
        !identity.can_allocate ||
        !identity.history ||
        (target.requireTLS && !identity.tls) ||
        (target.requireNonSuperuser && identity.superuser)
      ) {
        throw new Error("Database identity or capabilities did not match");
      }
      await client.query(
        "SELECT code,target_url,created_at FROM public.links LIMIT 0",
      );
      failed = false;
      generation.healthy = true;
    } finally {
      client.release(failed);
    }
  }

  private finish(generation: Generation) {
    if (!generation.retiring || generation.inflight !== 0 || generation.ending)
      return;
    generation.ending = true;
    void generation.pool.end().then(
      () => {
        this.generations.delete(generation);
        generation.finished.resolve();
      },
      () => {
        this.options.onPoolError();
        generation.finished.reject(new Error("Database pool close failed"));
      },
    );
  }
  private retire(generation: Generation) {
    generation.retiring = true;
    this.finish(generation);
  }
  private async prepare(name: DatabaseName) {
    if (this.candidate?.name !== name) {
      const previous = this.candidate;
      this.candidate = undefined;
      if (previous) this.retire(previous);
      this.candidate = this.create(name);
    }
    const generation = this.candidate;
    try {
      await this.validate(generation);
      return generation;
    } catch (error) {
      this.candidate = undefined;
      this.retire(generation);
      throw error;
    }
  }

  configure(config: MaintenanceConfig) {
    this.configuring = this.configuring.then(() => this.apply(config));
    return this.configuring;
  }
  private async apply(config: MaintenanceConfig) {
    if (this.closed || !this.maintenance.isRevisionCurrent(config.revision))
      return;
    this.lastError = null;
    try {
      const desired = config.activeDatabase ?? "source";
      if (!this.active) {
        const initial = await this.prepare(desired);
        if (this.closed || !this.maintenance.isRevisionCurrent(config.revision))
          return;
        this.active = initial;
        this.candidate = undefined;
        this.maintenance.setActiveDatabase(desired);
      } else if (this.active.name !== desired) {
        const gate = this.maintenance.status();
        if (
          gate.creationMode !== "reject" ||
          gate.inflightCreations !== 0 ||
          this.candidate?.name !== desired
        ) {
          throw new Error(
            "Database switch requires drained maintenance and an already prepared pool",
          );
        }
        // Recheck a candidate that may have gone stale since preparation.
        await this.validate(this.candidate);
        if (this.closed || !this.maintenance.isRevisionCurrent(config.revision))
          return;
        const old = this.active;
        this.active = this.candidate;
        this.candidate = undefined;
        this.epoch++;
        this.maintenance.setActiveDatabase(desired);
        this.retire(old);
      }
      if (config.prepareDatabase && config.prepareDatabase !== desired) {
        await this.prepare(config.prepareDatabase);
      } else if (this.candidate) {
        this.retire(this.candidate);
        this.candidate = undefined;
      }
      if (!this.closed && this.maintenance.isRevisionCurrent(config.revision))
        this.appliedRevision = config.revision;
    } catch {
      this.lastError = "database_configuration_failed";
      // Retain the active pool. Never silently move writes back to another database.
    }
  }

  async use<T>(operation: (generation: Generation) => Promise<T>): Promise<T> {
    const generation = this.active;
    if (this.closed || !generation) throw new Error("No active database pool");
    generation.inflight++;
    try {
      return await operation(generation);
    } finally {
      generation.inflight--;
      this.finish(generation);
    }
  }
  readonly store = {
    insert: (code: string, targetUrl: string) =>
      this.use((g) => g.store.insert(code, targetUrl)),
    findTargetUrl: (
      ...args: Parameters<ReturnType<typeof createLinkStore>["findTargetUrl"]>
    ) => this.use((g) => g.store.findTargetUrl(...args)),
  };
  probe() {
    return this.use(async (g) => {
      await g.pool.query("SELECT 1");
    });
  }
  cacheGeneration() {
    return this.epoch;
  }
  poolState() {
    return (
      this.active?.pool ?? { totalCount: 0, idleCount: 0, waitingCount: 0 }
    );
  }
  status() {
    return {
      appliedRevision: this.appliedRevision,
      activeDatabase: this.active?.name ?? null,
      preparedDatabase: this.candidate?.name ?? null,
      candidateReady: this.candidate?.healthy ?? false,
      retiringPools: [...this.generations]
        .filter((g) => g.retiring)
        .map((g) => ({ database: g.name, inflightOperations: g.inflight })),
      error: this.lastError,
    };
  }
  async close() {
    this.closed = true;
    await this.configuring;
    const generations = [...this.generations];
    for (const generation of generations) this.retire(generation);
    await Promise.all(generations.map((g) => g.finished.promise));
  }
}
