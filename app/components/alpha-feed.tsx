"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Loader2,
  Radar,
  TrendingDown,
  TrendingUp,
  Eye,
} from "lucide-react";

import type { AlphaFeedCard } from "@/lib/alpha-feed";
import { isBearishVerdict, isBullishVerdict } from "@/lib/paper-portfolio";

function kindAccent(kind: AlphaFeedCard["kind"]) {
  if (kind === "TOP BUY") {
    return {
      card: "border-emerald-500/30 bg-gradient-to-b from-emerald-500/12 via-neutral-950 to-neutral-950 hover:border-emerald-400/50",
      badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
      Icon: TrendingUp,
    };
  }
  if (kind === "TOP SHORT") {
    return {
      card: "border-rose-500/30 bg-gradient-to-b from-rose-500/12 via-neutral-950 to-neutral-950 hover:border-rose-400/50",
      badge: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
      Icon: TrendingDown,
    };
  }
  return {
    card: "border-amber-500/25 bg-gradient-to-b from-amber-500/10 via-neutral-950 to-neutral-950 hover:border-amber-400/40",
    badge: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    Icon: Eye,
  };
}

function verdictBadgeClass(verdict: string): string {
  if (isBearishVerdict(verdict)) {
    return "border-rose-500/40 bg-rose-500/20 text-rose-200";
  }
  if (isBullishVerdict(verdict)) {
    return "border-emerald-500/40 bg-emerald-500/20 text-emerald-200";
  }
  return "border-neutral-600/50 bg-neutral-800/70 text-neutral-300";
}

function AlphaCard({ card }: { card: AlphaFeedCard }) {
  const accent = kindAccent(card.kind);
  const Icon = accent.Icon;

  return (
    <Link
      href={`/company/${encodeURIComponent(card.ticker)}`}
      className={`group flex min-h-[220px] flex-col rounded-xl border p-5 shadow-lg transition ${accent.card}`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset ${accent.badge}`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
              {card.kind}
            </p>
            <h3 className="text-sm font-semibold text-neutral-100">
              {card.parentName}
            </h3>
          </div>
        </div>
        <ArrowUpRight className="h-4 w-4 text-neutral-600 transition group-hover:text-neutral-300" />
      </div>

      <p className="text-lg font-semibold text-neutral-50">
        {card.brand}{" "}
        <span className="font-mono text-sm font-medium text-indigo-300">
          ${card.ticker}
        </span>
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide ${verdictBadgeClass(card.verdict)}`}
        >
          {card.verdict}
        </span>
        <span className="rounded-md border border-neutral-700/80 bg-neutral-900/80 px-2 py-1 font-mono text-[11px] text-neutral-300">
          {card.dataPoint}
        </span>
      </div>

      <ul className="mt-3 space-y-1.5 text-xs leading-snug text-neutral-400">
        {card.bullets.map((bullet, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-500" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>

      <p className="mt-auto pt-4 text-[10px] uppercase tracking-wider text-neutral-600">
        {card.eventCount} event-study catalyst
        {card.eventCount === 1 ? "" : "s"} · open terminal →
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
              Discovery Dashboard
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-neutral-50 sm:text-4xl">
              Alpha Feed
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-neutral-400">
              Event-study ranks across parent companies and child brands.
              Click any card to open that parent&apos;s intelligence
              terminal — stock overlay, brand toggles, and Gemini catalysts.
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
            {loading ? "Scanning parents…" : "Refresh Alpha Feed"}
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}

      {!meta && !loading && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 px-6 py-16 text-center">
          <Radar className="mb-3 h-9 w-9 text-neutral-600" />
          <p className="max-w-md text-sm text-neutral-400">
            No alpha cards yet. Refresh the feed after Supabase trend data is
            available for child brands.
          </p>
          <button
            type="button"
            onClick={() => void runScan()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-white"
          >
            <Activity className="h-4 w-4" />
            Retry scan
          </button>
        </div>
      )}

      {loading && cards.length === 0 && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-neutral-800 bg-neutral-950/40 px-6 py-16 text-sm text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
          Running event studies across parent tickers…
        </div>
      )}

      {cards.length > 0 && (
        <div className="space-y-3">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <AlphaCard
                key={`${card.kind}-${card.ticker}-${card.brand}`}
                card={card}
              />
            ))}
          </div>
          {meta && (
            <p className="text-right text-[10px] text-neutral-600">
              {meta.scannedParents} parents · {meta.scannedBrands} brands ·{" "}
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
