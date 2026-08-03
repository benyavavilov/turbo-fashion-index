/**
 * run-simulator.ts — V5 Walk-Forward Portfolio Simulator
 *
 * Hybrid Capital Allocation + Rolling Window path-dependency batch:
 * 20% max position size, opportunity-cost replacement exits, T-Bill yield,
 * and shifts [0,1,2,4,8,12,26] weeks to test consistency across start dates.
 *
 * Run with:
 *   npm run simulate
 *   npx tsx --env-file=.env.local scripts/run-simulator.ts
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
/** Hard cap: a single trade never exceeds this fraction of total portfolio. */
const MAX_POSITION_PCT = 0.2;
/**
 * Opportunity-cost replacement: new trigger YoY must beat weakest held YoY
 * by at least this many percentage points (e.g. +40% vs +5% → gap 35).
 */
const OPPORTUNITY_YOY_GAP = 15;
/** Skip / replace only when deployable cash is below this fraction of the 20% slot. */
const CASH_STARVED_FRACTION = 0.1;
/** Round-trip trading friction: 0.1% adverse price on each side. */
const SLIPPAGE_RATE = 0.001;
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
  /** Timer clock for the 90-day max hold (reset by Rolling Catalyst). */
  entryDate: string;
  entryWeekIdx: number;
  entryPrice: number;
  shares: number;
  cost: number;
  buyFee: number;
  yoyGrowthPct: number;
  correlation: number;
  convictionScore: number;
}

type ExitReason =
  | "max_hold"
  | "early_yoy"
  | "forced_eod"
  | "opportunity_replace";

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
  /** Present when exitReason === opportunity_replace. */
  replacedByBrand?: string;
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
  replacedByBrand?: string;
}): { trade: ClosedTrade; sellFee: number; netProceeds: number } {
  const { pos, exitBar, spxBars, exitReason, replacedByBrand } = input;
  const exitPrice = applyExitSlippage(exitBar.close);
  const proceeds = pos.shares * exitPrice;
  const sellFee = pos.shares * exitBar.close * SLIPPAGE_RATE;
  const feesPaid = pos.buyFee + sellFee;
  const pnl = proceeds - pos.cost - pos.buyFee;
  const invested = pos.cost + pos.buyFee;
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
      cost: pos.cost,
      proceeds,
      pnl,
      returnPct,
      spxReturnPct,
      alphaPct,
      yoyGrowthPct: pos.yoyGrowthPct,
      correlation: pos.correlation,
      feesPaid,
      exitReason,
      replacedByBrand,
    },
  };
}

function exitReasonLabel(t: ClosedTrade): string {
  switch (t.exitReason) {
    case "early_yoy":
      return "Early YoY crash";
    case "forced_eod":
      return "Forced end-of-sim";
    case "opportunity_replace":
      return t.replacedByBrand
        ? `Replaced by stronger signal (${t.replacedByBrand})`
        : "Replaced by stronger signal";
    case "max_hold":
    default:
      return "Max hold (90d)";
  }
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
    "=== TURBO FASHION INDEX: ULTIMATE SIMULATION REPORT ===",
    `Starting Capital:, ${fmtCsvUsd(summary.startingCapital)}`,
    `Final Portfolio Value:, ${fmtCsvUsd(summary.finalPortfolioValue)}`,
    `V5 Hybrid Strategy Return:, ${fmtCsvPct(summary.strategyReturnPct)}`,
    `S&P 500 Benchmark:, ${fmtCsvPct(summary.spxReturnPct)}`,
    `Alpha Generated:, ${fmtCsvPct(summary.alphaPct)}`,
    `Max Position Size:, ${MAX_POSITION_PCT * 100}% of portfolio`,
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
      "Exit Reason",
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
        csvEscape(exitReasonLabel(t)),
      ].join(",")
    );

  fs.writeFileSync(outPath, [...lines, ...rows].join("\n") + "\n", "utf8");
}

/**
 * Live YoY search growth for an open position as of weekDate (null if N/A).
 */
function liveYoYForPosition(
  pos: OpenPosition,
  brands: BrandSeries[],
  weekDate: string
): number | null {
  const brandSeries = findBrandSeries(brands, pos.brand, pos.ticker);
  if (!brandSeries) return null;
  const idx = seriesIndexOnOrBefore(brandSeries, weekDate);
  if (idx == null) return null;
  return yoyGrowthAt(brandSeries.series, idx);
}

/**
 * Hybrid Capital Allocation (Solution A):
 * Each new trade is sized to min(available cash, 20% of total portfolio value).
 * No full-cash sweep across triggers.
 */
function sizeHybridAllocation(
  cash: number,
  portfolioValue: number
): number {
  if (cash <= 0 || portfolioValue <= 0) return 0;
  const maxAllocation = portfolioValue * MAX_POSITION_PCT;
  const deployable = cash / (1 + SLIPPAGE_RATE);
  return Math.min(maxAllocation, deployable);
}

