import { connection } from "next/server";
import { shortLinkOrigin } from "../lib/runtime-config";
import { LinkCreator } from "./link-creator";

export default async function Page() {
  // Keep deployment configuration out of the build-time prerender.
  await connection();
  const origin = shortLinkOrigin();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand-mark" aria-hidden="true">
          ↗
        </span>
        <span className="brand-name">Shortlink</span>
      </header>

      <main className="workspace">
        <div className="intro">
          <p className="eyebrow">URL SHORTENER</p>
          <h1>
            Long URL.
            <br />
            Short link.
          </h1>
          <p className="intro-text">
            Turn a destination URL into a short link you can copy and share.
          </p>
        </div>
        <LinkCreator shortLinkOrigin={origin} />
      </main>
    </div>
  );
}
