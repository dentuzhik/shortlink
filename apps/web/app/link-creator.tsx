"use client";

import { type FormEvent, useState } from "react";

const shortLinkOrigin =
  process.env.NEXT_PUBLIC_SHORT_LINK_ORIGIN ?? "http://127.0.0.1:3000";

const createLinkMutation = /* GraphQL */ `
  mutation CreateLink($input: CreateLinkInput!) {
    createLink(input: $input) {
      code
      targetUrl
    }
  }
`;

type Link = { code: string; targetUrl: string };
type MutationResponse = {
  data?: { createLink: Link } | null;
  errors?: { message: string }[];
};

export function LinkCreator() {
  const [targetUrl, setTargetUrl] = useState("");
  const [result, setResult] = useState<Link | null>(null);
  const [error, setError] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError("");
    setResult(null);
    setCopyFeedback("");

    try {
      const response = await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: createLinkMutation,
          variables: { input: { targetUrl: targetUrl.trim() } },
        }),
      });
      const body: MutationResponse = await response.json();
      if (!response.ok || body.errors?.length || !body.data?.createLink) {
        setError(
          body.errors?.[0]?.message ??
            "Could not create a short link. Try again.",
        );
        return;
      }

      setResult(body.data.createLink);
    } catch {
      setError(
        "Could not reach the link service. Check that it’s running and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  const shortUrl = result && new URL(`/${result.code}`, shortLinkOrigin).href;

  async function copyLink() {
    if (!shortUrl) return;
    try {
      await navigator.clipboard.writeText(shortUrl);
      setCopyFeedback("Copied to clipboard.");
    } catch {
      setCopyFeedback("Copy unavailable. Select the short link to copy it.");
    }
  }

  return (
    <section className="creator" aria-labelledby="creator-title">
      <h2 id="creator-title">Create a short link</h2>
      <form onSubmit={submit} aria-busy={pending}>
        <label htmlFor="target-url">Destination URL</label>
        <input
          id="target-url"
          name="targetUrl"
          type="url"
          placeholder="https://example.com/a-long-url"
          value={targetUrl}
          maxLength={2048}
          required
          spellCheck={false}
          onChange={(event) => setTargetUrl(event.target.value)}
        />
        <button className="primary" type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create link"}
          <span aria-hidden="true">↗</span>
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="result" aria-live="polite">
        <p className="eyebrow">YOUR SHORT LINK</p>
        {shortUrl && result ? (
          <>
            <div className="result-row">
              <a href={shortUrl} target="_blank" rel="noreferrer">
                {shortUrl}
              </a>
              <button className="copy" type="button" onClick={copyLink}>
                Copy link
              </button>
            </div>
            <p className="destination">Redirects to {result.targetUrl}</p>
            {copyFeedback && <p className="copy-feedback">{copyFeedback}</p>}
          </>
        ) : (
          <p className="result-placeholder">Your link will appear here.</p>
        )}
      </div>
    </section>
  );
}
