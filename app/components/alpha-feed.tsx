"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Radar } from "lucide-react";

import type { AlphaFeedCard, EarningsMismatch } from "@/lib/ai-insights";
import {
  formatExpectedRevenueGrowth,
  formatSearchGrowthPct,
  normalizeNextEarningsDate,
} from "@/lib/ai-insights";
import { formatVerdictText } from "@/app/components/format-verdict-text";

function parsePct(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(String(value).replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** True when the card has no usable sniper sample (N/A, —, or 0 signals). */
function hasNoAccuracySignals(card: AlphaFeedCard): boolean {
  const label = (card.historicalAccuracyLabel ?? "").trim();
  if (card.historicalAccuracyPct == null) return true;
  if (!label || label === "—" || label === "-" || /^n\/?a$/i.test(label)) {
    return true;
  }
  const slash = label.match(/^(\d+)\s*\/\s*(\d+)/);
  if (slash && Number(slash[2]) === 0) return true;
  return false;
}

/** Accuracy % desc, then ticker A→Z; unscored / 0-signal cards sink to bottom. */
function sortFeedByHistoricalAccuracy(
  cards: AlphaFeedCard[]
): AlphaFeedCard[] {
  return [...cards].sort((a, b) => {
    const aBottom = hasNoAccuracySignals(a);
    const bBottom = hasNoAccuracySignals(b);
    if (aBottom !== bBottom) return aBottom ? 1 : -1;
    if (!aBottom && !bBottom) {
      const ap = a.historicalAccuracyPct ?? -1;
      const bp = b.historicalAccuracyPct ?? -1;
      if (bp !== ap) return bp - ap;
    }
    return a.ticker.localeCompare(b.ticker);
  });
}

/** Closest upcoming earnings (≥ today UTC), max 3. Drops stale Yahoo rollovers. */
function selectUpcomingEarnings(cards: AlphaFeedCard[]): AlphaFeedCard[] {
  const today = new Date().toISOString().split("T")[0];
  return cards
    .filter((c) => {
      const nextEarningsDate = normalizeNextEarningsDate(c.nextEarningsDate);
      return Boolean(nextEarningsDate && nextEarningsDate >= today);
    })
    .sort((a, b) => {
      const da = normalizeNextEarningsDate(a.nextEarningsDate) ?? "";
      const db = normalizeNextEarningsDate(b.nextEarningsDate) ?? "";
      if (da !== db) return da.localeCompare(db);
      return a.ticker.localeCompare(b.ticker);
    })
    .slice(0, 3);
}

function formatSignedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function mismatchTone(m: EarningsMismatch) {
  if (m === "BEAT_LIKELY") return "text-green-700 bg-green-50 border-green-200";
  if (m === "MISS_LIKELY") return "text-red-700 bg-red-50 border-red-200";
  return "text-amber-700 bg-amber-50 border-amber-200";
}

function mismatchLabel(m: EarningsMismatch) {
  if (m === "BEAT_LIKELY") return "Beat Likely";
  if (m === "MISS_LIKELY") return "Miss Likely";
  return "Priced In";
}

function PredictionBadge({
  mismatch,
  className = "",
}: {
  mismatch: EarningsMismatch;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[10px] font-bold tracking-wide ${mismatchTone(mismatch)} ${className}`}
    >
      {mismatchLabel(mismatch)}
    </span>
  );
}

function cardDelta(card: AlphaFeedCard): number | null {
  const streetPct = parsePct(card.expectedRevenueGrowth);
  const searchPct = card.momentumPct;
  if (searchPct == null || streetPct == null) return null;
  return searchPct - streetPct;
}

function UpcomingEarningsCatalysts({ cards }: { cards: AlphaFeedCard[] }) {
  if (cards.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-xl border border-blue-100 bg-white shadow-sm">
      <div className="border-b border-blue-50 px-5 py-4">
        <h2 className="text-base font-semibold tracking-tight text-slate-900">
          Upcoming Catalysts
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Next three prints on the calendar · closest first
        </p>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-[10px] uppercase tracking-[0.12em] text-slate-500">
              <th className="px-5 py-2.5 font-semibold">Ticker</th>
              <th className="px-3 py-2.5 font-semibold">Earnings Date</th>
              <th className="px-3 py-2.5 font-semibold">Wall St Est</th>
              <th className="px-3 py-2.5 font-semibold">Search YoY</th>
              <th className="px-3 py-2.5 font-semibold">Delta</th>
              <th className="px-3 py-2.5 font-semibold">Prediction</th>
              <th className="px-5 py-2.5 font-semibold">Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => {
              const delta = cardDelta(card);
              return (
                <tr
                  key={`upcoming-${card.ticker}`}
                  className="border-b border-slate-50 last:border-0 hover:bg-slate-50/80"
                >
                  <td className="px-5 py-3">
                    <Link
                      href={`/company/${encodeURIComponent(card.ticker)}`}
                      className="font-mono text-base font-semibold text-blue-800 hover:underline"
                    >
                      ${card.ticker}
                    </Link>
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums text-slate-800">
                    {normalizeNextEarningsDate(card.nextEarningsDate) ?? "—"}
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums text-slate-800">
                    {formatExpectedRevenueGrowth(card.expectedRevenueGrowth)}
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums text-slate-800">
                    {formatSearchGrowthPct(card.momentumPct)}
                  </td>
                  <td
                    className={`px-3 py-3 font-mono font-semibold tabular-nums ${
                      delta == null
                        ? "text-slate-400"
                        : delta >= 15
                          ? "text-green-600"
                          : delta <= -15
                            ? "text-red-600"
                            : "text-amber-600"
                    }`}
                  >
                    {delta != null ? formatSignedPct(delta) : "—"}
                  </td>
                  <td className="px-3 py-3">
                    <PredictionBadge mismatch={card.earningsMismatch} />
                  </td>
                  <td className="px-5 py-3 font-mono text-sm font-semibold tabular-nums text-slate-900">
                    {card.historicalAccuracyPct != null
                      ? `${card.historicalAccuracyPct}%`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile mini-cards */}
      <div className="grid gap-3 p-4 md:hidden">
        {cards.map((card) => {
          const delta = cardDelta(card);
          return (
            <Link
              key={`upcoming-m-${card.ticker}`}
              href={`/company/${encodeURIComponent(card.ticker)}`}
              className="rounded-lg border border-slate-200 bg-slate-50/80 p-4 transition hover:border-blue-300"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-lg font-semibold text-slate-900">
                  ${card.ticker}
                </p>
                <PredictionBadge mismatch={card.earningsMismatch} />
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Earnings{" "}
                <span className="font-mono font-semibold text-slate-800">
                  {normalizeNextEarningsDate(card.nextEarningsDate) ?? "—"}
                </span>
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-[9px] uppercase text-slate-500">Street</p>
                  <p className="font-mono text-xs font-semibold">
                    {formatExpectedRevenueGrowth(card.expectedRevenueGrowth)}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] uppercase text-slate-500">Search</p>
                  <p className="font-mono text-xs font-semibold">
                    {formatSearchGrowthPct(card.momentumPct)}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] uppercase text-slate-500">Delta</p>
                  <p className="font-mono text-xs font-semibold">
                    {delta != null ? formatSignedPct(delta) : "—"}
                  </p>
                </div>
              </div>
              <p className="mt-3 font-mono text-xs font-bold text-slate-900">
                Historical Accuracy:{" "}
                {card.historicalAccuracyPct != null
                  ? `${card.historicalAccuracyPct}%`
                  : "—"}
              </p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function EarningsAlertCard({ card }: { card: AlphaFeedCard }) {
  const street = formatExpectedRevenueGrowth(card.expectedRevenueGrowth);
  const search = formatSearchGrowthPct(card.momentumPct);
  const delta = cardDelta(card);

  return (
    <Link
      href={`/company/${encodeURIComponent(card.ticker)}`}
      className="flex min-h-[220px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-blue-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <p className="font-mono text-xl font-semibold tracking-tight text-slate-900">
          ${card.ticker}
        </p>
        <PredictionBadge mismatch={card.earningsMismatch} />
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Delta · Wall St Est vs Search Hype
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-2 text-center">
              <p className="text-[9px] uppercase tracking-wide text-slate-500">
                Street
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold text-slate-900">
                {street}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-2 text-center">
              <p className="text-[9px] uppercase tracking-wide text-slate-500">
                Search
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold text-slate-900">
                {search}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-2 text-center">
              <p className="text-[9px] uppercase tracking-wide text-slate-500">
                Gap
              </p>
              <p
                className={`mt-0.5 font-mono text-sm font-semibold ${
                  delta == null
                    ? "text-slate-400"
                    : delta >= 15
                      ? "text-green-600"
                      : delta <= -15
                        ? "text-red-600"
                        : "text-amber-600"
                }`}
              >
                {delta != null ? formatSignedPct(delta) : "—"}
              </p>
            </div>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-slate-600">
          {formatVerdictText(card.heroText)}
        </p>
      </div>

      <div className="mt-auto border-t border-blue-100 bg-blue-50/70 px-5 py-3.5">
        <p className="font-mono text-base font-bold tabular-nums tracking-tight text-slate-900">
          {card.historicalAccuracyPct != null
            ? `Historical Accuracy: ${card.historicalAccuracyPct}%`
            : "Historical Accuracy: —"}
        </p>
      </div>
    </Link>
  );
}

export default function AlphaFeed() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<AlphaFeedCard[]>([]);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/alpha-feed", { method: "POST" });
      const data = (await res.json()) as {
        cards?: AlphaFeedCard[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Alpha feed failed (${res.status})`);
      }
      setCards(data.cards ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Alpha feed failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const sortedCards = useMemo(
    () => sortFeedByHistoricalAccuracy(cards),
    [cards]
  );
  const upcoming = useMemo(() => selectUpcomingEarnings(cards), [cards]);

  return (
    <section className="space-y-6">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {!loading && upcoming.length > 0 && (
        <UpcomingEarningsCatalysts cards={upcoming} />
      )}

      {!loading && sortedCards.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-16 text-center">
          <Radar className="mb-3 h-9 w-9 text-slate-400" />
          <p className="max-w-md text-sm text-slate-600">
            No cached insights yet. Run{" "}
            <code className="text-blue-700">npm run generate:insights</code>{" "}
            after trend ingestion.
          </p>
        </div>
      )}

      {loading && sortedCards.length === 0 && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-6 py-16 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-blue-700" />
          Loading earnings alerts…
        </div>
      )}

      {sortedCards.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sortedCards.map((card) => (
            <EarningsAlertCard
              key={`${card.ticker}-${card.earningsMismatch}`}
              card={card}
            />
          ))}
        </div>
      )}
    </section>
  );
}