function isCashStarved(cash: number, portfolioValue: number): boolean {
  if (portfolioValue <= 0) return true;
  const maxAllocation = portfolioValue * MAX_POSITION_PCT;
  const deployable = cash / (1 + SLIPPAGE_RATE);
  return deployable < Math.max(1, maxAllocation * CASH_STARVED_FRACTION);
}

// ---------------------------------------------------------------------------
// Single-run walk-forward (callable with a shifted start index)
// ---------------------------------------------------------------------------

interface SimulationHistory {
  brands: BrandSeries[];
  spxBars: WeeklyBar[];
  stockBarsByTicker: Map<string, WeeklyBar[]>;
}

interface SimulationResult {
  strategyReturn: number;
  benchmarkReturn: number;
  winRate: number;
  beta: number | null;
  sharpeAnn: number | null;
  totalTrades: number;
  startDate: string;
  endDate: string;
  finalPortfolioValue: number;
  shiftWeeks: number;
  closed: ClosedTrade[];
  totalInterestEarned: number;
  totalFeesPaid: number;
  portfolioAlpha: number;
}

/**
 * Run one walk-forward from timeline[startIndex] → end.
 * startIndex typically = 52 + shift (1y YoY buffer + path-dependency offset).
 */
async function runSimulation(
  startIndex: number,
  timeline: string[],
  historicalData: SimulationHistory,
  options: { quiet?: boolean; shiftWeeks?: number } = {}
): Promise<SimulationResult> {
  const { brands, spxBars, stockBarsByTicker } = historicalData;
  const quiet = options.quiet ?? true;
  const shiftWeeks = options.shiftWeeks ?? 0;

  if (startIndex < 0 || startIndex >= timeline.length - HOLD_WEEKS - 2) {
    throw new Error(
      `Invalid startIndex ${startIndex} for timeline length ${timeline.length}.`
    );
  }

  let cash = STARTING_CAPITAL;
  const open: OpenPosition[] = [];
  const closed: ClosedTrade[] = [];
  let buysExecuted = 0;
  let totalInterestEarned = 0;
  let totalFeesPaid = 0;
  const lastSoldDate: Record<string, string> = {};

  const portfolioWeeklyReturns: number[] = [];
  const marketWeeklyReturns: number[] = [];
  let previousPortfolioValue: number | null = null;
  let previousMarketValue: number | null = null;

  for (let w = startIndex; w < timeline.length; w++) {
    const weekDate = timeline[w];
    const isLastWeek = w === timeline.length - 1;

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

    if (cash > 0) {
      const interest = cash * WEEKLY_RFR;
      cash += interest;
      totalInterestEarned += interest;
    }

    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
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

      const bars = stockBarsByTicker.get(pos.ticker);
      if (!bars) continue;
      const exitBar =
        nearestOnOrBefore(bars, weekDate) ?? nearestOnOrAfter(bars, weekDate);
      if (!exitBar) continue;

      const exitReason: ExitReason =
        isLastWeek && !maxHoldReached && !earlyYoYCrash
          ? "forced_eod"
          : earlyYoYCrash
            ? "early_yoy"
            : "max_hold";

      const { trade, sellFee, netProceeds } = closePosition({
        pos,
        exitBar,
        spxBars,
        exitReason,
      });
      cash += netProceeds;
      totalFeesPaid += sellFee;
      closed.push(trade);
      lastSoldDate[pos.brand] = weekDate;
      open.splice(i, 1);
    }

    if (!isLastWeek) {
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

      const heldByTicker = new Map(open.map((p) => [p.ticker, p]));
      const ordered = [...candidates].sort(
        (a, b) =>
          b.yoyGrowthPct - a.yoyGrowthPct ||
          b.convictionScore - a.convictionScore
      );

      for (const signal of ordered) {
        const held = heldByTicker.get(signal.ticker);
        if (held) {
          held.entryWeekIdx = w;
          held.entryDate = weekDate;
          held.yoyGrowthPct = signal.yoyGrowthPct;
          held.correlation = signal.correlation;
          held.convictionScore = signal.convictionScore;
          if (held.brand !== signal.brand) {
            held.brand = signal.brand;
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
        // T+1: fill on the first bar strictly after the signal week.
        const entryBar =
          nextTradingBar(bars, weekDate) ?? nearestOnOrAfter(bars, weekDate);
        if (!entryBar || entryBar.close <= 0) continue;

        let portfolioValue =
          cash + markToMarket(open, stockBarsByTicker, weekDate);

        if (isCashStarved(cash, portfolioValue) && open.length > 0) {
          let weakestIdx = -1;
          let weakestYoY = Number.POSITIVE_INFINITY;
          for (let oi = 0; oi < open.length; oi++) {
            const pos = open[oi];
            if (pos.ticker === signal.ticker) continue;
            const live = liveYoYForPosition(pos, brands, weekDate);
            const yoy = live ?? pos.yoyGrowthPct;
            if (yoy < weakestYoY) {
              weakestYoY = yoy;
              weakestIdx = oi;
            }
          }

          if (
            weakestIdx >= 0 &&
            Number.isFinite(weakestYoY) &&
            signal.yoyGrowthPct - weakestYoY >= OPPORTUNITY_YOY_GAP
          ) {
            const weakPos = open[weakestIdx];
            const weakBars = stockBarsByTicker.get(weakPos.ticker);
            const weakExit =
              weakBars != null
                ? nearestOnOrBefore(weakBars, weekDate) ??
                  nearestOnOrAfter(weakBars, weekDate)
                : null;
            if (weakExit) {
              const { trade, sellFee, netProceeds } = closePosition({
                pos: weakPos,
                exitBar: weakExit,
                spxBars,
                exitReason: "opportunity_replace",
                replacedByBrand: signal.brand,
              });
              cash += netProceeds;
              totalFeesPaid += sellFee;
              closed.push(trade);
              lastSoldDate[weakPos.brand] = weekDate;
              open.splice(weakestIdx, 1);
              heldByTicker.delete(weakPos.ticker);
              if (!quiet) {
                console.log(
                  `  [REPLACE] Sold ${weakPos.brand} (YoY ${fmtPct(weakestYoY)}) → buy ${signal.brand} (YoY ${fmtPct(signal.yoyGrowthPct)})  (Replaced by stronger signal)`
                );
              }
              portfolioValue =
                cash + markToMarket(open, stockBarsByTicker, weekDate);
            }
          }
        }

        const allocation = sizeHybridAllocation(cash, portfolioValue);
        if (allocation < 1) continue;

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
        });
        heldByTicker.set(signal.ticker, open[open.length - 1]);
        buysExecuted += 1;
        if (!quiet) {
          console.log(
            `  [BUY] ${signal.brand} (${signal.ticker})  size ${fmtUsd(allocation)}  (${((allocation / portfolioValue) * 100).toFixed(1)}% of portfolio)  YoY ${fmtPct(signal.yoyGrowthPct)}`
          );
        }
      }
    }

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
  const strategyReturn = pctReturn(STARTING_CAPITAL, finalValue);
  const startDate = timeline[startIndex];
  const endDate = timeline[timeline.length - 1];
  const spxStart = nearestOnOrAfter(spxBars, startDate);
  const spxEnd = nearestOnOrBefore(spxBars, endDate);
  const benchmarkReturn =
    spxStart && spxEnd ? pctReturn(spxStart.close, spxEnd.close) : NaN;
  const portfolioAlpha =
    Number.isFinite(strategyReturn) && Number.isFinite(benchmarkReturn)
      ? strategyReturn - benchmarkReturn
      : NaN;

  const wins = closed.filter((t) => t.pnl > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const beta = calculateBeta(portfolioWeeklyReturns, marketWeeklyReturns);
  const sharpeAnn = calculateAnnualizedSharpe(portfolioWeeklyReturns);

  return {
    strategyReturn,
    benchmarkReturn,
    winRate,
    beta,
    sharpeAnn,
    totalTrades: buysExecuted,
    startDate,
    endDate,
    finalPortfolioValue: finalValue,
    shiftWeeks,
    closed,
    totalInterestEarned,
    totalFeesPaid,
    portfolioAlpha,
  };
}

function avgFinite(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Batch runner: rolling-window path-dependency test
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  V5 Hybrid Simulator — Rolling Window Path Dependency    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];
  console.log(
    `Universe: ${parentCompanies.length} parents · ${brandNames.length} child brands`
  );
  console.log(
    `Capital: ${fmtUsd(STARTING_CAPITAL)} · Sizing: hybrid · max ${MAX_POSITION_PCT * 100}% / name`
  );
  console.log(
    `Entry: YoY > ${YOY_GROWTH_THRESHOLD}% · r > ${MIN_POSITIVE_CORR}`
  );
  console.log(
    `Exit: early YoY < ${EARLY_EXIT_YOY_THRESHOLD}% · max ${HOLD_DAYS}d · opportunity gap ${OPPORTUNITY_YOY_GAP}pp`
  );
  console.log(
    `Cooldown: ${COOLDOWN_DAYS}d · T-Bill ${ANNUAL_RFR * 100}% · Slippage ${SLIPPAGE_RATE * 100}%/side\n`
  );

  console.log("Fetching 5y Google Trends from Supabase…");
  const trendData = await fetchTrendHistory(
    brandNames,
    YEARS_BACK,
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

  // Full YEARS_BACK timeline so startIndex = 52 + shift still leaves multi-year runs.
  const today = new Date().toISOString().slice(0, 10);
  const dataStartDate = new Date();
  dataStartDate.setFullYear(dataStartDate.getFullYear() - YEARS_BACK);
  const dataStart = dataStartDate.toISOString().slice(0, 10);

  const allTrendDates = brands.flatMap((b) => b.series.map((p) => p.date));
  const timeline = buildTimeline(spxBars, allTrendDates, dataStart).filter(
    (d) => d <= today
  );

  if (timeline.length < YOY_LAG_WEEKS + HOLD_WEEKS + 30) {
    throw new Error(
      `Timeline too short (${timeline.length} weeks). Need more historical data.`
    );
  }

  const historicalData: SimulationHistory = {
    brands,
    spxBars,
    stockBarsByTicker,
  };

  /** Weekly start-date shifts for path-dependency stress test. */
  const shifts = [0, 1, 2, 4, 8, 12, 26];
  const results: SimulationResult[] = [];

  console.log(
    `\nTimeline: ${timeline[0]} → ${timeline[timeline.length - 1]} (${timeline.length} weeks)`
  );
  console.log(
    `Rolling windows: startIndex = 52 + shift  for shifts [${shifts.join(", ")}]\n`
  );
  console.log("Running batch…\n");

  for (const shift of shifts) {
    const startIndex = 52 + shift;
    process.stdout.write(
      `  Shift +${String(shift).padStart(2, " ")}w (idx ${startIndex})… `
    );
    const result = await runSimulation(startIndex, timeline, historicalData, {
      quiet: true,
      shiftWeeks: shift,
    });
    results.push(result);
    console.log(
      `${result.startDate} → ${fmtPct(result.strategyReturn)}  (${result.totalTrades} trades)`
    );
  }

  console.log("\n┌─────────────────────────────────────────────────────────────────────────────┐");
  console.log("│  Rolling Window Results (Hybrid Capital Allocation)                         │");
  console.log("├─────────────────────────────────────────────────────────────────────────────┤");
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const betaStr =
      r.beta != null && Number.isFinite(r.beta) ? r.beta.toFixed(2) : "n/a";
    const line = `Run ${i + 1} (Start: ${r.startDate}, +${r.shiftWeeks}w): ${fmtPct(r.strategyReturn)} Ret | ${fmtPct(r.benchmarkReturn)} SPX | ${r.winRate.toFixed(1)}% WR | ${betaStr} Beta | ${r.totalTrades} trades`;
    console.log(`│  ${pad(line, 75)}│`);
  }
  console.log("└─────────────────────────────────────────────────────────────────────────────┘\n");

  const avgStrategy = avgFinite(results.map((r) => r.strategyReturn));
  const avgBenchmark = avgFinite(results.map((r) => r.benchmarkReturn));
  const avgWinRate = avgFinite(results.map((r) => r.winRate));
  const avgBeta = avgFinite(
    results.map((r) => r.beta).filter((b): b is number => b != null)
  );

  console.log("Averages across all rolling windows:");
  console.log(
    `  Average Strategy Return   ${avgStrategy != null ? fmtPct(avgStrategy) : "n/a"}`
  );
  console.log(
    `  Average Benchmark Return  ${avgBenchmark != null ? fmtPct(avgBenchmark) : "n/a"}`
  );
  console.log(
    `  Average Win Rate          ${avgWinRate != null ? `${avgWinRate.toFixed(1)}%` : "n/a"}`
  );
  console.log(
    `  Average Beta              ${avgBeta != null ? avgBeta.toFixed(2) : "n/a"}`
  );
  console.log("");

  // Export CSV for the baseline window (shift 0) for trade-level fact-checking.
  const baseline = results[0];
  if (baseline) {
    const tradeLogPath = path.join(process.cwd(), "simulator_trades.csv");
    exportUltimateReportCsv(
      baseline.closed,
      {
        startingCapital: STARTING_CAPITAL,
        finalPortfolioValue: baseline.finalPortfolioValue,
        strategyReturnPct: baseline.strategyReturn,
        spxReturnPct: baseline.benchmarkReturn,
        alphaPct: baseline.portfolioAlpha,
        portfolioBeta: baseline.beta,
        sharpeAnn: baseline.sharpeAnn,
        totalTrades: baseline.totalTrades,
        winRatePct: baseline.winRate,
        totalInterestEarned: baseline.totalInterestEarned,
        totalFeesPaid: baseline.totalFeesPaid,
      },
      tradeLogPath
    );
    console.log(
      "📊 Baseline (shift +0w) trade log exported to simulator_trades.csv"
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFatal simulator error:", err);
    process.exit(1);
  });
