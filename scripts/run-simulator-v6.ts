/**
 * run-simulator-v6.ts — V6 Experimental Walk-Forward Simulator
 *
 * A/B test layer on top of V5: pyramiding (scale-in), partial trim at +40%,
 * and a 15% trailing stop-loss. Leaves scripts/run-simulator.ts (V5) untouched.
 *
 * Run with:
 *   npm run simulate:v6
 *   npx tsx --env-file=.env.local scripts/run-simulator-v6.ts
 */

import * as fs from "fs";
import path from "node:path";
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
/** First year of history is reserved for YoY baseline; trade the last 4y. */
const SIM_YEARS = 4;
const SPX_TICKER = "^GSPC";
const MA_WEEKS = 4;
const YOY_LAG_WEEKS = 52;
const YOY_GROWTH_THRESHOLD = 25;
const MIN_POSITIVE_CORR = 0.15;
/** Max hold to capture quarterly earnings catalyst. */
const HOLD_WEEKS = 13;
const HOLD_DAYS = 90;
/** Min weeks before allowing a YoY-crash early exit. */
const MIN_HOLD_WEEKS_BEFORE_EARLY_EXIT = 3;
/** Early exit when held-brand YoY search growth turns negative. */
const EARLY_EXIT_YOY_THRESHOLD = 0;
/** Post-sell cooldown before re-buying the same brand (~4 weeks). */
const COOLDOWN_WEEKS = 4;
const COOLDOWN_DAYS = 30;
/** Hard cap: never put more than this fraction of portfolio into one name. */
const MAX_POSITION_PCT = 0.3;
/** Round-trip trading friction: 0.1% adverse price on each side. */
const SLIPPAGE_RATE = 0.001;
/** V6: minimum idle cash required to pyramid / scale in. */
const MIN_SCALE_IN_CASH = 1_000;
/** V6: take partial profits once unrealized gain hits this multiple of entry. */
const TRIM_GAIN_MULTIPLE = 1.4;
/** V6: full exit if price falls this fraction below the peak. */
const TRAILING_STOP_FRACTION = 0.85;
const YAHOO_PAUSE_MS = 500;

const STARTING_CAPITAL = 10_000;
/** Flat annual risk-free rate: Sharpe + idle T-Bill yield (weekly = / 52). */
const ANNUAL_RFR = 0.04;
const WEEKLY_RFR = ANNUAL_RFR / 52;

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
  /** First purchase date (for Days Held reporting). */
  originalEntryDate: string;
  /** Timer clock for the 90-day max hold (reset on pyramid scale-in). */
  entryDate: string;
  entryWeekIdx: number;
  /** Blended average cost basis per share. */
  entryPrice: number;
  shares: number;
  cost: number;
  buyFee: number;
  yoyGrowthPct: number;
  correlation: number;
  convictionScore: number;
  /** Peak mark since entry (for trailing stop). */
  highestPriceReached: number;
  /** True after a +40% partial trim has been taken. */
  hasTrimmed?: boolean;
}

type ExitReason =
  | "max_hold"
  | "early_yoy"
  | "forced_eod"
  | "stop_loss"
  | "partial_trim";

interface ClosedTrade {
  ticker: string;
  brand: string;
  entryDate: string;
  exitDate: string;
  daysHeld: number;
  entryPrice: number;
  exitPrice: number;
  cost: number;
  proceeds: number;
  pnl: number;
  returnPct: number;
  spxReturnPct: number;
  alphaPct: number;
  yoyGrowthPct: number;
  correlation: number;
  feesPaid: number;
  exitReason: ExitReason;
}

interface WeekTrigger {
  brand: string;
  parentName: string;
  ticker: string;
  date: string;
  yoyGrowthPct: number;
  correlation: number;
  convictionScore: number;
}

interface UltimateReportSummary {
  startingCapital: number;
  finalPortfolioValue: number;
  strategyReturnPct: number;
  spxReturnPct: number;
  alphaPct: number;
  portfolioBeta: number | null;
  sharpeAnn: number | null;
  totalTrades: number;
  winRatePct: number;
  totalInterestEarned: number;
  totalFeesPaid: number;
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

/** Sample variance (n − 1). Returns null if undefined / degenerate. */
function sampleVariance(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m == null) return null;
  const sumSq = values.reduce((s, v) => s + (v - m) ** 2, 0);
  const v = sumSq / (values.length - 1);
  return Number.isFinite(v) ? v : null;
}

