"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Briefcase, Loader2, RefreshCw, Trash2 } from "lucide-react";

import { usePaperPortfolio } from "@/app/components/paper-portfolio-context";
import {
  computePnlPct,
  formatPnl,
  formatUsd,
  type ExitVerdict,
} from "@/lib/paper-portfolio";

function verdictClass(verdict?: ExitVerdict | string): string {
  if (!verdict) return "border-neutral-700 bg-neutral-800/60 text-neutral-400";
  if (verdict === "HOLD") {
    return "border-sky-500/35 bg-sky-500/15 text-sky-300";
  }
  if (verdict === "TAKE PROFITS") {
    return "border-emerald-500/35 bg-emerald-500/15 text-emerald-300";
  }
  return "border-rose-500/35 bg-rose-500/15 text-rose-300";
}

export default function PaperPortfolioPanel() {
  const { positions, adviceByTicker, removePosition, setAdvice, clearAdvice } =
    usePaperPortfolio();
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tickersKey = useMemo(
    () =>
      [...new Set(positions.map((p) => p.ticker))].sort().join("|"),
    [positions]
  );

  const refreshPrices = useCallback(async () => {
    const tickers = [...new Set(positions.map((p) => p.ticker))];
    if (tickers.length === 0) {
      setPrices({});
      return;
    }

    setPricesLoading(true);
    try {
      const entries = await Promise.all(
        tickers.map(async (ticker) => {
          const res = await fetch(
            `/api/finance?ticker=${encodeURIComponent(ticker)}&timeframe=6M`
          );
          const data = (await res.json()) as {
            quotes?: { close: number }[];
          };
          const quotes = data.quotes ?? [];
          const last = quotes.length ? quotes[quotes.length - 1].close : null;
          return [ticker, last] as const;
        })
      );
      const next: Record<string, number> = {};
      for (const [ticker, price] of entries) {
        if (typeof price === "number") next[ticker] = price;
      }
      setPrices(next);
    } catch {
      setError("Failed to refresh live prices.");
    } finally {
      setPricesLoading(false);
    }
  }, [positions]);

  useEffect(() => {
    void refreshPrices();
  }, [tickersKey, refreshPrices]);

  const analyzePositions = async () => {
    if (positions.length === 0 || adviceLoading) return;
    setAdviceLoading(true);
    setError(null);
    clearAdvice();
    try {
      const res = await fetch("/api/portfolio-advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holdings: positions.map((p) => ({
            brand: p.brand,
            ticker: p.ticker,
            strategy: p.strategy,
            side: p.side,
            buyPrice: p.buyPrice,
            buyDate: p.buyDate,
          })),
        }),
      });
      const data = (await res.json()) as {
        advice?: { ticker: string; verdict: ExitVerdict; rationale: string }[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Advice failed (${res.status})`);
      }
      setAdvice(data.advice ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Advice request failed.");
    } finally {
      setAdviceLoading(false);
    }
  };

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/30">
            <Briefcase className="h-5 w-5 text-emerald-300" />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              Active Paper Portfolio
            </h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              Simulated positions from alpha strategies · live Yahoo P&amp;L
              {positions.length > 0 ? ` · ${positions.length} open` : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void refreshPrices()}
            disabled={pricesLoading || positions.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            {pricesLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh Prices
          </button>
          <button
            type="button"
            onClick={() => void analyzePositions()}
            disabled={adviceLoading || positions.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {adviceLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {adviceLoading ? "Analyzing…" : "Analyze Active Positions"}
          </button>
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}

      {positions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 px-6 py-10 text-center text-sm text-neutral-500">
          No paper positions yet. Run a market scan and click{" "}
          <span className="text-neutral-300">Add to Portfolio</span> on a
          strategy card.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-neutral-950/80 text-[10px] uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-3 py-2.5 font-medium">Position</th>
                <th className="px-3 py-2.5 font-medium">Side / Strategy</th>
                <th className="px-3 py-2.5 font-medium">Entry</th>
                <th className="px-3 py-2.5 font-medium">Mark</th>
                <th className="px-3 py-2.5 font-medium">P&amp;L</th>
                <th className="px-3 py-2.5 font-medium">Exit Signal</th>
                <th className="px-3 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/80">
              {positions.map((p) => {
                const mark = prices[p.ticker];
                const pnl =
                  typeof mark === "number"
                    ? computePnlPct(p.side, p.buyPrice, mark)
                    : null;
                const advice = adviceByTicker[p.ticker.toUpperCase()];

                return (
                  <tr key={p.id} className="bg-neutral-950/30 align-top">
                    <td className="px-3 py-3">
                      <p className="font-medium text-neutral-100">
                        {p.brand}{" "}
                        <span className="font-mono text-xs text-amber-300/90">
                          ${p.ticker}
                        </span>
                      </p>
                      <p className="font-mono text-[10px] text-neutral-600">
                        Since {p.buyDate}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                          p.side === "LONG"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                        }`}
                      >
                        {p.side}
                      </span>
                      <p className="mt-1 text-[11px] text-neutral-500">
                        {p.strategy}
                      </p>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-neutral-300">
                      {formatUsd(p.buyPrice)}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-neutral-300">
                      {typeof mark === "number" ? formatUsd(mark) : "—"}
                    </td>
                    <td className="px-3 py-3">
                      {pnl == null ? (
                        <span className="text-xs text-neutral-600">—</span>
                      ) : (
                        <span
                          className={`font-mono text-xs font-semibold ${
                            pnl >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {formatPnl(pnl)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 max-w-[220px]">
                      {advice ? (
                        <div className="space-y-1">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${verdictClass(advice.verdict)}`}
                          >
                            {advice.verdict}
                          </span>
                          <p className="text-[11px] leading-snug text-neutral-500">
                            {advice.rationale}
                          </p>
                        </div>
                      ) : (
                        <span className="text-[11px] text-neutral-600">
                          Run analysis for exit signal
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        onClick={() => removePosition(p.id)}
                        className="rounded-md p-1.5 text-neutral-500 hover:bg-rose-500/10 hover:text-rose-300"
                        aria-label={`Remove ${p.ticker}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
