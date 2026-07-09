"use client";

import { useState } from "react";
import { FlaskConical, Info, X } from "lucide-react";

import type { EventStudyResult } from "@/lib/event-study";

export default function QuantitativeTools({
  eventStudyEnabled,
  eventStudyBrand,
  onRunEventStudy,
}: {
  eventStudyEnabled: boolean;
  eventStudyBrand: string | null;
  onRunEventStudy: () => EventStudyResult;
}) {
  const [explainTradability, setExplainTradability] = useState(false);
  const [results, setResults] = useState<EventStudyResult | null>(null);

  const handleRunEventStudy = () => {
    if (!eventStudyEnabled) return;
    setResults(onRunEventStudy());
  };

  return (
    <>
      <div className="mb-4 rounded-lg border border-neutral-800/80 bg-neutral-950/40 p-4">
        <div className="mb-3 flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-indigo-400" />
          <h3 className="text-sm font-semibold tracking-tight text-neutral-100">
            Quantitative Tools
          </h3>
        </div>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex-1 space-y-3">
            <label className="flex cursor-pointer items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={explainTradability}
                onClick={() => setExplainTradability((v) => !v)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  explainTradability ? "bg-indigo-600" : "bg-neutral-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    explainTradability ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
              <span className="text-sm text-neutral-300">
                Explain Tradability Score
              </span>
            </label>

            {explainTradability && (
              <div className="flex gap-2.5 rounded-lg border border-indigo-500/25 bg-indigo-500/10 px-3.5 py-3 text-sm leading-relaxed text-indigo-100/90">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
                <p>
                  Pearson Correlation measures the relationship between search
                  hype and stock price. A low same-day correlation often means
                  Wall Street is slow to react to cultural hype—highlighting a
                  delayed investment opportunity.
                </p>
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            <button
              type="button"
              onClick={handleRunEventStudy}
              disabled={!eventStudyEnabled}
              title={
                eventStudyEnabled
                  ? `Run backtest on ${eventStudyBrand}`
                  : "Select exactly one brand with stock overlay enabled"
              }
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              Run Event Study (90-Day Hold)
            </button>
            {!eventStudyEnabled && (
              <p className="max-w-xs text-right text-[11px] text-neutral-600">
                Requires one brand with stock overlay active
              </p>
            )}
          </div>
        </div>
      </div>

      {results && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setResults(null)}
            aria-label="Close event study results"
          />
          <div
            role="dialog"
            aria-modal
            aria-labelledby="event-study-title"
            className="relative w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3
                  id="event-study-title"
                  className="text-base font-semibold text-neutral-100"
                >
                  Event Study Results
                </h3>
                {eventStudyBrand && (
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {eventStudyBrand} · 90-day hold
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setResults(null)}
                className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm leading-relaxed text-neutral-300">
              Identified{" "}
              <span className="font-semibold text-neutral-100">
                {results.eventCount}
              </span>{" "}
              major hype spike{results.eventCount === 1 ? "" : "s"}. Average
              90-day post-spike stock return:{" "}
              <span
                className={`font-mono font-semibold ${
                  results.averageReturnPct >= 0
                    ? "text-emerald-400"
                    : "text-rose-400"
                }`}
              >
                {results.averageReturnPct >= 0 ? "+" : ""}
                {results.averageReturnPct.toFixed(1)}%
              </span>
              .
            </p>

            {results.events.length > 0 && (
              <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto border-t border-neutral-800 pt-3">
                {results.events.map((event) => (
                  <li
                    key={event.date}
                    className="flex items-center justify-between text-xs text-neutral-400"
                  >
                    <span className="font-mono text-neutral-500">
                      {event.date}
                    </span>
                    <span
                      className={`font-mono font-medium ${
                        event.returnPct >= 0
                          ? "text-emerald-400/90"
                          : "text-rose-400/90"
                      }`}
                    >
                      {event.returnPct >= 0 ? "+" : ""}
                      {event.returnPct.toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setResults(null)}
                className="rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