/** Sample covariance (n − 1), aligned on min length. */
function sampleCovariance(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const xs = x.slice(0, n);
  const ys = y.slice(0, n);
  const mx = mean(xs);
  const my = mean(ys);
  if (mx == null || my == null) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (xs[i] - mx) * (ys[i] - my);
  }
  const cov = sum / (n - 1);
  return Number.isFinite(cov) ? cov : null;
}

/**
 * Beta = Cov(portfolio, market) / Var(market).
 * Expects decimal weekly returns (0.01 = 1%).
 */
function calculateBeta(
  portfolioReturns: number[],
  marketReturns: number[]
): number | null {
  if (portfolioReturns.length === 0 || marketReturns.length === 0) return null;
  const cov = sampleCovariance(portfolioReturns, marketReturns);
  const varM = sampleVariance(marketReturns);
  if (cov == null || varM == null || varM === 0) return null;
  const beta = cov / varM;
  return Number.isFinite(beta) ? beta : null;
}

/**
 * Annualized Sharpe =
 * ((avg weekly return − weekly RFR) / stdev(weekly returns)) × √52
 * with weekly RFR = ANNUAL_RFR / 52.
 */
function calculateAnnualizedSharpe(portfolioReturns: number[]): number | null {
  if (portfolioReturns.length < 2) return null;
  const avg = mean(portfolioReturns);
  const varP = sampleVariance(portfolioReturns);
  if (avg == null || varP == null) return null;
  const std = Math.sqrt(varP);
  if (!Number.isFinite(std) || std === 0) return null;
  const sharpe = ((avg - WEEKLY_RFR) / std) * Math.sqrt(52);
  return Number.isFinite(sharpe) ? sharpe : null;
}

