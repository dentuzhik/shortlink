export type DatabaseName = "source" | "ha";

export type MaintenanceConfig = {
  revision: number;
  creationMode: "accept" | "reject";
  activeDatabase?: DatabaseName;
  prepareDatabase?: DatabaseName | null;
};

export function parseMaintenanceConfig(value: unknown): MaintenanceConfig {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (key) =>
        ![
          "revision",
          "creationMode",
          "activeDatabase",
          "prepareDatabase",
        ].includes(key),
    ) ||
    !("revision" in value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !("creationMode" in value) ||
    !["accept", "reject"].includes(value.creationMode as string) ||
    ("activeDatabase" in value &&
      !["source", "ha"].includes(value.activeDatabase as string)) ||
    ("prepareDatabase" in value &&
      value.prepareDatabase !== null &&
      !["source", "ha"].includes(value.prepareDatabase as string))
  )
    throw new Error("Invalid maintenance configuration");
  const config = value as MaintenanceConfig;
  return {
    revision: config.revision,
    creationMode: config.creationMode,
    ...(config.activeDatabase === undefined
      ? {}
      : { activeDatabase: config.activeDatabase }),
    ...(config.prepareDatabase === undefined
      ? {}
      : { prepareDatabase: config.prepareDatabase }),
  };
}

export class RuntimeMaintenance {
  private config: MaintenanceConfig | undefined;
  private connected = false;
  private valid = false;
  private synchronized = false;
  private inflight = 0;
  private activeDatabase: DatabaseName | null = "source";

  constructor(localDevelopment = false) {
    if (localDevelopment) {
      this.config = { revision: 0, creationMode: "accept" };
      this.connected = this.valid = this.synchronized = true;
    }
  }

  observe(value: unknown) {
    this.valid = false;
    const next = parseMaintenanceConfig(value);
    if (
      this.config &&
      (next.revision < this.config.revision ||
        (next.revision === this.config.revision &&
          JSON.stringify(next) !== JSON.stringify(this.config)))
    )
      throw new Error(
        "Maintenance revision must increase when configuration changes",
      );
    if (
      this.config &&
      (next.activeDatabase ?? "source") !==
        (this.config.activeDatabase ?? "source") &&
      (this.config.creationMode !== "reject" ||
        next.creationMode !== "reject" ||
        this.inflight !== 0)
    ) {
      throw new Error(
        "Database selection requires a separate drained maintenance revision",
      );
    }
    this.config = { ...next };
    this.valid = true;
    return this.config;
  }

  isRevisionCurrent(revision: number) {
    return this.valid && this.config?.revision === revision;
  }

  setActiveDatabase(database: DatabaseName | null) {
    this.activeDatabase = database;
  }

  setConnected(connected: boolean) {
    this.connected = connected;
    if (connected && this.valid) this.synchronized = true;
  }

  get configurationLoaded() {
    return this.config !== undefined;
  }

  get configurationInitialized() {
    return this.configurationLoaded && this.synchronized;
  }

  status() {
    const configurationCurrent = this.connected && this.valid;
    const creationMode = this.config?.creationMode ?? "reject";
    return {
      observedRevision: this.config?.revision ?? null,
      configurationLoaded: this.configurationLoaded,
      configurationInitialized: this.configurationInitialized,
      configurationCurrent,
      creationMode,
      activeDatabase: this.activeDatabase,
      desiredDatabase: this.config?.activeDatabase ?? "source",
      prepareDatabase: this.config?.prepareDatabase ?? null,
      acceptingCreations:
        configurationCurrent &&
        creationMode === "accept" &&
        this.activeDatabase !== null &&
        this.activeDatabase === (this.config?.activeDatabase ?? "source"),
      inflightCreations: this.inflight,
      drained:
        configurationCurrent &&
        creationMode === "reject" &&
        this.inflight === 0,
    };
  }

  enterCreation(): (() => void) | undefined {
    if (!this.status().acceptingCreations) return undefined;
    // No await between checking admission and counting the operation.
    this.inflight++;
    let released = false;
    return () => {
      if (!released) this.inflight--;
      released = true;
    };
  }
}
