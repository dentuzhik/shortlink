import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// HTTPS fixture for the real production GET/watch transport, not a mock of admission.
export async function maintenanceApi() {
  const directory = await mkdtemp(
    join(tmpdir(), "shortlink-maintenance-test-"),
  );
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    `${directory}/key.pem`,
    "-out",
    `${directory}/ca.crt`,
  ]);
  let token = randomUUID();
  await writeFile(`${directory}/token`, token, { mode: 0o600 });
  let available = false;
  let watchAvailable = true;
  let version = 1;
  let objectVersion = 1;
  let lastWatchVersion: string | null = null;
  let config: unknown = { revision: 1, creationMode: "accept" };
  const streams = new Set<ServerResponse>();
  const history: { version: number; document: ReturnType<typeof document> }[] =
    [];
  function document() {
    return {
      metadata: { resourceVersion: String(objectVersion) },
      data: { "control.json": JSON.stringify(config) },
    };
  }
  const server = createServer(
    {
      key: await readFile(`${directory}/key.pem`),
      cert: await readFile(`${directory}/ca.crt`),
    },
    (request, response) => {
      if (!available) {
        response.writeHead(503).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const url = new URL(request.url ?? "/", "https://localhost");
      if (url.searchParams.get("watch") === "true") {
        lastWatchVersion = url.searchParams.get("resourceVersion");
        if (!watchAvailable) {
          response.writeHead(503).end();
          return;
        }
        if (
          url.searchParams.get("fieldSelector") !==
          "metadata.name=shortlink-runtime"
        ) {
          response.writeHead(403).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.flushHeaders();
        streams.add(response);
        for (const entry of history.filter(
          (entry) =>
            entry.version > Number(url.searchParams.get("resourceVersion")),
        )) {
          response.write(
            `${JSON.stringify({ type: "MODIFIED", object: entry.document })}\n`,
          );
        }
        request.on("close", () => streams.delete(response));
      } else if (url.pathname.endsWith("/configmaps")) {
        if (
          url.searchParams.get("fieldSelector") !==
          "metadata.name=shortlink-runtime"
        ) {
          response.writeHead(403).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            metadata: { resourceVersion: String(version) },
            items: [document()],
          }),
        );
      } else {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(document()));
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture server address");
  return {
    endpoint: `https://127.0.0.1:${address.port}`,
    credentialsDirectory: directory,
    setAvailable(value: boolean) {
      available = value;
      if (!value) for (const stream of streams) stream.destroy();
    },
    setWatchAvailable(value: boolean) {
      watchAvailable = value;
    },
    update(value: unknown) {
      config = value;
      version++;
      objectVersion = version;
      const current = document();
      history.push({ version, document: current });
      for (const stream of streams)
        stream.write(
          `${JSON.stringify({ type: "MODIFIED", object: current })}\n`,
        );
    },
    async rotateToken() {
      token = randomUUID();
      await writeFile(`${directory}/token`, token, { mode: 0o600 });
    },
    advanceCollection() {
      version++;
    },
    lastWatchVersion() {
      return lastWatchVersion;
    },
    expireWatches() {
      for (const stream of streams) stream.end();
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