function fmtRatio(n: number | null, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
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

/** T+1 fill: first bar strictly after the signal date (weekend lag). */
function nextTradingBar(
  bars: WeeklyBar[],
  signalDate: string
): WeeklyBar | null {
  const target = normalizeDateString(signalDate);
  for (const bar of bars) {
    if (bar.date > target) return bar;
  }
  return null;
}

function applyEntrySlippage(rawPrice: number): number {
  return rawPrice * (1 + SLIPPAGE_RATE);
}

function applyExitSlippage(rawPrice: number): number {
  return rawPrice * (1 - SLIPPAGE_RATE);
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

/** Conviction = correlation × YoY growth (both already above V4 thresholds). */
function convictionScore(yoyGrowthPct: number, correlation: number): number {
  return correlation * yoyGrowthPct;
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

function seriesIndexOnOrBefore(
  brand: BrandSeries,
  weekDate: string
): number | null {
  const direct = brand.dateIndex.get(weekDate);
  if (direct != null) return direct;
  for (let j = brand.series.length - 1; j >= 0; j--) {
    if (normalizeDateString(brand.series[j].date) <= weekDate) return j;
  }
  return null;
}

function findBrandSeries(
  brands: BrandSeries[],
  brand: string,
  ticker: string
): BrandSeries | undefined {
  return brands.find((b) => b.brand === brand && b.ticker === ticker);
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

function markToMarket(
  open: OpenPosition[],
  stockBarsByTicker: Map<string, WeeklyBar[]>,
  weekDate: string
): number {
  let value = 0;
  for (const pos of open) {
    const bars = stockBarsByTicker.get(pos.ticker);
    if (!bars) {
      value += pos.cost;
      continue;
    }
    const bar =
      nearestOnOrBefore(bars, weekDate) ?? nearestOnOrAfter(bars, weekDate);
    value += bar ? pos.shares * bar.close : pos.cost;
  }
  return value;
}

function closePosition(input: {
  pos: OpenPosition;
  exitBar: WeeklyBar;
  spxBars: WeeklyBar[];
  exitReason: ExitReason;
  /** Defaults to full position. */
  sharesToSell?: number;
  /** Cost basis allocated to this exit slice. */
  costSlice?: number;
  /** Entry fees allocated to this exit slice. */
  buyFeeSlice?: number;
}): { trade: ClosedTrade; sellFee: number; netProceeds: number } {
  const { pos, exitBar, spxBars, exitReason } = input;
  const sharesToSell = input.sharesToSell ?? pos.shares;
  const costSlice = input.costSlice ?? pos.cost;
  const buyFeeSlice = input.buyFeeSlice ?? pos.buyFee;

  const exitPrice = applyExitSlippage(exitBar.close);
  const proceeds = sharesToSell * exitPrice;
  const sellFee = sharesToSell * exitBar.close * SLIPPAGE_RATE;
  const feesPaid = buyFeeSlice + sellFee;
  const pnl = proceeds - costSlice - buyFeeSlice;
  const invested = costSlice + buyFeeSlice;
  const returnPct = pctReturn(invested, proceeds);
  const daysHeld = Math.max(
    0,
    Math.round(daysBetween(pos.originalEntryDate, exitBar.date))
  );

  const spxEntry = nearestOnOrAfter(spxBars, pos.originalEntryDate);
  const spxExit = nearestOnOrBefore(spxBars, exitBar.date);
  const spxReturnPct =
    spxEntry && spxExit ? pctReturn(spxEntry.close, spxExit.close) : NaN;
  const alphaPct =
    Number.isFinite(returnPct) && Number.isFinite(spxReturnPct)
      ? Math.round((returnPct - spxReturnPct) * 10) / 10
      : NaN;

  return {
    sellFee,
    netProceeds: proceeds,
    trade: {
      ticker: pos.ticker,
      brand: pos.brand,
      entryDate: pos.originalEntryDate,
      exitDate: exitBar.date,
      daysHeld,
      entryPrice: pos.entryPrice,
      exitPrice,
      cost: costSlice,
      proceeds,
      pnl,
      returnPct,
      spxReturnPct,
      alphaPct,
      yoyGrowthPct: pos.yoyGrowthPct,
      correlation: pos.correlation,
      feesPaid,
      exitReason,
    },
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function fmtCsvNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "";
  return n.toFixed(digits);
}

function fmtCsvUsd(n: number): string {
  if (!Number.isFinite(n)) return "";
  return `$${n.toFixed(2)}`;
}

function fmtCsvPct(n: number): string {
  if (!Number.isFinite(n)) return "";
  return `${n.toFixed(2)}%`;
}

/** Ultimate Data Report: summary block + full trade breakdown. */
function exportUltimateReportCsv(
  trades: ClosedTrade[],
  summary: UltimateReportSummary,
  outPath: string
): void {
  const lines: string[] = [
    "=== TURBO FASHION INDEX: V6 EXPERIMENTAL ===",
    `Starting Capital:, ${fmtCsvUsd(summary.startingCapital)}`,
    `Final Portfolio Value:, ${fmtCsvUsd(summary.finalPortfolioValue)}`,
    `V6 Strategy Return:, ${fmtCsvPct(summary.strategyReturnPct)}`,
    `S&P 500 Benchmark:, ${fmtCsvPct(summary.spxReturnPct)}`,
    `Alpha Generated:, ${fmtCsvPct(summary.alphaPct)}`,
    `Portfolio Beta:, ${
      summary.portfolioBeta != null && Number.isFinite(summary.portfolioBeta)
        ? summary.portfolioBeta.toFixed(2)
        : "n/a"
    }`,
    `Sharpe Ratio (Ann.):, ${
      summary.sharpeAnn != null && Number.isFinite(summary.sharpeAnn)
        ? summary.sharpeAnn.toFixed(2)
        : "n/a"
    }`,
    `Total Trades Executed:, ${summary.totalTrades}`,
    `Portfolio Win Rate:, ${fmtCsvPct(summary.winRatePct)}`,
    `Total T-Bill Interest Earned:, ${fmtCsvUsd(summary.totalInterestEarned)}`,
    `Total Trading Friction (Fees Paid):, ${fmtCsvUsd(summary.totalFeesPaid)}`,
    "",
    "=== INDIVIDUAL TRADE BREAKDOWN ===",
    [
      "Entry Date",
      "Exit Date",
      "Days Held",
      "Ticker",
      "Brand",
      "YoY Growth (%)",
      "Correlation",
      "Position Size ($)",
      "Fees Paid ($)",
      "Return (%)",
      "Alpha (%)",
      "PnL ($)",
    ].join(","),
  ];

  const rows = [...trades]
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
    .map((t) =>
      [
        t.entryDate,
        t.exitDate,
        String(t.daysHeld),
        csvEscape(t.ticker),
        csvEscape(t.brand),
        fmtCsvNumber(t.yoyGrowthPct, 1),
        fmtCsvNumber(t.correlation, 2),
        fmtCsvNumber(t.cost, 2),
        fmtCsvNumber(t.feesPaid, 2),
        fmtCsvNumber(t.returnPct, 2),
        fmtCsvNumber(t.alphaPct, 2),
        fmtCsvNumber(t.pnl, 2),
      ].join(",")
    );

  fs.writeFileSync(outPath, [...lines, ...rows].join("\n") + "\n", "utf8");
}

/**
 * Proportional conviction weights with a hard 30% portfolio cap per name.
 * Leftover cash after capping is retained as a risk buffer.
 */
function allocateByConviction(
  buyable: { signal: WeekTrigger; entryBar: WeeklyBar }[],
  cash: number,
  portfolioValue: number
): { signal: WeekTrigger; entryBar: WeeklyBar; allocation: number }[] {
  if (buyable.length === 0 || cash <= 0 || portfolioValue <= 0) return [];

  const maxPerPos = MAX_POSITION_PCT * portfolioValue;
  const scored = buyable.map((b) => ({
    ...b,
    score: Math.max(b.signal.convictionScore, 0),
  }));
  const totalScore = scored.reduce((s, b) => s + b.score, 0);
  if (totalScore <= 0) return [];

  // Highest conviction first so caps favor the best setups when cash is tight.
  scored.sort((a, b) => b.score - a.score);

  const out: { signal: WeekTrigger; entryBar: WeeklyBar; allocation: number }[] =
    [];
  let remainingCash = cash;

  for (const item of scored) {
    if (remainingCash < 1) break;
    const raw = cash * (item.score / totalScore);
    const allocation = Math.min(raw, maxPerPos, remainingCash);
    if (allocation < 1) continue;
    out.push({
      signal: item.signal,
      entryBar: item.entryBar,
      allocation,
    });
    remainingCash -= allocation;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main walk-forward loop
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     === TURBO FASHION INDEX: V6 EXPERIMENTAL ===         ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];
  console.log(
    `Universe: ${parentCompanies.length} parents · ${brandNames.length} child brands`
  );
  console.log(
    `Capital: ${fmtUsd(STARTING_CAPITAL)} · Sizing: conviction (r × YoY) · max ${MAX_POSITION_PCT * 100}% / name`
  );
  console.log(
    `Entry: YoY > ${YOY_GROWTH_THRESHOLD}% · r > ${MIN_POSITIVE_CORR}`
  );
  console.log(
    `Exit: trim @ +${(TRIM_GAIN_MULTIPLE - 1) * 100}% · trail stop −${(1 - TRAILING_STOP_FRACTION) * 100}% from peak · else max ${HOLD_DAYS}d`
  );
  console.log(
    `Cooldown: no re-buy of same brand for ${COOLDOWN_DAYS}d (~${COOLDOWN_WEEKS}w) after sell`
  );
  console.log(
    `V6 tactics: pyramid scale-in (50% cash if ≥ ${fmtUsd(MIN_SCALE_IN_CASH)}) · partial trim · trailing stop`
  );
  console.log(
    `Idle cash: ${ANNUAL_RFR * 100}% T-Bill · Friction: ${SLIPPAGE_RATE * 100}% per side\n`
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
  let earlyExits = 0;
  let stopLossExits = 0;
  let partialTrims = 0;
  let pyramidAdds = 0;
  let totalInterestEarned = 0;
  let totalFeesPaid = 0;
  /** Child brand → last sell date (blocks re-entry for cooldown window). */
  const lastSoldDate: Record<string, string> = {};

  const portfolioWeeklyReturns: number[] = [];
  const marketWeeklyReturns: number[] = [];
  let previousPortfolioValue: number | null = null;
  let previousMarketValue: number | null = null;

  for (let w = 0; w < timeline.length; w++) {
    const weekDate = timeline[w];
    const isLastWeek = w === timeline.length - 1;

    // ------------------------------------------------------------------
    // START OF WEEK: seed previous values for WoW return tracking
    // ------------------------------------------------------------------
    const startPortfolioValue =
      cash + markToMarket(open, stockBarsByTicker, weekDate);
    const startSpxBar =
      nearestOnOrBefore(spxBars, weekDate) ??
      nearestOnOrAfter(spxBars, weekDate);
    if (previousPortfolioValue == null && startPortfolioValue > 0) {
      previousPortfolioValue = startPortfolioValue;
    }
    if (
      previousMarketValue == null &&
      startSpxBar != null &&
      startSpxBar.close > 0
    ) {
      previousMarketValue = startSpxBar.close;
    }

    // ------------------------------------------------------------------
    // IDLE CASH: accrue weekly T-Bill yield (ANNUAL_RFR / 52)
    // ------------------------------------------------------------------
    if (cash > 0) {
      const interest = cash * WEEKLY_RFR;
      cash += interest;
      totalInterestEarned += interest;
    }

    // ------------------------------------------------------------------
    // SELL EVAL: peak track → partial trim → trailing stop → max/early exit
    // ------------------------------------------------------------------
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const bars = stockBarsByTicker.get(pos.ticker);
      if (!bars) continue;
      const pxBar =
        nearestOnOrBefore(bars, weekDate) ?? nearestOnOrAfter(bars, weekDate);
      if (!pxBar) continue;
      const currentPrice = pxBar.close;

      // Track peak for trailing stop.
      if (currentPrice > pos.highestPriceReached) {
        pos.highestPriceReached = currentPrice;
      }

      // --- Partial trim: +40% from blended entry, once ---
      if (
        !isLastWeek &&
        !pos.hasTrimmed &&
        currentPrice >= pos.entryPrice * TRIM_GAIN_MULTIPLE &&
        pos.shares > 0
      ) {
        const sharesToSell = pos.shares * 0.5;
        const costSlice = pos.cost * 0.5;
        const buyFeeSlice = pos.buyFee * 0.5;
        const { trade, sellFee, netProceeds } = closePosition({
          pos,
          exitBar: pxBar,
          spxBars,
          exitReason: "partial_trim",
          sharesToSell,
          costSlice,
          buyFeeSlice,
        });
        cash += netProceeds;
        totalFeesPaid += sellFee;
        closed.push(trade);
        pos.shares -= sharesToSell;
        pos.cost -= costSlice;
        pos.buyFee -= buyFeeSlice;
        pos.hasTrimmed = true;
        partialTrims += 1;
      }

      // --- Trailing stop: −15% from peak ---
      if (
        !isLastWeek &&
        currentPrice < pos.highestPriceReached * TRAILING_STOP_FRACTION
      ) {
        const { trade, sellFee, netProceeds } = closePosition({
          pos,
          exitBar: pxBar,
          spxBars,
          exitReason: "stop_loss",
        });
        cash += netProceeds;
        totalFeesPaid += sellFee;
        closed.push(trade);
        lastSoldDate[pos.brand] = weekDate;
        stopLossExits += 1;
        open.splice(i, 1);
        continue;
      }

      // --- Classic exits: max hold / early YoY / force EOD ---
      const weeksHeld = w - pos.entryWeekIdx;
      const maxHoldReached =
        weeksHeld >= HOLD_WEEKS ||
        daysBetween(pos.entryDate, weekDate) >= HOLD_DAYS;

      let earlyYoYCrash = false;
      if (
        !maxHoldReached &&
        !isLastWeek &&
        weeksHeld >= MIN_HOLD_WEEKS_BEFORE_EARLY_EXIT
      ) {
        const brandSeries = findBrandSeries(brands, pos.brand, pos.ticker);
        if (brandSeries) {
          const idx = seriesIndexOnOrBefore(brandSeries, weekDate);
          if (idx != null) {
            const liveYoY = yoyGrowthAt(brandSeries.series, idx);
            if (liveYoY != null && liveYoY < EARLY_EXIT_YOY_THRESHOLD) {
              earlyYoYCrash = true;
            }
          }
        }
      }

      const shouldSell = isLastWeek || maxHoldReached || earlyYoYCrash;
      if (!shouldSell) continue;

      const exitReason: ExitReason =
        isLastWeek && !maxHoldReached && !earlyYoYCrash
          ? "forced_eod"
          : earlyYoYCrash
            ? "early_yoy"
            : "max_hold";

      const { trade, sellFee, netProceeds } = closePosition({
        pos,
        exitBar: pxBar,
        spxBars,
        exitReason,
      });
      cash += netProceeds;
      totalFeesPaid += sellFee;
      closed.push(trade);
      lastSoldDate[pos.brand] = weekDate;
      if (exitReason === "early_yoy") earlyExits += 1;
      open.splice(i, 1);
    }

    if (!isLastWeek) {
      // ------------------------------------------------------------------
      // SCAN: V4 entry triggers as of this week (no look-ahead)
      // ------------------------------------------------------------------
      const rawTriggers: WeekTrigger[] = [];
      for (const b of brands) {
        const idx = seriesIndexOnOrBefore(b, weekDate);
        if (idx == null) continue;

        const yoy = yoyGrowthAt(b.series, idx);
        if (yoy == null || yoy <= YOY_GROWTH_THRESHOLD) continue;

        const stockBars = stockBarsByTicker.get(b.ticker)!;
        const corr = correlationAsOf(b.series, stockBars, weekDate);
        if (!Number.isFinite(corr) || corr <= MIN_POSITIVE_CORR) continue;

        const score = convictionScore(yoy, corr);
        rawTriggers.push({
          brand: b.brand,
          parentName: b.parentName,
          ticker: b.ticker,
          date: b.series[idx].date,
          yoyGrowthPct: yoy,
          correlation: Math.round(corr * 100) / 100,
          convictionScore: Math.round(score * 10) / 10,
        });
      }

      const byTicker = new Map<string, WeekTrigger>();
      for (const t of rawTriggers) {
        const prev = byTicker.get(t.ticker);
        if (!prev || t.convictionScore > prev.convictionScore) {
          byTicker.set(t.ticker, t);
        }
      }

      const candidates = [...byTicker.values()].sort(
        (a, b) => b.convictionScore - a.convictionScore
      );

      // ------------------------------------------------------------------
      // BUY / PYRAMID (scale-in on re-trigger)
      // ------------------------------------------------------------------
      const heldByTicker = new Map(open.map((p) => [p.ticker, p]));
      const buyable: { signal: WeekTrigger; entryBar: WeeklyBar }[] = [];

      for (const signal of candidates) {
        const held = heldByTicker.get(signal.ticker);
        if (held) {
          // Pyramid: scale in with 50% of idle cash when ≥ $1,000 available.
          if (cash >= MIN_SCALE_IN_CASH) {
            const bars = stockBarsByTicker.get(signal.ticker);
            const entryBar = bars
              ? nextTradingBar(bars, weekDate) ??
                nearestOnOrAfter(bars, weekDate)
              : null;
            if (entryBar && entryBar.close > 0) {
              const allocation = cash * 0.5;
              const fillPrice = applyEntrySlippage(entryBar.close);
              const buyFee = allocation * SLIPPAGE_RATE;
              const totalDebit = allocation + buyFee;
              if (totalDebit <= cash + 1e-9) {
                const newShares = allocation / fillPrice;
                const oldShares = held.shares;
                const totalShares = oldShares + newShares;
                held.entryPrice =
                  (oldShares * held.entryPrice + newShares * fillPrice) /
                  totalShares;
                held.shares = totalShares;
                held.cost += allocation;
                held.buyFee += buyFee;
                held.entryWeekIdx = w;
                held.entryDate = weekDate;
                held.yoyGrowthPct = signal.yoyGrowthPct;
                held.correlation = signal.correlation;
                held.convictionScore = signal.convictionScore;
                if (fillPrice > held.highestPriceReached) {
                  held.highestPriceReached = fillPrice;
                }
                if (held.brand !== signal.brand) held.brand = signal.brand;
                cash -= totalDebit;
                totalFeesPaid += buyFee;
                pyramidAdds += 1;
              }
            }
          }
          continue;
        }

        const soldOn = lastSoldDate[signal.brand];
        if (soldOn != null) {
          const daysSinceSell = daysBetween(soldOn, weekDate);
          if (daysSinceSell <= COOLDOWN_DAYS) continue;
        }

        const bars = stockBarsByTicker.get(signal.ticker);
        if (!bars) continue;
        const entryBar =
          nextTradingBar(bars, weekDate) ?? nearestOnOrAfter(bars, weekDate);
        if (!entryBar || entryBar.close <= 0) continue;
        buyable.push({ signal, entryBar });
      }

      if (buyable.length > 0 && cash > 0) {
        const portfolioValue =
          cash + markToMarket(open, stockBarsByTicker, weekDate);
        const deployable = cash / (1 + SLIPPAGE_RATE);
        const allocations = allocateByConviction(
          buyable,
          deployable,
          portfolioValue
        );

        for (const { signal, entryBar, allocation } of allocations) {
          const entryPrice = applyEntrySlippage(entryBar.close);
          const buyFee = allocation * SLIPPAGE_RATE;
          const totalDebit = allocation + buyFee;
          if (totalDebit > cash + 1e-9) continue;

          const shares = allocation / entryPrice;
          cash -= totalDebit;
          totalFeesPaid += buyFee;
          open.push({
            ticker: signal.ticker,
            brand: signal.brand,
            parentName: signal.parentName,
            originalEntryDate: entryBar.date,
            entryDate: entryBar.date,
            entryWeekIdx: w,
            entryPrice,
            shares,
            cost: allocation,
            buyFee,
            yoyGrowthPct: signal.yoyGrowthPct,
            correlation: signal.correlation,
            convictionScore: signal.convictionScore,
            highestPriceReached: entryPrice,
            hasTrimmed: false,
          });
          heldByTicker.set(signal.ticker, open[open.length - 1]);
          buysExecuted += 1;
        }
      }
    }

    // ------------------------------------------------------------------
    // END OF WEEK: WoW % change → weekly return series (decimal)
    // ------------------------------------------------------------------
    const endPortfolioValue =
      cash + markToMarket(open, stockBarsByTicker, weekDate);
    const endSpxBar =
      nearestOnOrBefore(spxBars, weekDate) ??
      nearestOnOrAfter(spxBars, weekDate);

    if (
      previousPortfolioValue != null &&
      previousPortfolioValue > 0 &&
      Number.isFinite(endPortfolioValue)
    ) {
      portfolioWeeklyReturns.push(
        (endPortfolioValue - previousPortfolioValue) / previousPortfolioValue
      );
      previousPortfolioValue = endPortfolioValue;
    }

    if (
      previousMarketValue != null &&
      previousMarketValue > 0 &&
      endSpxBar != null &&
      Number.isFinite(endSpxBar.close) &&
      endSpxBar.close > 0
    ) {
      marketWeeklyReturns.push(
        (endSpxBar.close - previousMarketValue) / previousMarketValue
      );
      previousMarketValue = endSpxBar.close;
    }
  }

  // Safety: any leftover open positions
  if (open.length > 0) {
    const lastDate = timeline[timeline.length - 1];
    for (const pos of open) {
      const bars = stockBarsByTicker.get(pos.ticker);
      const exitBar = bars
        ? nearestOnOrBefore(bars, lastDate) ?? bars[bars.length - 1]
        : null;
      if (!exitBar) continue;
      const { trade, sellFee, netProceeds } = closePosition({
        pos,
        exitBar,
        spxBars,
        exitReason: "forced_eod",
      });
      cash += netProceeds;
      totalFeesPaid += sellFee;
      closed.push(trade);
      lastSoldDate[pos.brand] = lastDate;
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
  const portfolioAlphaPct =
    Number.isFinite(strategyReturnPct) && Number.isFinite(spxReturnPct)
      ? strategyReturnPct - spxReturnPct
      : NaN;

  const wins = closed.filter((t) => t.pnl > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

  const alphas = closed
    .map((t) => t.alphaPct)
    .filter((a) => Number.isFinite(a));
  const avgTradeAlpha =
    alphas.length > 0
      ? alphas.reduce((s, a) => s + a, 0) / alphas.length
      : NaN;

  const portfolioBeta = calculateBeta(
    portfolioWeeklyReturns,
    marketWeeklyReturns
  );
  const sharpeAnn = calculateAnnualizedSharpe(portfolioWeeklyReturns);

  console.log("┌──────────────────────────────────────────────────────────┐");
  console.log("│     === TURBO FASHION INDEX: V6 EXPERIMENTAL ===         │");
  console.log("├──────────────────────────────────────────────────────────┤");
  console.log(
    `│  Starting Capital            ${pad(fmtUsd(STARTING_CAPITAL), 26)}│`
  );
  console.log(
    `│  Final Portfolio Value       ${pad(fmtUsd(finalValue), 26)}│`
  );
  console.log(
    `│  V6 Strategy Return          ${pad(fmtPct(strategyReturnPct), 26)}│`
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
  console.log(
    `│  Average Trade Alpha         ${pad(fmtPct(avgTradeAlpha), 26)}│`
  );
  console.log(
    `│  Portfolio Beta              ${pad(fmtRatio(portfolioBeta, 2), 26)}│`
  );
  console.log(
    `│  Sharpe Ratio (Ann.)         ${pad(fmtRatio(sharpeAnn, 2), 26)}│`
  );
  console.log(
    `│  T-Bill Interest Earned      ${pad(fmtUsd(totalInterestEarned), 26)}│`
  );
  console.log(
    `│  Trading Friction (Fees)     ${pad(fmtUsd(totalFeesPaid), 26)}│`
  );
  console.log("├──────────────────────────────────────────────────────────┤");
  console.log(
    `│  Period                      ${pad(`${timeline[0]} → ${simEnd}`, 26)}│`
  );
  console.log(
    `│  Early YoY Exits             ${pad(String(earlyExits), 26)}│`
  );
  console.log(
    `│  Stop-Loss Exits             ${pad(String(stopLossExits), 26)}│`
  );
  console.log(
    `│  Partial Trims               ${pad(String(partialTrims), 26)}│`
  );
  console.log(
    `│  Pyramid Scale-Ins           ${pad(String(pyramidAdds), 26)}│`
  );
  console.log(
    `│  vs Benchmark (portfolio α)  ${pad(
      Number.isFinite(portfolioAlphaPct) ? fmtPct(portfolioAlphaPct) : "n/a",
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
      const tag =
        t.exitReason === "early_yoy"
          ? " (early YoY)"
          : t.exitReason === "forced_eod"
            ? " (forced)"
            : t.exitReason === "stop_loss"
              ? " (Stop-Loss)"
              : t.exitReason === "partial_trim"
                ? " (Trim)"
                : "";
      console.log(
        `  ${t.entryDate}→${t.exitDate}  ${t.ticker.padEnd(6)} ${pad(t.brand, 16)} ${fmtPct(t.returnPct)}  α ${fmtPct(t.alphaPct)}  PnL ${fmtUsd(t.pnl)}${tag}`
      );
    }
    console.log("");
  }

  const tradeLogPath = path.join(process.cwd(), "simulator_v6_trades.csv");
  exportUltimateReportCsv(
    closed,
    {
      startingCapital: STARTING_CAPITAL,
      finalPortfolioValue: finalValue,
      strategyReturnPct,
      spxReturnPct,
      alphaPct: portfolioAlphaPct,
      portfolioBeta,
      sharpeAnn,
      totalTrades: buysExecuted,
      winRatePct: winRate,
      totalInterestEarned,
      totalFeesPaid,
    },
    tradeLogPath
  );
  console.log("📊 Full trade log exported to simulator_v6_trades.csv");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFatal simulator error:", err);
    process.exit(1);
  });
