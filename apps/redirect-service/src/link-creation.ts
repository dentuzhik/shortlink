import { randomBytes } from "node:crypto";
import type { createLinkStore } from "@url-shortener/db/links";

export const maxTargetUrlLength = 2048;
const maxCodeAttempts = 3;

type LinkStore = Pick<ReturnType<typeof createLinkStore>, "insert">;

function parseTargetUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    (value.length > maxTargetUrlLength &&
      [...value].length > maxTargetUrlLength) ||
    !/^https?:\/\//i.test(value)
  ) {
    return null;
  }

  const url = URL.parse(value);
  if (!url || url.username || url.password) return null;

  return url.href;
}

function generateLinkCode(): string {
  // Six random bytes encode to eight URL-safe characters.
  return randomBytes(6).toString("base64url");
}

export function createLinkCreator(
  store: LinkStore,
  generateCode = generateLinkCode,
) {
  return async (value: unknown) => {
    const targetUrl = parseTargetUrl(value);
    if (!targetUrl) {
      return {
        status: "invalid-url",
        message: `Enter an absolute HTTP or HTTPS URL without credentials (up to ${maxTargetUrlLength} characters).`,
      } as const;
    }

    for (let attempt = 0; attempt < maxCodeAttempts; attempt++) {
      const link = await store.insert(generateCode(), targetUrl);
      if (link) {
        return {
          status: "created",
          link: { ...link, createdAt: link.createdAt.toISOString() },
        } as const;
      }
    }

    return {
      status: "codes-exhausted",
      message: "Could not allocate a short code; try again",
    } as const;
  };
}

export type CreateLink = ReturnType<typeof createLinkCreator>;
