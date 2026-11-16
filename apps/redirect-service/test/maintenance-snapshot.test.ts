import { expect, test, vi } from "vitest";
import {
  kubernetesMaintenanceSource,
  startMaintenanceWatch,
} from "../src/maintenance-watch.js";
import { RuntimeMaintenance } from "../src/runtime-maintenance.js";
import { maintenanceApi } from "./helpers/maintenance-api.js";

test("an unchanged ConfigMap starts its watch from the fresh collection snapshot", async () => {
  const api = await maintenanceApi();
  api.setAvailable(true);
  api.advanceCollection();
  const source = kubernetesMaintenanceSource(
    "shortlink",
    "shortlink-runtime",
    api,
  );
  const snapshot = await source.read(new AbortController().signal);
  expect(snapshot.metadata?.resourceVersion).toBe("2");
  expect(JSON.parse(snapshot.data?.["control.json"] ?? "{}")).toEqual({
    revision: 1,
    creationMode: "accept",
  });
  const control = new RuntimeMaintenance();
  const unavailable = vi.fn();
  const watcher = startMaintenanceWatch(control, source, unavailable, 10);
  try {
    await vi.waitFor(() =>
      expect(control.status().acceptingCreations).toBe(true),
    );
    expect(api.lastWatchVersion()).toBe("2");
    api.update({ revision: 2, creationMode: "accept" });
    await vi.waitFor(() => expect(control.status().observedRevision).toBe(2));
    expect(control.status().acceptingCreations).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    await watcher.stop();
    await api.close();
  }
});
