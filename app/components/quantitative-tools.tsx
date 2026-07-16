"use client";

import { useState } from "react";
import { FlaskConical, Info, Loader2, X } from "lucide-react";

import type {
  EventStudyEvent,
  EventStudyResult,
  SpikeSentimentLabel,
} from "@/lib/event-study";
import {
  DEFAULT_SPIKE_THRESHOLD,
  MAX_SPIKE_THRESHOLD,
  MIN_SPIKE_THRESHOLD,
} from "@/lib/event-study";

function formatReturn(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function sentimentBadgeClass(sentiment: SpikeSentimentLabel): string {
  if (sentiment === "POSITIVE") {
    return "border-emerald-500/35 bg-emerald-500/15 text-emerald-300";
  }
  if (sentiment === "NEGATIVE") {
    return "border-rose-500/35 bg-rose-500/15 text-rose-300";
  }
  return "border-neutral-600/50 bg-neutral-800/70 text-neutral-400";
}

function EventList({
  title,
  subtitle,
  events,
  emptyLabel,
}: {
  title: string;
  subtitle: string;
  events: EventStudyEvent[];
  emptyLabel: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="mb-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-300">
          {title}
        </p>
        <p className="mt-0.5 text-[11px] text-neutral-500">{subtitle}</p>
      </div>

      {events.length === 0 ? (
        <p className="text-xs text-neutral-600">{emptyLabel}</p>
      ) : (
        <ul className="max-h-44 space-y-3 overflow-y-auto">
          {events.map((event) => (
            <li key={event.date} className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px] text-neutral-500">
                  {event.date}
                </span>
                <div className="flex items-center gap-2">
                  {event.sentiment && (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${sentimentBadgeClass(event.sentiment)}`}
                    >
                      {event.sentiment}
                    </span>
                  )}
                  <span
                    className={`font-mono text-xs font-medium ${
                      event.returnPct >= 0
                        ? "text-emerald-400/90"
                        : "text-rose-400/90"
                    }`}
                  >
                    {formatReturn(event.returnPct)}
                  </span>
                </div>
              </div>
              {event.reason && (
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  {event.reason}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function QuantitativeTools({
  eventStudyEnabled,
  eventStudyBrand,
  onRunEventStudy,
}: {
  eventStudyEnabled: boolean;
  eventStudyBrand: string | null;
  onRunEventStudy: (spikeThreshold: number) => Promise<EventStudyResult>;
}) {
  const [explainTradability, setExplainTradability] = useState(false);
  const [spikeThreshold, setSpikeThreshold] = useState(DEFAULT_SPIKE_THRESHOLD);
  const [results, setResults] = useState<EventStudyResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const handleRunEventStudy = async () => {
    if (!eventStudyEnabled || running) return;
    setRunning(true);
    setRunError(null);
    try {
      const next = await onRunEventStudy(spikeThreshold);
      setResults(next);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Event study failed.";
      setRunError(message);
    } finally {
      setRunning(false);
    }
  };

  const positiveEvents =
    results?.events.filter((e) => e.sentiment === "POSITIVE") ?? [];
  const negativeEvents =
    results?.events.filter((e) => e.sentiment === "NEGATIVE") ?? [];
  const neutralEvents =
    results?.events.filter(
      (e) => e.sentiment === "NEUTRAL" || e.sentiment == null
    ) ?? [];

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

          <div className="flex w-full shrink-0 flex-col items-stretch gap-3 sm:max-w-sm sm:items-end">
            <div className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label
                  htmlFor="spike-sensitivity"
                  className="text-xs font-medium text-neutral-300"
                >
                  Spike Sensitivity Threshold
                </label>
                <span className="font-mono text-xs text-indigo-300">
                  {spikeThreshold} pts
                </span>
              </div>
              <input
                id="spike-sensitivity"
                type="range"
                min={MIN_SPIKE_THRESHOLD}
                max={MAX_SPIKE_THRESHOLD}
                step={1}
                value={spikeThreshold}
                onChange={(e) => setSpikeThreshold(Number(e.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-neutral-700 accent-indigo-500"
              />
              <div className="mt-1 flex justify-between text-[10px] text-neutral-600">
                <span>{MIN_SPIKE_THRESHOLD}</span>
                <span>{MAX_SPIKE_THRESHOLD}</span>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
                Lower for stable retail brands, higher for volatile hype brands.
              </p>
            </div>

            <button
              type="button"
              onClick={handleRunEventStudy}
              disabled={!eventStudyEnabled || running}
              title={
                eventStudyEnabled
                  ? `Run backtest on ${eventStudyBrand} (≥${spikeThreshold} pts)`
                  : "Select exactly one brand with stock overlay enabled"
              }
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              {running && <Loader2 className="h-4 w-4 animate-spin" />}
              {running
                ? "Analyzing catalysts…"
                : "Run Event Study (90-Day Hold)"}
            </button>
            {!eventStudyEnabled && (
              <p className="max-w-xs text-right text-[11px] text-neutral-600">
                Requires one brand with stock overlay active
              </p>
            )}
            {runError && (
              <p className="max-w-xs text-right text-[11px] text-rose-400">
                {runError}
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
            className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
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
                    {eventStudyBrand} · 90-day hold · Long / Short by catalyst
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

            <p className="mb-4 text-sm leading-relaxed text-neutral-300">
              Identified{" "}
              <span className="font-semibold text-neutral-100">
                {results.eventCount}
              </span>{" "}
              major hype spike{results.eventCount === 1 ? "" : "s"}. Overall
              average 90-day post-spike stock return:{" "}
              <span
                className={`font-mono font-semibold ${
                  results.averageReturnPct >= 0
                    ? "text-emerald-400"
                    : "text-rose-400"
                }`}
              >
                {formatReturn(results.averageReturnPct)}
              </span>
              .
            </p>

            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/80">
                  Long · Positive Catalysts
                </p>
                <p className="mt-1 text-sm text-neutral-200">
                  {results.positiveEventCount} event
                  {results.positiveEventCount === 1 ? "" : "s"}
                </p>
                <p className="mt-0.5 font-mono text-lg font-semibold text-emerald-300">
                  {results.positiveAverageReturnPct != null
                    ? formatReturn(results.positiveAverageReturnPct)
                    : "—"}
                </p>
                <p className="text-[11px] text-neutral-500">
                  Avg 90-day return
                </p>
              </div>

              <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-400/80">
                  Short · Negative Catalysts
                </p>
                <p className="mt-1 text-sm text-neutral-200">
                  {results.negativeEventCount} event
                  {results.negativeEventCount === 1 ? "" : "s"}
                </p>
                <p className="mt-0.5 font-mono text-lg font-semibold text-rose-300">
                  {results.negativeAverageReturnPct != null
                    ? formatReturn(results.negativeAverageReturnPct)
                    : "—"}
                </p>
                <p className="text-[11px] text-neutral-500">
                  Avg 90-day return
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <EventList
                title="Positive Catalyst Events"
                subtitle="Long strategy candidates"
                events={positiveEvents}
                emptyLabel="No positive-catalyst spikes identified."
              />
              <EventList
                title="Negative Catalyst Events"
                subtitle="Short strategy candidates"
                events={negativeEvents}
                emptyLabel="No negative-catalyst spikes identified."
              />
              {neutralEvents.length > 0 && (
                <EventList
                  title="Neutral / Uncertain"
                  subtitle="Catalyst unclear from historical knowledge"
                  events={neutralEvents}
                  emptyLabel=""
                />
              )}
            </div>

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
