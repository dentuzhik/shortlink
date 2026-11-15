import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { get } from "node:https";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type {
  MaintenanceConfig,
  RuntimeMaintenance,
} from "./runtime-maintenance.js";

export type ConfigMapDocument = {
  metadata?: { resourceVersion?: string };
  data?: { [key: string]: string };
};
export type ConfigMapEvent = { type: string; object: ConfigMapDocument };
export interface MaintenanceSource {
  read(signal: AbortSignal): Promise<ConfigMapDocument>;
  watch(
    resourceVersion: string,
    signal: AbortSignal,
    opened: () => void,
  ): AsyncIterable<ConfigMapEvent>;
}

export async function* decodeWatch(stream: AsyncIterable<Buffer>) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending) > 65536)
      throw new Error("Oversized ConfigMap watch event");
    let boundary = pending.indexOf("\n");
    while (boundary >= 0) {
      const line = pending.slice(0, boundary).trim();
      pending = pending.slice(boundary + 1);
      if (line) yield JSON.parse(line) as ConfigMapEvent;
      boundary = pending.indexOf("\n");
    }
  }
  pending += decoder.end();
  if (pending.trim()) throw new Error("Incomplete ConfigMap watch event");
}

export function kubernetesMaintenanceSource(
  namespace: string,
  name: string,
  {
    endpoint = "https://kubernetes.default.svc",
    credentialsDirectory = "/var/run/secrets/kubernetes.io/serviceaccount",
  } = {},
): MaintenanceSource {
  if (
    ![namespace, name].every((part) =>
      /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(part),
    )
  ) {
    throw new Error("Invalid maintenance ConfigMap target");
  }
  if (new URL(endpoint).protocol !== "https:")
    throw new Error("Kubernetes API requires TLS");
  const base = `/api/v1/namespaces/${namespace}/configmaps`;
  async function request(path: string, signal: AbortSignal) {
    // Reread projected credentials for each request, including token rotation.
    const [token, ca] = await Promise.all([
      readFile(`${credentialsDirectory}/token`, "utf8"),
      readFile(`${credentialsDirectory}/ca.crt`),
    ]);
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = get(
        new URL(path, endpoint),
        {
          ca,
          signal,
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            Accept: "application/json",
          },
        },
        (response) => {
          clearTimeout(timer);
          if (response.statusCode !== 200) {
            response.destroy();
            reject(
              new Error(
                `Kubernetes ConfigMap request returned ${response.statusCode}`,
              ),
            );
            return;
          }
          response.setTimeout(35000, () =>
            response.destroy(new Error("ConfigMap stream stalled")),
          );
          resolve(response);
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error("Kubernetes API connection timed out")),
        3000,
      );
      req.on("error", () => {
        clearTimeout(timer);
        reject(new Error("Kubernetes ConfigMap connection failed"));
      });
    });
  }
  return {
    async read(signal) {
      const response = await request(`${base}/${name}`, signal);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 65536) {
          response.destroy();
          throw new Error("Oversized maintenance ConfigMap");
        }
        chunks.push(chunk);
      }
      return JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as ConfigMapDocument;
    },
    async *watch(resourceVersion, signal, opened) {
      const query = new URLSearchParams({
        watch: "true",
        fieldSelector: `metadata.name=${name}`,
        resourceVersion,
        timeoutSeconds: "30",
        allowWatchBookmarks: "true",
      });
      const response = await request(`${base}?${query}`, signal);
      opened();
      yield* decodeWatch(response);
    },
  };
}

export function startMaintenanceWatch(
  control: RuntimeMaintenance,
  source: MaintenanceSource,
  onUnavailable: () => void,
  retryMs = 1000,
  applyDatabase?: (config: MaintenanceConfig) => Promise<void>,
) {
  const abort = new AbortController();
  const { signal } = abort;
  const observe = async (document: ConfigMapDocument) => {
    const text = document.data?.["control.json"];
    if (!text) throw new Error("Missing maintenance configuration");
    const config = control.observe(JSON.parse(text));
    await applyDatabase?.(config);
  };
  const done = (async () => {
    while (!signal.aborted) {
      try {
        // A fresh GET also recovers after expired resource versions (HTTP 410).
        const document = await source.read(signal);
        const resourceVersion = document.metadata?.resourceVersion;
        if (!resourceVersion)
          throw new Error("Missing ConfigMap resourceVersion");
        await observe(document);
        for await (const event of source.watch(resourceVersion, signal, () =>
          control.setConnected(true),
        )) {
          if (event.type === "BOOKMARK") continue;
          if (!["ADDED", "MODIFIED"].includes(event.type))
            throw new Error("Maintenance watch lost its configuration");
          await observe(event.object);
        }
        // Normal server watch expiry renews from a fresh GET without reopening gates.
      } catch {
        control.setConnected(false);
        if (signal.aborted) break;
        onUnavailable(); // Never log token, ConfigMap contents, or API response bodies.
        try {
          await delay(retryMs, undefined, { signal });
        } catch {
          break;
        }
      }
    }
    control.setConnected(false);
  })();
  return {
    stop: async () => {
      abort.abort();
      await done;
    },
  };
}
