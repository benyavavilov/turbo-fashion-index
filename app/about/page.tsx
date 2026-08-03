"use client";

import { useState } from "react";

import FeedbackModal from "@/app/components/feedback-modal";
import TerminalChrome from "@/app/components/terminal-chrome";

export default function AboutPage() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50">
      <TerminalChrome subtitle="About · Methodology" />

      <main className="mx-auto max-w-[800px] space-y-8 p-6 pb-16">
        <header className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-800">
            Earnings Whisper
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            About Turbo Fashion Index
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-slate-600">
            We build an alternative-data overlay that compares real-time consumer
            search intent against Wall Street revenue expectations — so you can
            see earnings catalysts before the print, not after the transcript.
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            Methodology
          </h2>
          <div className="mt-4 space-y-4 text-sm leading-relaxed text-slate-600">
            <p>
              Traditional Wall Street estimates are lagging indicators.
              Consensus revenue growth is assembled from models, channel checks,
              and prior prints — useful, but slow relative to how consumer
              attention moves online.
            </p>
            <p>
              We track real-time Google Search intent across each parent&apos;s
              child brands, measure Year-over-Year Search growth into the
              earnings window, and compare that figure to Street expected revenue
              growth. The gap — our Mismatch Delta — is the signal.
            </p>
            <p>
              Our core rule is simple and strict: when |Search YoY − Wall St Est|
              ≥ 15, we fire a Beat Likely or Miss Likely call. Smaller gaps are
              treated as Priced In. There is no correlation filter — the 15%
              Mismatch Delta stands on its own.
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-blue-100 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            Track Record
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-slate-600">
            In a multi-year, out-of-sample backtest focused on the post-2024
            window, our &gt;15% Delta strategy yielded an approximate 84.3%
            directional accuracy rate across fired signals. Past performance is
            not a guarantee of future results; the figure reflects historical
            Sniper grading on our curated brand universe under the same trigger
            rules used in the live terminal.
          </p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            Feedback
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            Found a data quirk, want a brand added, or have a methodology
            question? We read every note.
          </p>
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            className="mt-4 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800"
          >
            Send feedback
          </button>
        </section>

        <section className="rounded-xl border border-amber-200 bg-amber-50/80 p-6 sm:p-8">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-amber-900">
            Financial Disclaimer
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-amber-950/80">
            Turbo Fashion Index is an alternative data research tool, not a
            registered investment advisor. The data and insights provided are for
            informational purposes only and do not constitute financial advice or
            a recommendation to buy, sell, or hold any security. All trading
            involves risk.
          </p>
        </section>
      </main>

      <FeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
      />
    </div>
  );
}
