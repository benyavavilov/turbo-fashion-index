/**
 * test-isolated-signals.ts — Dual-Engine "Purity of Advice" Tester
 *
 * Tests every Engine 2 setup (YoY > 25% AND r > 0.15) in isolation over ~5y:
 *   - $1,000 into the parent stock on the advice date
 *   - $1,000 into ^GSPC on the same date
 *   - Hold both exactly 90 days
 *
 * No LLM. No cash tracking. Overlapping trades are allowed — this measures
 * raw predictive power of the math signal, not portfolio management.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/test-isolated-signals.ts
 *
 * Writes: isolated_advice_log.csv (every advice event)
 */

import * as fs from "fs";
import path from "node:path";
import YahooFinance from "yahoo-finance2";

import { normalizeDateString } from "../lib/chart-data";
import { parentCompanies } from "../lib/entities";
import { fetchStockQuotes, fetchTrendHistory } from "../lib/market-data";
import {
  correlationTrendVsStock,
  extractBrandSeries,
  type TrendPoint,
} from "../lib/screener";

// ---------------------------------------------------------------------------
// Config (Dual-Engine thresholds)
// ---------------------------------------------------------------------------

const YEARS_BACK = 5;
const SPX_TICKER = "^GSPC";
const MA_WEEKS = 4;
const YOY_LAG_WEEKS = 52;
const YOY_GROWTH_THRESHOLD = 25;
const MIN_POSITIVE_CORR = 0.15;
const HOLD_DAYS = 90;
const ADVICE_NOTIONAL = 1_000;
const YAHOO_PAUSE_MS = 500;
const CSV_NAME = "isolated_advice_log.csv";

const yahooFinance = new YahooFinance();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeeklyBar {
  date: string;
  close: number;
}

interface BrandSeries {
  brand: string;
  parentName: string;
  ticker: string;
  series: TrendPoint[];
}

interface AdviceEvent {
  adviceDate: string;
  exitDate: string;
  ticker: string;
  brand: string;
  parentName: string;
  yoyGrowthPct: number;
  correlation: number;
  stockEntryPrice: number;
  stockExitPrice: number;
  stockReturnPct: number;
  spxEntryPrice: number;
  spxExitPrice: number;
  spxReturnPct: number;
  alphaPct: number;
  stockPnL: number;
  spxPnL: number;
}

