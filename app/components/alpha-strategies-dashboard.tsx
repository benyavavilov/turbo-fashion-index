"use client";

import { useCallback, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  Radar,
  Shield,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { usePaperPortfolio } from "@/app/components/paper-portfolio-context";
import { isBearishVerdict, isBullishVerdict } from "@/lib/paper-portfolio";
import type {
  BreakingCatalyst,
  StrategyId,
  StrategyPick,
  StrategyRankerResponse,
} from "@/lib/screener";

const STRATEGY_ORDER: StrategyId[] = ["momentum", "macro", "contrarian"];

function strategyIcon(id: StrategyId) {
  if (id === "momentum") return TrendingUp;
  if (id === "macro") return Shield;
  return TrendingDown;
}

function strategyAccent(id: StrategyId) {
  if (id === "momentum") {
    return {
      card: "border-amber-500/25 bg-gradient-to-b from-amber-500/10 via-neutral-950 to-neutral-950",
      badge: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
      ticker: "text-amber-300",
      risk: "text-amber-400/80",
    };
  }
  if (id === "macro") {
    return {
      card: "border-emerald-500/25 bg-gradient-to-b from-emerald-500/10 via-neutral-950 to-neutral-950",
      badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
      ticker: "text-emerald-300",
      risk: "text-emerald-400/80",
    };
  }
  return {
    card: "border-rose-500/25 bg-gradient-to-b from-rose-500/10 via-neutral-950 to-neutral-950",
    badge: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
    ticker: "text-rose-300",
    risk: "text-rose-400/80",
  };
}

function verdictBadgeClass(verdict: string): string {
  if (isBearishVerdict(verdict)) {
    return "border-rose-500/40 bg-rose-500/20 text-rose-200 shadow-[0_0_16px_rgba(244,63,94,0.15)]";
  }
  if (isBullishVerdict(verdict)) {
    return "border-emerald-500/40 bg-emerald-500/20 text-emerald-200 shadow-[0_0_16px_rgba(16,185,129,0.15)]";
  }
  return "border-neutral-600/50 bg-neutral-800/70 text-neutral-300";
}

function StrategyCard({ pick }: { pick: StrategyPick }) {
  const Icon = strategyIcon(pick.strategyId);
  const accent = strategyAccent(pick.strategyId);
  const { addFromStrategy, positions } = usePaperPortfolio();
  const [adding, setAdding] = useState(false);
  const [addedFlash, setAddedFlash] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const alreadyIn =
    positions.some(
      (p) => p.ticker === pick.ticker && p.strategyId === pick.strategyId
    ) || addedFlash;

  const onAdd = async () => {
    if (adding) return;
    setAdding(true);
    setAddError(null);
    const result = await addFromStrategy(pick);
    setAdding(false);
    if (!result.ok) {
      setAddError(result.error ?? "Failed to add position.");
      return;
    }
    setAddedFlash(true);
    setTimeout(() => setAddedFlash(false), 1800);
  };

  return (
    <article
      className={`flex min-w-[280px] flex-1 flex-col rounded-xl border p-4 shadow-lg ${accent.card}`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset ${accent.badge}`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-semibold tracking-tight text-neutral-100">
              {pick.strategyName}
            </h4>
            <p
              className={`text-[10px] font-medium uppercase tracking-wider ${accent.risk}`}
            >
              {pick.riskLevel}
            </p>
          </div>
        </div>
        <span className="rounded-md border border-neutral-700/80 bg-neutral-900/80 px-2 py-1 font-mono text-xs font-medium text-neutral-200">
          {pick.dataPoint}
        </span>
      </div>

      <p className="text-lg font-semibold text-neutral-50">
        {pick.brand}{" "}
        <span className={`font-mono text-sm font-medium ${accent.ticker}`}>
          ${pick.ticker}
        </span>
      </p>
      {pick.asOfDate && (
        <p className="mt-0.5 font-mono text-[10px] text-neutral-500">
          As of {pick.asOfDate}
        </p>
      )}

      <div className="mt-3">
        <span
          className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide ${verdictBadgeClass(pick.verdict)}`}
        >
          {pick.verdict}
        </span>
      </div>

      <ul className="mt-3 space-y-1.5 text-xs leading-snug text-neutral-400">
        {pick.bullets.map((bullet, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-500" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={adding}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900/80 px-3 py-2 text-xs font-semibold text-neutral-200 transition hover:border-indigo-500/40 hover:bg-neutral-800 disabled:opacity-50"
        >
          {adding ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : alreadyIn ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {adding
            ? "Adding…"
            : alreadyIn
              ? "In Portfolio"
              : "Add to Portfolio"}
        </button>
        {addError && (
          <p className="mt-1.5 text-[11px] text-rose-400">{addError}</p>
        )}
      </div>
    </article>
  );
}

function BreakingCatalystBox({ catalyst }: { catalyst: BreakingCatalyst }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-cyan-400/40 bg-gradient-to-r from-cyan-500/15 via-indigo-500/10 to-fuchsia-500/15 p-4 shadow-[0_0_40px_rgba(34,211,238,0.15)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(34,211,238,0.12),transparent_55%)]" />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cyan-400/15 ring-1 ring-inset ring-cyan-300/40">
            <AlertTriangle className="h-5 w-5 text-cyan-300" />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/90">
              Breaking Market Catalyst
            </p>
            <h4 className="mt-1 text-base font-semibold text-neutral-50">
              {catalyst.headline}: {catalyst.brand}{" "}
              <span className="font-mono text-sm text-cyan-300">
                ${catalyst.ticker}
              </span>
            </h4>
            <span
              className={`mt-2 inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide ${verdictBadgeClass(catalyst.verdict)}`}
            >
              {catalyst.verdict}
            </span>
            <ul className="mt-2 space-y-1 text-sm text-neutral-300">
              {catalyst.bullets.map((b, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-cyan-400/80" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="shrink-0 rounded-lg border border-cyan-400/30 bg-neutral-950/60 px-3 py-2 text-right backdrop-blur">
          <p className="text-[10px] uppercase tracking-wider text-cyan-400/70">
            Anomaly
          </p>
          <p className="font-mono text-sm font-semibold text-cyan-200">
            {catalyst.dataPoint}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AlphaStrategiesDashboard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StrategyRankerResponse | null>(null);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/screener", { method: "POST" });
      const data = (await res.json()) as StrategyRankerResponse & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Market scan failed (${res.status})`);
      }
      setResult({
        strategies: data.strategies ?? [],
        breakingCatalyst: data.breakingCatalyst ?? null,
        scannedBrands: data.scannedBrands ?? 0,
        generatedAt: data.generatedAt ?? new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Market scan failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  const orderedStrategies = STRATEGY_ORDER.map((id) =>
    result?.strategies.find((s) => s.strategyId === id)
  ).filter((s): s is StrategyPick => Boolean(s));

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/15 ring-1 ring-inset ring-indigo-500/30">
            <Radar className="h-5 w-5 text-indigo-300" />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              Alpha Strategies & Market Catalysts
            </h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              Concise multi-strategy ranks with actionable verdicts
              {result ? ` · ${result.scannedBrands} brands scored` : ""}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={runScan}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-indigo-400/40 bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_24px_rgba(99,102,241,0.25)] transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Activity className="h-4 w-4" />
          )}
          {loading ? "Scanning market data..." : "Run Market Scan"}
        </button>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}

      {!result && !loading && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 px-6 py-12 text-center">
          <Radar className="mb-3 h-8 w-8 text-neutral-600" />
          <p className="text-sm text-neutral-400">
            Run a market scan to populate momentum, macro value, and contrarian
            strategy cards.
          </p>
        </div>
      )}

      {loading && !result && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-neutral-800 bg-neutral-950/40 px-6 py-12 text-sm text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
          Ranking strategies across the fashion brand universe…
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {result.breakingCatalyst && (
            <BreakingCatalystBox catalyst={result.breakingCatalyst} />
          )}

          <div className="flex gap-4 overflow-x-auto pb-1 lg:grid lg:grid-cols-3 lg:overflow-visible">
            {orderedStrategies.map((pick) => (
              <StrategyCard key={pick.strategyId} pick={pick} />
            ))}
          </div>

          {orderedStrategies.length === 0 && (
            <p className="text-center text-sm text-neutral-500">
              No brand metrics available — ensure Supabase trend data is seeded.
            </p>
          )}

          <p className="text-right text-[10px] text-neutral-600">
            Last scan{" "}
            {new Date(result.generatedAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>
      )}
    </section>
  );
}
