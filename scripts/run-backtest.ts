/**
 * run-backtest.ts — V4 YoY Trend Backtest
 *
 * Structural Year-over-Year search growth → 90-day stock vs S&P 500 alpha.
 * Trades only when YoY 4w MA growth > 25% AND brand↔stock Pearson r > 0.15.
 *
 * Run with:
 *   npm run backtest
 *   npx tsx --env-file=.env.local scripts/run-backtest.ts
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
// Config
// ---------------------------------------------------------------------------

const YEARS_BACK = 5;
const SPX_TICKER = "^GSPC";
const MA_WEEKS = 4;
/** Approx weeks in a year for YoY alignment on weekly Google Trends. */
const YOY_LAG_WEEKS = 52;
/** Minimum YoY 4w-MA search growth (%) to trigger a trade. */
const YOY_GROWTH_THRESHOLD = 25;
/** Brand reliability: baseline Pearson search↔stock must exceed this. */
const MIN_POSITIVE_CORR = 0.15;
/** Forward holding window ≈ 13 weekly bars. */
const HOLD_WEEKS = 13;
const HOLD_DAYS = 90;
const YAHOO_PAUSE_MS = 500;

const yahooFinance = new YahooFinance();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WeeklyBar {
  date: string;
  close: number;
}

interface TriggerEvent {
  parentName: string;
  ticker: string;
  brand: string;
  date: string;
  yoyGrowthPct: number;
  correlation: number;
  stockReturnPct: number;
  spxReturnPct: number;
  alphaPct: number;
}

interface BrandStats {
  brand: string;
  events: number;
  wins: number;
  winRate: number;
  avgAlpha: number;
}

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

