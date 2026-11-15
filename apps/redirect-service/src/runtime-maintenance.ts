export type MaintenanceConfig = {
  revision: number;
  creationMode: "accept" | "reject";
};

export function parseMaintenanceConfig(value: unknown): MaintenanceConfig {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "creationMode,revision" ||
    !("revision" in value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !("creationMode" in value) ||
    !["accept", "reject"].includes(value.creationMode as string)
  )
    throw new Error("Invalid maintenance configuration");
  return value as MaintenanceConfig;
}

export class RuntimeMaintenance {
  private config: MaintenanceConfig | undefined;
  private connected = false;
  private valid = false;
  private inflight = 0;

  constructor(localDevelopment = false) {
    if (localDevelopment) {
      this.config = { revision: 0, creationMode: "accept" };
      this.connected = this.valid = true;
    }
  }

  observe(value: unknown) {
    this.valid = false;
    const next = parseMaintenanceConfig(value);
    if (
      this.config &&
      (next.revision < this.config.revision ||
        (next.revision === this.config.revision &&
          next.creationMode !== this.config.creationMode))
    )
      throw new Error(
        "Maintenance revision must increase when configuration changes",
      );
    this.config = { ...next };
    this.valid = true;
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  get configurationLoaded() {
    return this.config !== undefined;
  }

  status() {
    const configurationCurrent = this.connected && this.valid;
    const creationMode = this.config?.creationMode ?? "reject";
    return {
      observedRevision: this.config?.revision ?? null,
      configurationLoaded: this.configurationLoaded,
      configurationCurrent,
      creationMode,
      acceptingCreations: configurationCurrent && creationMode === "accept",
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
