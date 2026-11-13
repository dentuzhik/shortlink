// Called by the server page after connection(), once a request arrives.
export function shortLinkOrigin(
  value = process.env.SHORT_LINK_ORIGIN ?? "http://127.0.0.1:3000",
): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SHORT_LINK_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment",
    );
  }
  return url.origin;
}
