/**
 * run-simulator.ts — V4 Walk-Forward Portfolio Simulator (Dynamic Weighting)
 *
 * Fully invests available cash each signal week (cash / n triggers) to avoid
 * cash drag vs a fully invested S&P 500 buy-and-hold benchmark.
 * Uses the same YoY + Pearson rules as scripts/run-backtest.ts.
 *
 * Run with:
 *   npm run simulate
 *   npx tsx --env-file=.env.local scripts/run-simulator.ts
 */

import YahooFinance from "yahoo-finance2";

import { normalizeDateString } from "../lib/chart-data";
import { parentCompanies } from "../lib/entities";
import {
  fetchStockQuotes,
  fetchTrendHistory,
} from "../lib/market-data";
import {
  correlationTrendVsStock,
  extractBrandSeries,
  type TrendPoint,
} from "../lib/screener";

// ---------------------------------------------------------------------------
// Config (shared with V4 backtest)
// ---------------------------------------------------------------------------

const YEARS_BACK = 5;
/** First year of history is reserved for YoY baseline; trade the last 4y. */
const SIM_YEARS = 4;
const SPX_TICKER = "^GSPC";
const MA_WEEKS = 4;
const YOY_LAG_WEEKS = 52;
const YOY_GROWTH_THRESHOLD = 25;
const MIN_POSITIVE_CORR = 0.15;
const HOLD_WEEKS = 13;
const HOLD_DAYS = 90;
const YAHOO_PAUSE_MS = 500;

const STARTING_CAPITAL = 10_000;

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
  /** date → index in series (normalized YYYY-MM-DD). */
  dateIndex: Map<string, number>;
}

interface OpenPosition {
  ticker: string;
  brand: string;
  parentName: string;
  entryDate: string;
  entryWeekIdx: number;
  entryPrice: number;
  shares: number;
  cost: number;
  yoyGrowthPct: number;
  correlation: number;
}

interface ClosedTrade {
  ticker: string;
  brand: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  cost: number;
  proceeds: number;
  pnl: number;
  returnPct: number;
  forced: boolean;
}

interface WeekTrigger {
  brand: string;
  parentName: string;
  ticker: string;
  date: string;
  yoyGrowthPct: number;
  correlation: number;
}

// ---------------------------------------------------------------------------
// Shared math helpers (aligned with run-backtest.ts)
// ---------------------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pctReturn(start: number, end: number): number {
  if (!Number.isFinite(start) || start === 0) return NaN;
  return ((end - start) / start) * 100;
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
  period1.setFullYear(period1.getFullYear() - YEARS_BACK);
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

/** YoY % growth of 4w MA at series index i (null if not computable). */
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

/**
 * Pearson r using only data available through `asOfDate` (no look-ahead).
 */
