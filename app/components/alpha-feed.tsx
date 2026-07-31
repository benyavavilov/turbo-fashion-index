"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Loader2,
  Radar,
  Shield,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import type { AlphaFeedCard, EarningsMismatch } from "@/lib/ai-insights";
import {
  formatExpectedRevenueGrowth,
  formatSearchGrowthPct,
  mismatchToAlertBadge,
} from "@/lib/ai-insights";

function alertAccent(mismatch: EarningsMismatch) {
  if (mismatch === "BEAT_LIKELY") {
    return {
      card: "border-emerald-500/40 bg-gradient-to-b from-emerald-500/15 via-neutral-950 to-neutral-950 hover:border-emerald-400/60",
      badge:
        "border-emerald-400/50 bg-emerald-500/20 text-emerald-200 shadow-[0_0_20px_rgba(16,185,129,0.18)]",
      iconWrap: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
      delta: "border-emerald-500/20 bg-emerald-500/[0.06]",
      Icon: TrendingUp,
    };
  }
  if (mismatch === "MISS_LIKELY") {
    return {
      card: "border-rose-500/40 bg-gradient-to-b from-rose-500/15 via-neutral-950 to-neutral-950 hover:border-rose-400/60",
      badge:
        "border-rose-400/50 bg-rose-500/20 text-rose-200 shadow-[0_0_20px_rgba(244,63,94,0.18)]",
      iconWrap: "bg-rose-500/15 text-rose-300 ring-rose-500/40",
      delta: "border-rose-500/20 bg-rose-500/[0.06]",
      Icon: TrendingDown,
    };
  }
  return {
    card: "border-sky-500/30 bg-gradient-to-b from-sky-500/10 via-neutral-950 to-neutral-950 hover:border-sky-400/50",
    badge:
      "border-sky-400/40 bg-sky-500/15 text-sky-200 shadow-[0_0_16px_rgba(56,189,248,0.12)]",
    iconWrap: "bg-sky-500/15 text-sky-300 ring-sky-500/35",
    delta: "border-sky-500/15 bg-sky-500/[0.05]",
    Icon: Shield,
  };
}

function EarningsAlertCard({ card }: { card: AlphaFeedCard }) {
  const accent = alertAccent(card.earningsMismatch);
  const Icon = accent.Icon;

  return (
    <Link
      href={`/company/${encodeURIComponent(card.ticker)}`}
      className={`group flex min-h-[300px] flex-col rounded-xl border p-5 shadow-lg transition ${accent.card}`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset ${accent.iconWrap}`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
            Earnings Alert
          </p>
        </div>
        <ArrowUpRight className="h-4 w-4 text-neutral-600 transition group-hover:text-neutral-300" />
      </div>

      <p className="text-lg font-semibold text-neutral-50">
        {card.parentName}{" "}
        <span className="font-mono text-sm font-medium text-indigo-300">
          ${card.ticker}
        </span>
      </p>

      {card.brand && card.brand !== card.parentName && (
        <p className="mt-1 text-[11px] text-neutral-500">
          Child signals:{" "}
          <span className="text-neutral-400">{card.brand}</span>
        </p>
      )}

      <div className="mt-4">
        <span
          className={`inline-flex rounded-md border px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] ${accent.badge}`}
        >
          {mismatchToAlertBadge(card.earningsMismatch)}
        </span>
      </div>

      {/* Mismatch delta — two-column institutional metric */}
      <div
        className={`mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border ${accent.delta}`}
      >
        <div className="bg-neutral-950/80 px-3 py-3">
          <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
            Wall Street Est
          </p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-neutral-100">
            {formatExpectedRevenueGrowth(card.expectedRevenueGrowth)}
          </p>
        </div>
        <div className="bg-neutral-950/80 px-3 py-3">
          <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
            Search Growth
          </p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-neutral-100">
            {formatSearchGrowthPct(card.momentumPct)}
          </p>
        </div>
      </div>

      <p className="mt-4 text-sm font-medium leading-snug text-neutral-200">
        {card.heroText}
      </p>

      <p className="mt-auto pt-4 text-[10px] uppercase tracking-wider text-neutral-600">
        Earnings Whisper · open terminal →
      </p>
    </Link>
  );
}

export default function AlphaFeed() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<AlphaFeedCard[]>([]);
  const [meta, setMeta] = useState<{
    scannedParents: number;
    scannedBrands: number;
    generatedAt: string;
  } | null>(null);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/alpha-feed", { method: "POST" });
      const data = (await res.json()) as {
        cards?: AlphaFeedCard[];
        scannedParents?: number;
        scannedBrands?: number;
        generatedAt?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Alpha feed failed (${res.status})`);
      }
      setCards(data.cards ?? []);
      setMeta({
        scannedParents: data.scannedParents ?? 0,
        scannedBrands: data.scannedBrands ?? 0,
        generatedAt: data.generatedAt ?? new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Alpha feed failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  return (
    <section className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-neutral-800/80 bg-gradient-to-br from-neutral-900 via-neutral-950 to-indigo-950/40 p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(99,102,241,0.18),transparent_55%)]" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-300/80">
              Earnings Whisper Terminal
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
              Top Earnings Alerts
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-neutral-400">
              Search growth vs Wall Street revenue estimates. Cards flag{" "}
              <span className="text-emerald-400/90">Beat Projected</span>,{" "}
              <span className="text-rose-400/90">Miss Projected</span>, or{" "}
              <span className="text-sky-400/90">Priced In</span> — the mismatch
              delta, not price direction.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void runScan()}
            disabled={loading}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-indigo-400/40 bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-[0_0_28px_rgba(99,102,241,0.28)] transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Activity className="h-4 w-4" />
            )}
            {loading ? "Loading cache…" : "Refresh Feed"}
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}

      {!loading && meta && cards.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 px-6 py-16 text-center">
          <Radar className="mb-3 h-9 w-9 text-neutral-600" />
          <p className="max-w-md text-sm text-neutral-400">
            No cached insights yet. Run{" "}
            <code className="text-indigo-300">npm run generate:insights</code>{" "}
            after trend ingestion, then refresh.
          </p>
          <button
            type="button"
            onClick={() => void runScan()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-white"
          >
            <Activity className="h-4 w-4" />
            Retry
          </button>
        </div>
      )}

      {!meta && !loading && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 px-6 py-16 text-center">
          <Radar className="mb-3 h-9 w-9 text-neutral-600" />
          <p className="max-w-md text-sm text-neutral-400">
            Alpha Feed hasn&apos;t loaded yet.
          </p>
          <button
            type="button"
            onClick={() => void runScan()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-white"
          >
            <Activity className="h-4 w-4" />
            Retry
          </button>
        </div>
      )}

      {loading && cards.length === 0 && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-neutral-800 bg-neutral-950/40 px-6 py-16 text-sm text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
          Loading earnings alerts…
        </div>
      )}

      {cards.length > 0 && (
        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <EarningsAlertCard
                key={`${card.ticker}-${card.earningsMismatch}`}
                card={card}
              />
            ))}
          </div>
          {meta && (
            <p className="text-right text-[10px] text-neutral-600">
              {cards.length} alerts · {meta.scannedParents} parents ·{" "}
              {meta.scannedBrands} brands · cached{" "}
              {new Date(meta.generatedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