interface AdviceSummary {
  count: number;
  winRate: number;
  wins: number;
  withAlpha: number;
  avgAdviceReturn: number;
  avgSpxReturn: number;
  avgAlpha: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pctReturn(start: number, end: number): number {
  if (!Number.isFinite(start) || start === 0) return NaN;
  return ((end - start) / start) * 100;
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${normalizeDateString(isoDate)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nearestOnOrAfter(
  bars: WeeklyBar[],
  targetDate: string
): WeeklyBar | null {
  const target = normalizeDateString(targetDate);
  for (const bar of bars) {
    if (bar.date >= target) return bar;
  }
  return null;
}

function nearestOnOrBefore(
  bars: WeeklyBar[],
  targetDate: string
): WeeklyBar | null {
  const target = normalizeDateString(targetDate);
  let best: WeeklyBar | null = null;
  for (const bar of bars) {
    if (bar.date <= target) best = bar;
    else break;
  }
  return best;
}

function mapToWeeklyBars(map: Map<string, number>): WeeklyBar[] {
  return [...map.entries()]
    .map(([date, close]) => ({
      date: normalizeDateString(date),
      close,
    }))
    .filter((b) => Number.isFinite(b.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchSpxWeekly(): Promise<WeeklyBar[]> {
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - (YEARS_BACK + 1));
  const chart = await yahooFinance.chart(SPX_TICKER, {
    period1,
    period2: new Date(),
    interval: "1wk",
  });
  const raw =
    (chart as { quotes?: { date?: Date; close?: number | null }[] }).quotes ??
    [];
  return raw
    .filter((q) => q.close != null && q.date != null)
    .map((q) => ({
      date: new Date(q.date as Date).toISOString().slice(0, 10),
      close: q.close as number,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function maEndingAt(series: TrendPoint[], endIdx: number): number | null {
  if (endIdx < MA_WEEKS - 1) return null;
  const window = series.slice(endIdx - MA_WEEKS + 1, endIdx + 1);
  if (window.length < MA_WEEKS) return null;
  return mean(window.map((p) => p.value));
}

function yearAgoIndex(series: TrendPoint[], i: number): number | null {
  if (i < YOY_LAG_WEEKS) return null;
  const byLag = i - YOY_LAG_WEEKS;
  if (byLag >= MA_WEEKS - 1) return byLag;

  const currentMs = new Date(`${series[i].date}T12:00:00`).getTime();
  const targetMs = currentMs - 365 * 24 * 60 * 60 * 1000;
  let best: { idx: number; diff: number } | null = null;
  for (let j = 0; j < i; j++) {
    const ms = new Date(`${series[j].date}T12:00:00`).getTime();
    const diff = Math.abs(ms - targetMs);
    if (!best || diff < best.diff) best = { idx: j, diff };
  }
  if (!best || best.idx < MA_WEEKS - 1) return null;
  if (best.diff > 21 * 24 * 60 * 60 * 1000) return null;
  return best.idx;
}

/** Engine 2 YoY % at series index i (no winsorize / no LLM). */
function yoyGrowthAt(series: TrendPoint[], i: number): number | null {
  if (i < YOY_LAG_WEEKS + MA_WEEKS - 1) return null;
  const currentMa = maEndingAt(series, i);
  const yIdx = yearAgoIndex(series, i);
  if (yIdx == null) return null;
  const lastYearMa = maEndingAt(series, yIdx);
  if (currentMa == null || lastYearMa == null) return null;
  if (!Number.isFinite(lastYearMa) || Math.abs(lastYearMa) < 1e-6) return null;

  const yoy = ((currentMa - lastYearMa) / lastYearMa) * 100;
  if (!Number.isFinite(yoy)) return null;
  return Math.round(yoy * 10) / 10;
}

/** Pearson r using only data available through asOfDate (no look-ahead). */
function correlationAsOf(
  series: TrendPoint[],
  stockBars: WeeklyBar[],
  asOfDate: string
): number {
  const asOf = normalizeDateString(asOfDate);
  const floor = addDays(asOf, -Math.round(YEARS_BACK * 365.25));

  const truncated = series.filter((p) => {
    const d = normalizeDateString(p.date);
    return d >= floor && d <= asOf;
  });

  const stockMap = new Map<string, number>();
  for (const bar of stockBars) {
    if (bar.date >= floor && bar.date <= asOf) {
      stockMap.set(bar.date, bar.close);
    }
  }

  if (truncated.length < YOY_LAG_WEEKS + MA_WEEKS || stockMap.size < 20) {
    return NaN;
  }
  return correlationTrendVsStock(truncated, stockMap);
}

function summarizeAdvice(events: AdviceEvent[]): AdviceSummary {
  const withAlpha = events.filter((e) => Number.isFinite(e.alphaPct));
  const wins = withAlpha.filter((e) => e.alphaPct > 0).length;
  return {
    count: events.length,
    winRate: withAlpha.length > 0 ? (wins / withAlpha.length) * 100 : 0,
    wins,
    withAlpha: withAlpha.length,
    avgAdviceReturn:
      events.length > 0
        ? events.reduce((s, e) => s + e.stockReturnPct, 0) / events.length
        : NaN,
    avgSpxReturn:
      events.length > 0
        ? events.reduce((s, e) => s + e.spxReturnPct, 0) / events.length
        : NaN,
    avgAlpha:
      withAlpha.length > 0
        ? withAlpha.reduce((s, e) => s + e.alphaPct, 0) / withAlpha.length
        : NaN,
  };
}

function exportAdviceCsv(events: AdviceEvent[], outPath: string): void {
  const header = [
    "Advice Date",
    "Exit Date",
    "Ticker",
    "Brand",
    "Parent",
    "YoY Growth (%)",
    "Correlation",
    "Stock Entry",
    "Stock Exit",
    "Stock Return (%)",
    "SPX Entry",
    "SPX Exit",
    "SPX Return (%)",
    "Alpha (%)",
    "Stock PnL ($)",
    "SPX PnL ($)",
  ].join(",");

  const rows = events.map((e) =>
    [
      e.adviceDate,
      e.exitDate,
      csvEscape(e.ticker),
      csvEscape(e.brand),
      csvEscape(e.parentName),
      e.yoyGrowthPct.toFixed(1),
      e.correlation.toFixed(2),
      e.stockEntryPrice.toFixed(2),
      e.stockExitPrice.toFixed(2),
      e.stockReturnPct.toFixed(2),
      e.spxEntryPrice.toFixed(2),
      e.spxExitPrice.toFixed(2),
      e.spxReturnPct.toFixed(2),
      e.alphaPct.toFixed(2),
      e.stockPnL.toFixed(2),
      e.spxPnL.toFixed(2),
    ].join(",")
  );

  fs.writeFileSync(outPath, [header, ...rows].join("\n") + "\n", "utf8");
}

function printSummary(summary: AdviceSummary): void {
  console.log(
    "┌────────────────────────────────────┬──────────────────────────┐"
  );
  console.log(
    "│ Metric                             │ Value                    │"
  );
  console.log(
    "├────────────────────────────────────┼──────────────────────────┤"
  );
  console.log(
    `│ Total Pieces of Advice Issued      │ ${String(summary.count).padEnd(24)} │`
  );
  console.log(
    `│ Advice Win Rate (α > 0)            │ ${`${summary.winRate.toFixed(1)}% (${summary.wins}/${summary.withAlpha})`.padEnd(24)} │`
  );
  console.log(
    `│ Average Advice Return (%)          │ ${fmtPct(summary.avgAdviceReturn).padEnd(24)} │`
  );
  console.log(
    `│ Average S&P 500 Return (%)         │ ${fmtPct(summary.avgSpxReturn).padEnd(24)} │`
  );
  console.log(
    `│ Average Alpha per Advice (%)       │ ${fmtPct(summary.avgAlpha).padEnd(24)} │`
  );
  console.log(
    "└────────────────────────────────────┴──────────────────────────┘"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  Isolated Signal Tester — Purity of Advice (Dual-Engine) ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];
  console.log(
    `Universe: ${parentCompanies.length} parents · ${brandNames.length} child brands`
  );
  console.log(
    `Engine 2 trigger: YoY > ${YOY_GROWTH_THRESHOLD}% AND r > ${MIN_POSITIVE_CORR}`
  );
  console.log(
    `Advice: ${fmtUsd(ADVICE_NOTIONAL)} stock + ${fmtUsd(ADVICE_NOTIONAL)} ${SPX_TICKER} · hold ${HOLD_DAYS}d fixed`
  );
  console.log(
    `Mode: isolated math only (no LLM, no cash, overlaps allowed)\n`
  );

  console.log("Fetching Google Trends from Supabase (market_metrics)…");
  const trendData = await fetchTrendHistory(
    brandNames,
    YEARS_BACK + 1,
    "market_metrics"
  );
  if (trendData.length === 0) {
    throw new Error(
      "No trend rows — run npm run fetch:trends and ensure Supabase is configured."
    );
  }
  console.log(`  → ${trendData.length} weekly trend rows`);

  console.log(`Fetching historical data for ${SPX_TICKER}…`);
  const spxBars = await fetchSpxWeekly();
  console.log(`  → ${spxBars.length} SPX bars`);
  await sleep(YAHOO_PAUSE_MS);

  const stockBarsByTicker = new Map<string, WeeklyBar[]>();
  console.log("\nFetching parent equity histories (sequential)…");
  for (let i = 0; i < parentCompanies.length; i++) {
    const parent = parentCompanies[i];
    console.log(
      `Fetching historical data for ${parent.ticker}… (${i + 1}/${parentCompanies.length})`
    );
    try {
      const stockMap = await fetchStockQuotes(parent.ticker, YEARS_BACK + 1);
      const bars = mapToWeeklyBars(stockMap);
      if (bars.length < 20) {
        console.log(`  SKIP ${parent.ticker} (insufficient stock history)`);
      } else {
        stockBarsByTicker.set(parent.ticker, bars);
        console.log(`  → ${bars.length} bars`);
      }
    } catch (error) {
      console.log(
        `  SKIP ${parent.ticker} (stock fetch failed: ${String(error).slice(0, 80)})`
      );
    }
    if (i < parentCompanies.length - 1) await sleep(YAHOO_PAUSE_MS);
  }

  const brands: BrandSeries[] = [];
  for (const parent of parentCompanies) {
    if (!stockBarsByTicker.has(parent.ticker)) continue;
    for (const brand of parent.childBrands) {
      const series = extractBrandSeries(trendData, brand);
      if (series.length < YOY_LAG_WEEKS + MA_WEEKS) {
        console.log(
          `  skip ${brand} — insufficient history (${series.length} pts)`
        );
        continue;
      }
      brands.push({
        brand,
        parentName: parent.name,
        ticker: parent.ticker,
        series,
      });
    }
  }

  if (brands.length === 0) {
    throw new Error("No brand series available for isolated signal testing.");
  }

  console.log(
    `\nScanning ${brands.length} brand series week-by-week for Engine 2 triggers…\n`
  );

  const allAdvice: AdviceEvent[] = [];
  let skippedNoPrice = 0;

  for (const b of brands) {
    const stockBars = stockBarsByTicker.get(b.ticker);
    if (!stockBars) continue;

    for (let i = 0; i < b.series.length; i++) {
      const yoy = yoyGrowthAt(b.series, i);
      if (yoy == null || yoy <= YOY_GROWTH_THRESHOLD) continue;

      const adviceDate = normalizeDateString(b.series[i].date);
      const corr = correlationAsOf(b.series, stockBars, adviceDate);
      if (!Number.isFinite(corr) || corr <= MIN_POSITIVE_CORR) continue;

      const exitTarget = addDays(adviceDate, HOLD_DAYS);

      const stockEntry =
        nearestOnOrAfter(stockBars, adviceDate) ??
        nearestOnOrBefore(stockBars, adviceDate);
      const stockExit =
        nearestOnOrBefore(stockBars, exitTarget) ??
        nearestOnOrAfter(stockBars, exitTarget);

      const spxEntry =
        nearestOnOrAfter(spxBars, adviceDate) ??
        nearestOnOrBefore(spxBars, adviceDate);
      const spxExit =
        nearestOnOrBefore(spxBars, exitTarget) ??
        nearestOnOrAfter(spxBars, exitTarget);

      if (
        !stockEntry ||
        !stockExit ||
        !spxEntry ||
        !spxExit ||
        stockEntry.close <= 0 ||
        stockExit.close <= 0 ||
        spxEntry.close <= 0 ||
        spxExit.close <= 0
      ) {
        skippedNoPrice += 1;
        continue;
      }

      // Require a true forward hold (exit after entry).
      if (stockExit.date <= stockEntry.date || spxExit.date <= spxEntry.date) {
        skippedNoPrice += 1;
        continue;
      }

      const stockReturnPct = pctReturn(stockEntry.close, stockExit.close);
      const spxReturnPct = pctReturn(spxEntry.close, spxExit.close);
      const alphaPct =
        Number.isFinite(stockReturnPct) && Number.isFinite(spxReturnPct)
          ? Math.round((stockReturnPct - spxReturnPct) * 10) / 10
          : NaN;

      const roundedCorr = Math.round(corr * 100) / 100;
      const stockPnL = ADVICE_NOTIONAL * (stockReturnPct / 100);
      const spxPnL = ADVICE_NOTIONAL * (spxReturnPct / 100);

      allAdvice.push({
        adviceDate: stockEntry.date,
        exitDate: stockExit.date,
        ticker: b.ticker,
        brand: b.brand,
        parentName: b.parentName,
        yoyGrowthPct: yoy,
        correlation: roundedCorr,
        stockEntryPrice: stockEntry.close,
        stockExitPrice: stockExit.close,
        stockReturnPct: Math.round(stockReturnPct * 10) / 10,
        spxEntryPrice: spxEntry.close,
        spxExitPrice: spxExit.close,
        spxReturnPct: Math.round(spxReturnPct * 10) / 10,
        alphaPct,
        stockPnL: Math.round(stockPnL * 100) / 100,
        spxPnL: Math.round(spxPnL * 100) / 100,
      });
    }
  }

  allAdvice.sort(
    (a, b) =>
      a.adviceDate.localeCompare(b.adviceDate) ||
      a.ticker.localeCompare(b.ticker) ||
      a.brand.localeCompare(b.brand)
  );

  const summary = summarizeAdvice(allAdvice);
  const outPath = path.join(process.cwd(), CSV_NAME);
  exportAdviceCsv(allAdvice, outPath);

  console.log("\nSummary — Purity of Advice (all Dual-Engine triggers)\n");
  printSummary(summary);

  if (skippedNoPrice > 0) {
    console.log(`\n  (Skipped ${skippedNoPrice} triggers with no forward price)`);
  }

  console.log(
    `\nCSV exported: ${CSV_NAME} (${allAdvice.length} advice events)`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFatal isolated-signal error:", err);
    process.exit(1);
  });