function priceAfterDays(
  bars: WeeklyBar[],
  startDate: string,
  days: number
): WeeklyBar | null {
  const start = nearestOnOrAfter(bars, startDate);
  if (!start) return null;
  const targetMs =
    new Date(`${start.date}T12:00:00`).getTime() + days * 24 * 60 * 60 * 1000;
  const targetDate = new Date(targetMs).toISOString().slice(0, 10);
  const byDate = nearestOnOrBefore(bars, targetDate);
  if (byDate && byDate.date >= start.date) return byDate;

  const startIdx = bars.findIndex((b) => b.date === start.date);
  if (startIdx < 0) return null;
  const exitIdx = startIdx + HOLD_WEEKS;
  return exitIdx < bars.length ? bars[exitIdx] : null;
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

/** Index of the weekly point nearest to ~52 weeks before series[i].date. */
function yearAgoIndex(series: TrendPoint[], i: number): number | null {
  if (i < YOY_LAG_WEEKS) return null;
  // Prefer exact weekly lag when the series is dense/regular.
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
  // Reject if more than ~3 weeks off the year-ago target.
  if (best.diff > 21 * 24 * 60 * 60 * 1000) return null;
  return best.idx;
}

/**
 * YoY structural-trend triggers for one brand.
 * ((Current 4w MA − Last-year 4w MA) / Last-year 4w MA) * 100 > 25
 * and baseline Pearson r > 0.15.
 */
function findYoYTriggers(
  series: TrendPoint[],
  stockByDate: Map<string, number>,
  brand: string
): { date: string; yoyGrowthPct: number; brand: string; correlation: number }[] {
  const triggers: {
    date: string;
    yoyGrowthPct: number;
    brand: string;
    correlation: number;
  }[] = [];

  // Need current MA window + a full year of history behind it.
  if (series.length < YOY_LAG_WEEKS + MA_WEEKS) return triggers;

  const correlation = correlationTrendVsStock(series, stockByDate);
  if (
    !Number.isFinite(correlation) ||
    Number.isNaN(correlation) ||
    correlation <= MIN_POSITIVE_CORR
  ) {
    return triggers;
  }

  for (let i = YOY_LAG_WEEKS + MA_WEEKS - 1; i < series.length; i++) {
    const currentMa = maEndingAt(series, i);
    const yIdx = yearAgoIndex(series, i);
    if (yIdx == null) continue;
    const lastYearMa = maEndingAt(series, yIdx);

    if (currentMa == null || lastYearMa == null) continue;
    // Guard divide-by-zero / tiny baselines.
    if (!Number.isFinite(lastYearMa) || Math.abs(lastYearMa) < 1e-6) continue;

    const yoyGrowthPct = ((currentMa - lastYearMa) / lastYearMa) * 100;
    if (!Number.isFinite(yoyGrowthPct)) continue;
    if (yoyGrowthPct <= YOY_GROWTH_THRESHOLD) continue;

    triggers.push({
      date: series[i].date,
      yoyGrowthPct: Math.round(yoyGrowthPct * 10) / 10,
      brand,
      correlation: Math.round(correlation * 100) / 100,
    });
  }

  return triggers;
}

/** Keep strongest YoY event per rolling ~90d window (per parent). */
function declusterTriggers<
  T extends { date: string; yoyGrowthPct: number },
>(triggers: T[]): T[] {
  const sorted = [...triggers].sort((a, b) => a.date.localeCompare(b.date));
  const deduped: T[] = [];
  for (const t of sorted) {
    const last = deduped[deduped.length - 1];
    if (!last) {
      deduped.push(t);
      continue;
    }
    const gapDays =
      (new Date(`${t.date}T12:00:00`).getTime() -
        new Date(`${last.date}T12:00:00`).getTime()) /
      (24 * 60 * 60 * 1000);
    if (gapDays >= HOLD_DAYS) {
      deduped.push(t);
    } else if (t.yoyGrowthPct > last.yoyGrowthPct) {
      deduped[deduped.length - 1] = t;
    }
  }
  return deduped;
}

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║      TurboFashion V4 YoY Trend Backtest (Quant Only)     ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];
  console.log(
    `Universe: ${parentCompanies.length} parents · ${brandNames.length} child brands`
  );
  console.log(
    `Rules: YoY 4w-MA search growth > ${YOY_GROWTH_THRESHOLD}% · Pearson r > ${MIN_POSITIVE_CORR}`
  );
  console.log(
    `Hold: ${HOLD_DAYS}d (~${HOLD_WEEKS}w) alpha vs ${SPX_TICKER} · no Q4 exclusion (YoY handles seasonality)`
  );
  console.log(
    `Yahoo pacing: sequential fetches with ${YAHOO_PAUSE_MS}ms delay between requests\n`
  );

  console.log("Fetching 5y Google Trends from Supabase…");
  const trendData = await fetchTrendHistory(brandNames, YEARS_BACK);
  if (trendData.length === 0) {
    throw new Error(
      "No trend rows — run npm run fetch:trends and ensure Supabase is configured."
    );
  }
  console.log(`  → ${trendData.length} weekly trend rows\n`);

  console.log(`Fetching historical data for ${SPX_TICKER}…`);
  const spxBars = await fetchSpxWeekly();
  console.log(`  → ${spxBars.length} SPX bars`);
  await sleep(YAHOO_PAUSE_MS);

  const events: TriggerEvent[] = [];
  const brandBuckets = new Map<
    string,
    { wins: number; total: number; alphaSum: number }
  >();

  console.log("\nFetching parent equity histories (sequential)…");
  for (let i = 0; i < parentCompanies.length; i++) {
    const parent = parentCompanies[i];
    const ticker = parent.ticker;
    console.log(
      `Fetching historical data for ${ticker}… (${i + 1}/${parentCompanies.length})`
    );

    let stockMap: Map<string, number>;
    try {
      stockMap = await fetchStockQuotes(ticker, YEARS_BACK);
    } catch (error) {
      console.log(
        `  SKIP ${ticker} (stock fetch failed: ${String(error).slice(0, 80)})`
      );
      if (i < parentCompanies.length - 1) await sleep(YAHOO_PAUSE_MS);
      continue;
    }

    const stockBars = mapToWeeklyBars(stockMap);
    if (stockBars.length < HOLD_WEEKS + 8) {
      console.log(`  SKIP ${ticker} (insufficient stock history)`);
      if (i < parentCompanies.length - 1) await sleep(YAHOO_PAUSE_MS);
      continue;
    }

    const rawTriggers: {
      date: string;
      yoyGrowthPct: number;
      brand: string;
      correlation: number;
    }[] = [];

    for (const brand of parent.childBrands) {
      const series = extractBrandSeries(trendData, brand);
      if (series.length < YOY_LAG_WEEKS + MA_WEEKS) {
        console.log(
          `  skip ${brand} — insufficient history (${series.length} pts)`
        );
        continue;
      }

      const brandTriggers = findYoYTriggers(series, stockMap, brand);
      if (brandTriggers.length === 0) {
        const corr = correlationTrendVsStock(series, stockMap);
        if (!Number.isFinite(corr) || corr <= MIN_POSITIVE_CORR) {
          console.log(
            `  skip ${brand} — unreliable / non-positive corr (r=${Number.isFinite(corr) ? corr.toFixed(2) : "n/a"})`
          );
        }
        continue;
      }
      rawTriggers.push(...brandTriggers);
    }

    const triggers = declusterTriggers(rawTriggers);
    let counted = 0;

    for (const trigger of triggers) {
      const entry = nearestOnOrAfter(stockBars, trigger.date);
      const exit = priceAfterDays(stockBars, trigger.date, HOLD_DAYS);
      const spxEntry = nearestOnOrAfter(spxBars, trigger.date);
      const spxExit = priceAfterDays(spxBars, trigger.date, HOLD_DAYS);
      if (!entry || !exit || !spxEntry || !spxExit) continue;
      if (exit.date <= entry.date || spxExit.date <= spxEntry.date) continue;

      const stockReturnPct = pctReturn(entry.close, exit.close);
      const spxReturnPct = pctReturn(spxEntry.close, spxExit.close);
      if (!Number.isFinite(stockReturnPct) || !Number.isFinite(spxReturnPct)) {
        continue;
      }
      const alphaPct =
        Math.round((stockReturnPct - spxReturnPct) * 10) / 10;

      events.push({
        parentName: parent.name,
        ticker: parent.ticker,
        brand: trigger.brand,
        date: trigger.date,
        yoyGrowthPct: trigger.yoyGrowthPct,
        correlation: trigger.correlation,
        stockReturnPct: Math.round(stockReturnPct * 10) / 10,
        spxReturnPct: Math.round(spxReturnPct * 10) / 10,
        alphaPct,
      });

      const bucket = brandBuckets.get(trigger.brand) ?? {
        wins: 0,
        total: 0,
        alphaSum: 0,
      };
      bucket.total += 1;
      bucket.alphaSum += alphaPct;
      if (alphaPct > 0) bucket.wins += 1;
      brandBuckets.set(trigger.brand, bucket);
      counted += 1;
    }

    console.log(`  → ${ticker}: ${counted} YoY events`);
    if (i < parentCompanies.length - 1) {
      await sleep(YAHOO_PAUSE_MS);
    }
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  const wins = events.filter((e) => e.alphaPct > 0).length;
  const winRate = events.length > 0 ? (wins / events.length) * 100 : 0;
  const avgAlpha =
    events.length > 0
      ? events.reduce((s, e) => s + e.alphaPct, 0) / events.length
      : 0;

  const brandStats: BrandStats[] = [...brandBuckets.entries()]
    .map(([brand, b]) => ({
      brand,
      events: b.total,
      wins: b.wins,
      winRate: b.total > 0 ? (b.wins / b.total) * 100 : 0,
      avgAlpha: b.total > 0 ? b.alphaSum / b.total : 0,
    }))
    .filter((b) => b.events >= 2)
    .sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return b.avgAlpha - a.avgAlpha;
    });

  const top3 = brandStats.slice(0, 3);

  console.log("\n┌──────────────────────────────────────────────────────────┐");
  console.log("│              V4 YOY TREND BACKTEST RESULTS               │");
  console.log("├──────────────────────────────────────────────────────────┤");
  console.log(
    `│  Total Events Found          ${pad(String(events.length), 26)}│`
  );
  console.log(
    `│  Overall Win Rate (α > 0)    ${pad(`${winRate.toFixed(1)}%  (${wins}/${events.length})`, 26)}│`
  );
  console.log(
    `│  Average 90-Day Alpha        ${pad(fmtPct(avgAlpha), 26)}│`
  );
  console.log("├──────────────────────────────────────────────────────────┤");
  console.log("│  Top 3 Most Predictable Brands (by win rate)             │");
  if (top3.length === 0) {
    console.log("│  (insufficient brand-level sample)                       │");
  } else {
    top3.forEach((b, i) => {
      const line = `${i + 1}. ${b.brand} — ${b.winRate.toFixed(0)}% WR · ${fmtPct(b.avgAlpha)} α · n=${b.events}`;
      console.log(`│  ${pad(line, 54)}│`);
    });
  }
  console.log("└──────────────────────────────────────────────────────────┘\n");

  const sample = [...events]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);
  if (sample.length > 0) {
    console.log("Recent sample events:");
    for (const e of sample) {
      console.log(
        `  ${e.date}  ${e.ticker.padEnd(6)} ${pad(e.brand, 18)} YoY ${fmtPct(e.yoyGrowthPct)}  r=${e.correlation.toFixed(2)}  stock ${fmtPct(e.stockReturnPct)}  SPX ${fmtPct(e.spxReturnPct)}  α ${fmtPct(e.alphaPct)}`
      );
    }
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFatal backtest error:", err);
    process.exit(1);
  });
