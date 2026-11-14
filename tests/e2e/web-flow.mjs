import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function destinationServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      "<!doctype html><title>Test destination</title><h1>Shortlink test destination</h1>",
    );
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  };
}

export function observePage(page, appOrigin) {
  const errors = [];
  const relevant = (request) =>
    new URL(request.url()).origin === appOrigin &&
    ["document", "script", "stylesheet", "fetch", "xhr"].includes(
      request.resourceType(),
    );
  const onError = (error) =>
    errors.push({ type: "javascript", message: error.message });
  const onFailed = (request) => {
    if (relevant(request))
      errors.push({
        type: "network",
        url: request.url(),
        error: request.failure()?.errorText,
      });
  };
  const onResponse = (response) => {
    if (relevant(response.request()) && response.status() >= 400)
      errors.push({
        type: "http",
        url: response.url(),
        status: response.status(),
      });
  };
  page.on("pageerror", onError);
  page.on("requestfailed", onFailed);
  page.on("response", onResponse);
  return {
    errors,
    dispose() {
      page.off("pageerror", onError);
      page.off("requestfailed", onFailed);
      page.off("response", onResponse);
    },
  };
}

export async function openCreator(page, baseUrl) {
  const response = await page.goto(baseUrl, { waitUntil: "load" });
  assert.equal(response?.status(), 200, "UI document must load successfully");
  await page
    .getByRole("button", { name: "Create link", exact: true })
    .waitFor({ state: "visible" });
}

export async function createAndFollow(page, appOrigin, shortOrigin, targetUrl) {
  await page.getByLabel("Destination URL", { exact: true }).fill(targetUrl);
  const received = page.waitForResponse(
    (response) =>
      response.url() === `${appOrigin}/graphql` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  const response = await received;
  assert.equal(response.status(), 200, "GraphQL HTTP request must succeed");
  const body = await response.json();
  assert.equal(body.errors, undefined, "GraphQL must return no errors");
  const link = body.data?.createLink;
  assert.equal(link?.targetUrl, targetUrl);
  assert.match(link?.code ?? "", /^[A-Za-z0-9_-]{8}$/);
  const shortUrl = new URL(`/${link.code}`, shortOrigin).href;
  const anchor = page.getByRole("link", { name: shortUrl, exact: true });
  await anchor.waitFor({ state: "visible" });
  assert.equal(await anchor.getAttribute("href"), shortUrl);
  assert.equal(
    await page
      .getByRole("region", { name: "Create a short link", exact: true })
      .getByRole("alert")
      .count(),
    0,
  );

  // Chromium resolves *.localhost itself; the Node HTTP client needs loopback.
  const httpUrl = new URL(shortUrl);
  if (httpUrl.hostname.endsWith(".localhost")) httpUrl.hostname = "127.0.0.1";
  const redirect = await page.context().request.get(httpUrl.href, {
    headers: { Host: new URL(shortUrl).host },
    maxRedirects: 0,
  });
  assert.equal(redirect.status(), 302);
  assert.equal(redirect.headers().location, targetUrl);
  assert.equal(redirect.headers()["cache-control"], "no-store");
  await redirect.dispose();

  const opened = page.waitForEvent("popup");
  await anchor.click();
  const popup = await opened;
  try {
    await popup.waitForURL(targetUrl, { waitUntil: "load" });
    await popup
      .getByRole("heading", { name: "Shortlink test destination", exact: true })
      .waitFor({ state: "visible" });
  } finally {
    await popup.close();
  }
  return { shortUrl, targetUrl, code: link.code };
}
