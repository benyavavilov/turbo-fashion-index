"use client";

import { useState } from "react";
import { Loader2, Mail } from "lucide-react";

export default function NewsletterCta() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || submitting) return;

    setSubmitting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        alreadySubscribed?: boolean;
      };

      if (!res.ok) {
        throw new Error(data.error ?? `Subscribe failed (${res.status})`);
      }

      setSuccessMessage(data.message ?? "Welcome to the list!");
      if (!data.alreadySubscribed) setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Subscribe failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-blue-200 bg-gradient-to-br from-blue-700 via-blue-800 to-slate-900 px-6 py-10 text-white shadow-sm sm:px-10 sm:py-12">
      <div className="mx-auto max-w-2xl text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-white/10 ring-1 ring-inset ring-white/20">
          <Mail className="h-5 w-5 text-blue-100" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Get the Edge.
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-blue-100/90 sm:text-base">
          Join our free weekly newsletter. Every Monday before the market opens,
          we email you the top &apos;Earnings Whisper&apos; mismatch identified
          by our alternative data terminal.
        </p>

        {successMessage ? (
          <p className="mt-8 rounded-lg border border-white/20 bg-white/10 px-4 py-3 text-sm font-medium text-white">
            {successMessage}
          </p>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-stretch"
          >
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={submitting}
              className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none ring-blue-300/40 focus:ring-2 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-semibold text-blue-800 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Subscribing...
                </>
              ) : (
                "Subscribe"
              )}
            </button>
          </form>
        )}

        {error && (
          <p className="mt-3 text-sm text-amber-200">{error}</p>
        )}
      </div>
    </section>
  );
}