function correlationAsOf(
  series: TrendPoint[],
  stockBars: WeeklyBar[],
  asOfDate: string
): number {
  const asOf = normalizeDateString(asOfDate);
  const truncated = series.filter((p) => normalizeDateString(p.date) <= asOf);
  const stockMap = new Map<string, number>();
  for (const bar of stockBars) {
    if (bar.date <= asOf) stockMap.set(bar.date, bar.close);
  }
  if (truncated.length < YOY_LAG_WEEKS + MA_WEEKS || stockMap.size < 20) {
    return NaN;
  }
  return correlationTrendVsStock(truncated, stockMap);
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
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

function daysBetween(a: string, b: string): number {
  return (
    (new Date(`${b}T12:00:00`).getTime() -
      new Date(`${a}T12:00:00`).getTime()) /
    (24 * 60 * 60 * 1000)
  );
}

function buildDateIndex(series: TrendPoint[]): Map<string, number> {
  const map = new Map<string, number>();
  series.forEach((p, i) => {
    map.set(normalizeDateString(p.date), i);
  });
  return map;
}

/**
 * Chronological weekly timeline from ~4y ago → last available bar.
 * Prefers SPX weekly dates (market calendar); falls back to union of trend dates.
 */
function buildTimeline(
  spxBars: WeeklyBar[],
  trendDates: string[],
  simStart: string
): string[] {
  const fromSpx = spxBars
    .map((b) => b.date)
    .filter((d) => d >= simStart);
  if (fromSpx.length > 0) return fromSpx;

  return [...new Set(trendDates.map(normalizeDateString))]
    .filter((d) => d >= simStart)
    .sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Main walk-forward loop
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  V4 Walk-Forward Simulator (Dynamic Weighting)           ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];
  console.log(
    `Universe: ${parentCompanies.length} parents · ${brandNames.length} child brands`
  );
  console.log(
    `Capital: ${fmtUsd(STARTING_CAPITAL)} · Allocation: 100% of cash / n triggers`
  );
  console.log(
    `Rules: YoY 4w-MA > ${YOY_GROWTH_THRESHOLD}% · Pearson r > ${MIN_POSITIVE_CORR} · Hold ${HOLD_DAYS}d (~${HOLD_WEEKS}w)`
  );
  console.log(
    `Window: last ${SIM_YEARS}y of trading (first year reserved for YoY baseline)\n`
  );

  console.log("Fetching 5y Google Trends from Supabase…");
  const trendData = await fetchTrendHistory(brandNames, YEARS_BACK);
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
      const stockMap = await fetchStockQuotes(parent.ticker, YEARS_BACK);
      const bars = mapToWeeklyBars(stockMap);
      if (bars.length < HOLD_WEEKS + 8) {
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
        dateIndex: buildDateIndex(series),
      });
    }
  }

  if (brands.length === 0) {
    throw new Error("No brand series available for simulation.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const simStartDate = new Date();
  simStartDate.setFullYear(simStartDate.getFullYear() - SIM_YEARS);
  const simStart = simStartDate.toISOString().slice(0, 10);

  const allTrendDates = brands.flatMap((b) => b.series.map((p) => p.date));
  const timeline = buildTimeline(spxBars, allTrendDates, simStart).filter(
    (d) => d <= today
  );

  if (timeline.length < HOLD_WEEKS + 2) {
    throw new Error(
      `Timeline too short (${timeline.length} weeks). Need more historical data.`
    );
  }

  console.log(
    `\nWalk-forward: ${timeline[0]} → ${timeline[timeline.length - 1]} (${timeline.length} weeks)\n`
  );

  let cash = STARTING_CAPITAL;
  const open: OpenPosition[] = [];
  const closed: ClosedTrade[] = [];
  let buysExecuted = 0;

  for (let w = 0; w < timeline.length; w++) {
    const weekDate = timeline[w];
    const isLastWeek = w === timeline.length - 1;

    // ------------------------------------------------------------------
    // SELL: positions held ≥ 13 weeks / ~90 days
    // ------------------------------------------------------------------
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const weeksHeld = w - pos.entryWeekIdx;
      const heldLongEnough =
        weeksHeld >= HOLD_WEEKS ||
        daysBetween(pos.entryDate, weekDate) >= HOLD_DAYS;
      if (!heldLongEnough && !isLastWeek) continue;

      const bars = stockBarsByTicker.get(pos.ticker);
      if (!bars) continue;
      const exitBar =
        nearestOnOrBefore(bars, weekDate) ?? nearestOnOrAfter(bars, weekDate);
      if (!exitBar) continue;

      const proceeds = pos.shares * exitBar.close;
      const pnl = proceeds - pos.cost;
      cash += proceeds;
      closed.push({
        ticker: pos.ticker,
        brand: pos.brand,
        entryDate: pos.entryDate,
        exitDate: exitBar.date,
        entryPrice: pos.entryPrice,
        exitPrice: exitBar.close,
        cost: pos.cost,
        proceeds,
        pnl,
        returnPct: pctReturn(pos.cost, proceeds),
        forced: isLastWeek && !heldLongEnough,
      });
      open.splice(i, 1);
    }

    if (isLastWeek) break;

    // ------------------------------------------------------------------
    // SCAN: V4 triggers as of this week (no look-ahead)
    // ------------------------------------------------------------------
    const rawTriggers: WeekTrigger[] = [];
    for (const b of brands) {
      // Align brand week to nearest trend date on/before this calendar week.
      let idx = b.dateIndex.get(weekDate);
      if (idx == null) {
        // Soft match: last series point on/before weekDate
        for (let j = b.series.length - 1; j >= 0; j--) {
          if (normalizeDateString(b.series[j].date) <= weekDate) {
            idx = j;
            break;
          }
        }
      }
      if (idx == null) continue;

      const yoy = yoyGrowthAt(b.series, idx);
      if (yoy == null || yoy <= YOY_GROWTH_THRESHOLD) continue;

      const stockBars = stockBarsByTicker.get(b.ticker)!;
      const corr = correlationAsOf(b.series, stockBars, weekDate);
      if (!Number.isFinite(corr) || corr <= MIN_POSITIVE_CORR) continue;

      rawTriggers.push({
        brand: b.brand,
        parentName: b.parentName,
        ticker: b.ticker,
        date: b.series[idx].date,
        yoyGrowthPct: yoy,
        correlation: Math.round(corr * 100) / 100,
      });
    }

    // One position per ticker: keep strongest YoY if multiple brands fire.
    const byTicker = new Map<string, WeekTrigger>();
    for (const t of rawTriggers) {
      const prev = byTicker.get(t.ticker);
      if (!prev || t.yoyGrowthPct > prev.yoyGrowthPct) {
        byTicker.set(t.ticker, t);
      }
    }

    const candidates = [...byTicker.values()].sort(
      (a, b) => b.yoyGrowthPct - a.yoyGrowthPct
    );

    // ------------------------------------------------------------------
    // BUY: dynamic weighting — deploy 100% of cash evenly across n triggers
    // ------------------------------------------------------------------
    const heldTickers = new Set(open.map((p) => p.ticker));
    const buyable: { signal: WeekTrigger; entryBar: WeeklyBar }[] = [];

    for (const signal of candidates) {
      if (heldTickers.has(signal.ticker)) continue;
      const bars = stockBarsByTicker.get(signal.ticker);
      if (!bars) continue;
      const entryBar =
        nearestOnOrAfter(bars, weekDate) ?? nearestOnOrBefore(bars, weekDate);
      if (!entryBar || entryBar.close <= 0) continue;
      buyable.push({ signal, entryBar });
    }

    const n = buyable.length;
    if (n > 0 && cash > 0) {
      const allocation = cash / n;
      for (const { signal, entryBar } of buyable) {
        const shares = allocation / entryBar.close;
        open.push({
          ticker: signal.ticker,
          brand: signal.brand,
          parentName: signal.parentName,
          entryDate: entryBar.date,
          entryWeekIdx: w,
          entryPrice: entryBar.close,
          shares,
          cost: allocation,
          yoyGrowthPct: signal.yoyGrowthPct,
          correlation: signal.correlation,
        });
        heldTickers.add(signal.ticker);
        buysExecuted += 1;
      }
      // Fully invested: proceeds from future sells refill cash for redeployment.
      cash = 0;
    }
  }

  // Safety: any leftover open positions (should be empty after last-week force)
  if (open.length > 0) {
    const lastDate = timeline[timeline.length - 1];
    for (const pos of open) {
      const bars = stockBarsByTicker.get(pos.ticker);
      const exitBar = bars
        ? nearestOnOrBefore(bars, lastDate) ?? bars[bars.length - 1]
        : null;
      if (!exitBar) continue;
      const proceeds = pos.shares * exitBar.close;
      cash += proceeds;
      closed.push({
        ticker: pos.ticker,
        brand: pos.brand,
        entryDate: pos.entryDate,
        exitDate: exitBar.date,
        entryPrice: pos.entryPrice,
        exitPrice: exitBar.close,
        cost: pos.cost,
        proceeds,
        pnl: proceeds - pos.cost,
        returnPct: pctReturn(pos.cost, proceeds),
        forced: true,
      });
    }
    open.length = 0;
  }

  const finalValue = cash;
  const strategyReturnPct = pctReturn(STARTING_CAPITAL, finalValue);

  const simEnd = timeline[timeline.length - 1];
  const spxStart = nearestOnOrAfter(spxBars, timeline[0]);
  const spxEnd = nearestOnOrBefore(spxBars, simEnd);
  const spxReturnPct =
    spxStart && spxEnd ? pctReturn(spxStart.close, spxEnd.close) : NaN;

  const wins = closed.filter((t) => t.pnl > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

  console.log("┌──────────────────────────────────────────────────────────┐");
  console.log("│  V4 Walk-Forward Simulator (Dynamic Weighting)           │");
  console.log("├──────────────────────────────────────────────────────────┤");
  console.log(
    `│  Starting Capital            ${pad(fmtUsd(STARTING_CAPITAL), 26)}│`
  );
  console.log(
    `│  Final Portfolio Value       ${pad(fmtUsd(finalValue), 26)}│`
  );
  console.log(
    `│  Strategy Total Return       ${pad(fmtPct(strategyReturnPct), 26)}│`
  );
  console.log(
    `│  S&P 500 Total Return        ${pad(fmtPct(spxReturnPct), 26)}│`
  );
  console.log(
    `│  Total Trades Executed       ${pad(String(buysExecuted), 26)}│`
  );
  console.log(
    `│  Portfolio Win Rate          ${pad(`${winRate.toFixed(1)}%  (${wins}/${closed.length})`, 26)}│`
  );
  console.log("├──────────────────────────────────────────────────────────┤");
  console.log(
    `│  Period                      ${pad(`${timeline[0]} → ${simEnd}`, 26)}│`
  );
  console.log(
    `│  vs Benchmark (α)            ${pad(
      Number.isFinite(strategyReturnPct) && Number.isFinite(spxReturnPct)
        ? fmtPct(strategyReturnPct - spxReturnPct)
        : "n/a",
      26
    )}│`
  );
  console.log("└──────────────────────────────────────────────────────────┘\n");

  const sample = [...closed]
    .sort((a, b) => b.exitDate.localeCompare(a.exitDate))
    .slice(0, 8);
  if (sample.length > 0) {
    console.log("Recent closed trades:");
    for (const t of sample) {
      console.log(
        `  ${t.entryDate}→${t.exitDate}  ${t.ticker.padEnd(6)} ${pad(t.brand, 16)} ${fmtPct(t.returnPct)}  PnL ${fmtUsd(t.pnl)}${t.forced ? " (forced)" : ""}`
      );
    }
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFatal simulator error:", err);
    process.exit(1);
  });
