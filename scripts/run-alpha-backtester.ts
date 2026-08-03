/**
 * run-alpha-backtester.ts — Alpha & Beta Dual-Portfolio Backtester
 *
 * A/B test a pure Event-Driven cash sleeve vs a fully invested S&P 500 sweep.
 *
 * Trigger (2024+): |QTD Search YoY − estimatedRevenueGrowth| ≥ 15
 * Window: entry = earnings − 14d · exit = earnings + 7d (21d hold)
 * Direction: LONG $1,000 notional on every fired signal
 *
 * Portfolio A — Pure Event-Driven:
 *   $1,000 per trade · idle cash earns 0%
 *
 * Portfolio B — S&P 500 Sweep:
 *   $1,000 per trade · idle capital 100% in ^GSPC
 *   On entry: sell $1,000 SPY → buy stock
 *   On exit: sell stock → sweep proceeds back into SPY
 *
 * Metrics: Total Return %, Alpha vs buy-&-hold SPY, weekly Beta,
 *   Win Rate, Total Trades.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/run-alpha-backtester.ts
 */

import * as fs from "fs";
import path from "node:path";
import YahooFinance from "yahoo-finance2";

import { normalizeDateString } from "../lib/chart-data";
import { getParentByTicker, parentCompanies } from "../lib/entities";
import { fetchTrendHistory } from "../lib/market-data";
import { extractBrandSeries, type TrendPoint } from "../lib/screener";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ESTIMATES_PATH = path.join(
  process.cwd(),
  "data",
  "historical-estimates.json"
);
const SPX_TICKER = "^GSPC";
const TREND_YEARS = 5;
const STOCK_YEARS = 5;
const STARTING_CAPITAL = 10_000;
const TRADE_NOTIONAL = 1_000;
const ENTRY_OFFSET_DAYS = -14;
const EXIT_OFFSET_DAYS = 7;
const QTD_LOOKBACK_DAYS = 90;
const YOY_LAG_DAYS = 365;
const MIN_PREV_QTD_SUM = 10;
const YOY_GROWTH_CAP = 250;
const MIN_QTD_POINTS = 4;
const DELTA_THRESHOLD = 15;
const MIN_EARNINGS_DATE = "2024-01-01";
const YAHOO_PAUSE_MS = 400;

const yahooFinance = new YahooFinance();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EstimateRow {
  date: string;
  estimatedRevenueGrowth: number;
  actualRevenueGrowth: number;
}

interface DailyBar {
  date: string;
  close: number;
}

interface TradeSignal {
  ticker: string;
  parentName: string;
  earningsDate: string;
  entryDate: string;
  exitDate: string;
  searchYoY: number;
  estimatedRevenueGrowth: number;
  delta: number;
  entryPrice: number;
  exitPrice: number;
  stockReturnPct: number;
}

interface OpenPosition {
  id: string;
  ticker: string;
  shares: number;
  cost: number;
  entryDate: string;
  exitDate: string;
}

interface PortfolioResult {
  label: string;
  finalEquity: number;
  totalReturnPct: number;
  alphaPct: number;
  beta: number | null;
  winRatePct: number | null;
  totalTrades: number;
  wins: number;
  skippedCash: number;
  equityCurve: Array<{ date: string; equity: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${normalizeDateString(isoDate)}T12:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pctReturn(start: number, end: number): number {
  if (!Number.isFinite(start) || start === 0) return NaN;
  return ((end - start) / start) * 100;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return " ".repeat(n - s.length) + s;
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function nearestOnOrAfter(bars: DailyBar[], targetDate: string): DailyBar | null {
  const target = normalizeDateString(targetDate);
  for (const bar of bars) {
    if (bar.date >= target) return bar;
  }
  return null;
}

function nearestOnOrBefore(bars: DailyBar[], targetDate: string): DailyBar | null {
  const target = normalizeDateString(targetDate);
  let best: DailyBar | null = null;
  for (const bar of bars) {
    if (bar.date <= target) best = bar;
    else break;
  }
  return best;
}

function priceOn(bars: DailyBar[], date: string): number | null {
  const bar =
    nearestOnOrBefore(bars, date) ?? nearestOnOrAfter(bars, date);
  return bar && Number.isFinite(bar.close) && bar.close > 0 ? bar.close : null;
}

function qtdSum(
  series: TrendPoint[],
  startDate: string,
  endDate: string
): number | null {
  const start = normalizeDateString(startDate);
  const end = normalizeDateString(endDate);
  if (start > end) return null;

  let sum = 0;
  let count = 0;
  for (const point of series) {
    const d = normalizeDateString(point.date);
    if (d < start) continue;
    if (d > end) break;
    if (!Number.isFinite(point.value)) continue;
    sum += point.value;
    count += 1;
  }
  if (count < MIN_QTD_POINTS) return null;
  return sum;
}

/** QTD Search YoY: 90d pre-earnings vs same window −1y (avg across children). */
function calculateHistoricalSearchYoY(
  earningsDate: string,
  childSeries: TrendPoint[][]
): number | null {
  const end = normalizeDateString(earningsDate);
  const currentEnd = addDays(end, -1);
  const currentStart = addDays(end, -QTD_LOOKBACK_DAYS);
  const prevEnd = addDays(currentEnd, -YOY_LAG_DAYS);
  const prevStart = addDays(currentStart, -YOY_LAG_DAYS);

  const yoys: number[] = [];
  for (const series of childSeries) {
    const currentSum = qtdSum(series, currentStart, currentEnd);
    const previousSum = qtdSum(series, prevStart, prevEnd);
    if (currentSum == null || previousSum == null) continue;
    if (!Number.isFinite(previousSum) || previousSum < MIN_PREV_QTD_SUM) {
      continue;
    }
    let pct = ((currentSum - previousSum) / previousSum) * 100;
    if (!Number.isFinite(pct)) continue;
    if (pct > YOY_GROWTH_CAP) pct = YOY_GROWTH_CAP;
    if (pct < -YOY_GROWTH_CAP) pct = -YOY_GROWTH_CAP;
    yoys.push(Math.round(pct * 10) / 10);
  }

  if (yoys.length === 0) return null;
  return Math.round((mean(yoys) as number) * 10) / 10;
}

async function fetchDailyBars(
  ticker: string,
  yearsBack: number
): Promise<DailyBar[]> {
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - yearsBack);

  const chart = await yahooFinance.chart(ticker, {
    period1,
    period2: new Date(),
    interval: "1d",
  });
  const raw =
    (chart as { quotes?: { date?: Date; close?: number | null }[] }).quotes ??
    [];

  return raw
    .filter((q) => q.close != null && q.date != null)
    .map((q) => ({
      date: new Date(q.date as Date).toISOString().slice(0, 10),
      close: Math.round((q.close as number) * 100) / 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function loadEstimatesForUniverse(): Record<string, EstimateRow[]> {
  const raw = JSON.parse(fs.readFileSync(ESTIMATES_PATH, "utf8")) as Record<
    string,
    EstimateRow[]
  >;
  const out: Record<string, EstimateRow[]> = {};
  for (const parent of parentCompanies) {
    const rows = raw[parent.ticker];
    if (rows?.length) out[parent.ticker] = rows;
  }
  return out;
}

function covariance(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  if (mx == null || my == null) return null;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += (xs[i] - mx) * (ys[i] - my);
  }
  return sum / (xs.length - 1);
}

function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  if (m == null) return null;
  let sum = 0;
  for (const x of xs) sum += (x - m) ** 2;
  return sum / (xs.length - 1);
}

function weekKey(isoDate: string): string {
  const d = new Date(`${normalizeDateString(isoDate)}T12:00:00`);
  const day = d.getDay();
  const thursday = new Date(d);
  thursday.setDate(d.getDate() + (4 - (day === 0 ? 7 : day)));
  return thursday.toISOString().slice(0, 10);
}

/** Last equity observation per ISO week → sequential weekly returns keyed by week. */
function weeklyEquityByWeek(
  curve: Array<{ date: string; equity: number }>
): Map<string, number> {
  const byWeek = new Map<string, number>();
  for (const point of curve) {
    byWeek.set(weekKey(point.date), point.equity);
  }
  return byWeek;
}

function computeBeta(
  portfolioCurve: Array<{ date: string; equity: number }>,
  spxBars: DailyBar[],
  startDate: string,
  endDate: string
): number | null {
  const spxCurve = spxBars
    .filter((b) => b.date >= startDate && b.date <= endDate)
    .map((b) => ({ date: b.date, equity: b.close }));

  const pWeeks = weeklyEquityByWeek(portfolioCurve);
  const mWeeks = weeklyEquityByWeek(spxCurve);
  const keys = [...pWeeks.keys()]
    .filter((k) => mWeeks.has(k))
    .sort((a, b) => a.localeCompare(b));
  if (keys.length < 9) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 1; i < keys.length; i++) {
    const p0 = pWeeks.get(keys[i - 1])!;
    const p1 = pWeeks.get(keys[i])!;
    const m0 = mWeeks.get(keys[i - 1])!;
    const m1 = mWeeks.get(keys[i])!;
    if (p0 > 0 && m0 > 0 && Number.isFinite(p1) && Number.isFinite(m1)) {
      xs.push((p1 - p0) / p0);
      ys.push((m1 - m0) / m0);
    }
  }
  if (xs.length < 8) return null;

  const cov = covariance(xs, ys);
  const varM = variance(ys);
  if (cov == null || varM == null || varM === 0) return null;
  return Math.round((cov / varM) * 1000) / 1000;
}

function buildCalendar(start: string, end: string, spxBars: DailyBar[]): string[] {
  return spxBars
    .map((b) => b.date)
    .filter((d) => d >= start && d <= end);
}

// ---------------------------------------------------------------------------
// Portfolio engines
// ---------------------------------------------------------------------------

function simulatePortfolioA(
  trades: TradeSignal[],
  stockBarsByTicker: Map<string, DailyBar[]>,
  calendar: string[]
): {
  equityCurve: Array<{ date: string; equity: number }>;
  finalEquity: number;
  executed: TradeSignal[];
  skippedCash: number;
} {
  let cash = STARTING_CAPITAL;
  const open = new Map<string, OpenPosition>();
  const executed: TradeSignal[] = [];
  let skippedCash = 0;
  const equityCurve: Array<{ date: string; equity: number }> = [];

  const byEntry = new Map<string, TradeSignal[]>();
  const byExit = new Map<string, TradeSignal[]>();
  for (const t of trades) {
    const eList = byEntry.get(t.entryDate) ?? [];
    eList.push(t);
    byEntry.set(t.entryDate, eList);
    const xList = byExit.get(t.exitDate) ?? [];
    xList.push(t);
    byExit.set(t.exitDate, xList);
  }

  let tradeSeq = 0;

  for (const date of calendar) {
    // Exits first (free cash before same-day entries).
    for (const t of byExit.get(date) ?? []) {
      const id = `${t.ticker}|${t.earningsDate}`;
      const pos = open.get(id);
      if (!pos) continue;
      cash += pos.shares * t.exitPrice;
      open.delete(id);
    }

    for (const t of byEntry.get(date) ?? []) {
      if (cash + 1e-9 < TRADE_NOTIONAL) {
        skippedCash += 1;
        continue;
      }
      cash -= TRADE_NOTIONAL;
      const shares = TRADE_NOTIONAL / t.entryPrice;
      const id = `${t.ticker}|${t.earningsDate}`;
      open.set(id, {
        id: `${id}#${tradeSeq++}`,
        ticker: t.ticker,
        shares,
        cost: TRADE_NOTIONAL,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
      });
      executed.push(t);
    }

    let mtm = cash;
    for (const pos of open.values()) {
      const bars = stockBarsByTicker.get(pos.ticker);
      const px = bars ? priceOn(bars, date) : null;
      mtm += pos.shares * (px ?? pos.cost / pos.shares);
    }
    equityCurve.push({ date, equity: Math.round(mtm * 100) / 100 });
  }

  const finalEquity =
    equityCurve.length > 0
      ? equityCurve[equityCurve.length - 1].equity
      : STARTING_CAPITAL;

  return { equityCurve, finalEquity, executed, skippedCash };
}

function simulatePortfolioB(
  trades: TradeSignal[],
  stockBarsByTicker: Map<string, DailyBar[]>,
  spxBars: DailyBar[],
  calendar: string[]
): {
  equityCurve: Array<{ date: string; equity: number }>;
  finalEquity: number;
  executed: TradeSignal[];
  skippedCash: number;
} {
  const firstPx = priceOn(spxBars, calendar[0] ?? "");
  if (firstPx == null || firstPx <= 0) {
    throw new Error("Cannot seed Portfolio B — missing SPY price at start.");
  }

  let spyShares = STARTING_CAPITAL / firstPx;
  let cash = 0; // residual only; idle capital lives in SPY
  const open = new Map<string, OpenPosition>();
  const executed: TradeSignal[] = [];
  let skippedCash = 0;
  const equityCurve: Array<{ date: string; equity: number }> = [];

  const byEntry = new Map<string, TradeSignal[]>();
  const byExit = new Map<string, TradeSignal[]>();
  for (const t of trades) {
    const eList = byEntry.get(t.entryDate) ?? [];
    eList.push(t);
    byEntry.set(t.entryDate, eList);
    const xList = byExit.get(t.exitDate) ?? [];
    xList.push(t);
    byExit.set(t.exitDate, xList);
  }

  let tradeSeq = 0;

  for (const date of calendar) {
    const spyPx = priceOn(spxBars, date);
    if (spyPx == null || spyPx <= 0) continue;

    for (const t of byExit.get(date) ?? []) {
      const id = `${t.ticker}|${t.earningsDate}`;
      const pos = open.get(id);
      if (!pos) continue;
      const proceeds = pos.shares * t.exitPrice;
      open.delete(id);
      // Sweep proceeds back into SPY.
      spyShares += proceeds / spyPx;
    }

    for (const t of byEntry.get(date) ?? []) {
      const spyValue = spyShares * spyPx;
      if (spyValue + 1e-9 < TRADE_NOTIONAL) {
        skippedCash += 1;
        continue;
      }
      // Sell $1,000 of SPY → buy stock.
      spyShares -= TRADE_NOTIONAL / spyPx;
      const shares = TRADE_NOTIONAL / t.entryPrice;
      const id = `${t.ticker}|${t.earningsDate}`;
      open.set(id, {
        id: `${id}#${tradeSeq++}`,
        ticker: t.ticker,
        shares,
        cost: TRADE_NOTIONAL,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
      });
      executed.push(t);
    }

    let mtm = cash + spyShares * spyPx;
    for (const pos of open.values()) {
      const bars = stockBarsByTicker.get(pos.ticker);
      const px = bars ? priceOn(bars, date) : null;
      mtm += pos.shares * (px ?? pos.cost / pos.shares);
    }
    equityCurve.push({ date, equity: Math.round(mtm * 100) / 100 });
  }

  const finalEquity =
    equityCurve.length > 0
      ? equityCurve[equityCurve.length - 1].equity
      : STARTING_CAPITAL;

  return { equityCurve, finalEquity, executed, skippedCash };
}

function summarizePortfolio(
  label: string,
  sim: {
    equityCurve: Array<{ date: string; equity: number }>;
    finalEquity: number;
    executed: TradeSignal[];
    skippedCash: number;
  },
  benchmarkReturnPct: number,
  spxBars: DailyBar[],
  startDate: string,
  endDate: string
): PortfolioResult {
  const totalReturnPct =
    Math.round(pctReturn(STARTING_CAPITAL, sim.finalEquity) * 100) / 100;
  const alphaPct = Math.round((totalReturnPct - benchmarkReturnPct) * 100) / 100;
  const beta = computeBeta(sim.equityCurve, spxBars, startDate, endDate);
  const wins = sim.executed.filter((t) => t.stockReturnPct > 0).length;
  const totalTrades = sim.executed.length;
  const winRatePct =
    totalTrades > 0
      ? Math.round((wins / totalTrades) * 1000) / 10
      : null;

  return {
    label,
    finalEquity: sim.finalEquity,
    totalReturnPct,
    alphaPct,
    beta,
    winRatePct,
    totalTrades,
    wins,
    skippedCash: sim.skippedCash,
    equityCurve: sim.equityCurve,
  };
}

function printComparison(
  a: PortfolioResult,
  b: PortfolioResult,
  benchmarkReturnPct: number,
  tradeCount: number,
  universeSize: number
): void {
  const col = 18;
  const metric = 22;

  console.log(
    "\n╔══════════════════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║  Earnings Whisper · Alpha & Beta Dual-Portfolio Backtester               ║"
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════════════════╝\n"
  );

  console.log(
    `  Universe: ${universeSize} parents · Trigger: |Δ| ≥ ${DELTA_THRESHOLD}pp · ≥ ${MIN_EARNINGS_DATE}`
  );
  console.log(
    `  Window: entry earnings${ENTRY_OFFSET_DAYS}d → exit earnings+${EXIT_OFFSET_DAYS}d · Notional $${TRADE_NOTIONAL} · Start $${STARTING_CAPITAL.toLocaleString()}`
  );
  console.log(
    `  Candidate signals: ${tradeCount} · Buy-&-hold ${SPX_TICKER}: ${fmtPct(benchmarkReturnPct)}\n`
  );

  const header =
    "┌" +
    "─".repeat(metric) +
    "┬" +
    "─".repeat(col) +
    "┬" +
    "─".repeat(col) +
    "┐";
  const mid =
    "├" +
    "─".repeat(metric) +
    "┼" +
    "─".repeat(col) +
    "┼" +
    "─".repeat(col) +
    "┤";
  const foot =
    "└" +
    "─".repeat(metric) +
    "┴" +
    "─".repeat(col) +
    "┴" +
    "─".repeat(col) +
    "┘";

  console.log(header);
  console.log(
    "│" +
      pad(" Metric", metric) +
      "│" +
      pad(" Portfolio A", col) +
      "│" +
      pad(" Portfolio B", col) +
      "│"
  );
  console.log(
    "│" +
      pad(" ", metric) +
      "│" +
      pad(" Event-Driven", col) +
      "│" +
      pad(" SPY Sweep", col) +
      "│"
  );
  console.log(mid);

  const rows: Array<[string, string, string]> = [
    ["Final Equity", fmtUsd(a.finalEquity), fmtUsd(b.finalEquity)],
    ["Total Return", fmtPct(a.totalReturnPct), fmtPct(b.totalReturnPct)],
    ["Alpha vs SPY", fmtPct(a.alphaPct), fmtPct(b.alphaPct)],
    ["Beta (weekly)", fmtNum(a.beta, 3), fmtNum(b.beta, 3)],
    [
      "Win Rate",
      a.winRatePct == null
        ? "n/a"
        : `${a.winRatePct.toFixed(1)}% (${a.wins}/${a.totalTrades})`,
      b.winRatePct == null
        ? "n/a"
        : `${b.winRatePct.toFixed(1)}% (${b.wins}/${b.totalTrades})`,
    ],
    ["Total Trades", String(a.totalTrades), String(b.totalTrades)],
    ["Skipped (cash)", String(a.skippedCash), String(b.skippedCash)],
    [
      "Idle Capital",
      "0% checking",
      `100% ${SPX_TICKER}`,
    ],
  ];

  for (const [m, av, bv] of rows) {
    console.log(
      "│" +
        pad(` ${m}`, metric) +
        "│" +
        padLeft(`${av} `, col) +
        "│" +
        padLeft(`${bv} `, col) +
        "│"
    );
  }
  console.log(foot);

  const winner =
    a.totalReturnPct === b.totalReturnPct
      ? "TIE"
      : a.totalReturnPct > b.totalReturnPct
        ? "Portfolio A (Event-Driven)"
        : "Portfolio B (SPY Sweep)";
  const lowBeta =
    a.beta == null || b.beta == null
      ? "n/a"
      : a.beta <= b.beta
        ? "Portfolio A (lower beta)"
        : "Portfolio B (lower beta)";

  console.log(`\n  Return leader : ${winner}`);
  console.log(`  Low-beta sleeve: ${lowBeta}`);
  console.log(
    "\n  A = pure event alpha with cash drag · B = event alpha + market beta from SPY sweep\n"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nLoading universe + historical estimates…");
  const estimatesMap = loadEstimatesForUniverse();
  const tickers = parentCompanies.map((p) => p.ticker);
  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];

  console.log(
    `  Parents: ${tickers.length} · Brands: ${brandNames.length} · Estimate keys: ${Object.keys(estimatesMap).length}`
  );

  console.log("\nFetching Google Trends (5y)…");
  const trends = await fetchTrendHistory(
    brandNames,
    TREND_YEARS,
    "market_metrics"
  );
  if (trends.length === 0) {
    throw new Error(
      "No trend rows from Supabase — run npm run fetch:trends first."
    );
  }
  console.log(`  → ${trends.length} weekly trend rows`);

  const childSeriesByTicker = new Map<string, TrendPoint[][]>();
  for (const parent of parentCompanies) {
    childSeriesByTicker.set(
      parent.ticker,
      parent.childBrands.map((b) => extractBrandSeries(trends, b))
    );
  }

  console.log(`\nFetching ${SPX_TICKER} daily history (${STOCK_YEARS}y)…`);
  const spxBars = await fetchDailyBars(SPX_TICKER, STOCK_YEARS);
  console.log(`  → ${spxBars.length} daily bars`);
  await sleep(YAHOO_PAUSE_MS);

  const stockBarsByTicker = new Map<string, DailyBar[]>();
  console.log("\nFetching parent equity daily histories…");
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    process.stdout.write(`  ${ticker} (${i + 1}/${tickers.length})… `);
    try {
      const bars = await fetchDailyBars(ticker, STOCK_YEARS);
      if (bars.length < 40) {
        console.log("SKIP (thin history)");
      } else {
        stockBarsByTicker.set(ticker, bars);
        console.log(`${bars.length} bars`);
      }
    } catch (error) {
      console.log(
        `FAIL (${error instanceof Error ? error.message.slice(0, 60) : "error"})`
      );
    }
    if (i < tickers.length - 1) await sleep(YAHOO_PAUSE_MS);
  }

  // Build chronologically sorted trade signals.
  const candidates: TradeSignal[] = [];
  let scanned = 0;
  let skippedPre2024 = 0;
  let skippedNoYoy = 0;
  let skippedBelow = 0;
  let skippedNoPrice = 0;

  for (const parent of parentCompanies) {
    const rows = estimatesMap[parent.ticker] ?? [];
    const childSeries = childSeriesByTicker.get(parent.ticker) ?? [];
    const stockBars = stockBarsByTicker.get(parent.ticker);
    if (!stockBars) continue;

    for (const row of rows) {
      scanned += 1;
      const earningsDate = normalizeDateString(row.date);
      if (earningsDate < MIN_EARNINGS_DATE) {
        skippedPre2024 += 1;
        continue;
      }

      const searchYoY =
        childSeries.length > 0
          ? calculateHistoricalSearchYoY(earningsDate, childSeries)
          : null;
      if (searchYoY == null) {
        skippedNoYoy += 1;
        continue;
      }

      const delta =
        Math.round((searchYoY - row.estimatedRevenueGrowth) * 10) / 10;
      if (Math.abs(delta) < DELTA_THRESHOLD) {
        skippedBelow += 1;
        continue;
      }

      const entryDate = addDays(earningsDate, ENTRY_OFFSET_DAYS);
      const exitDate = addDays(earningsDate, EXIT_OFFSET_DAYS);
      const entryBar =
        nearestOnOrAfter(stockBars, entryDate) ??
        nearestOnOrBefore(stockBars, entryDate);
      const exitBar =
        nearestOnOrBefore(stockBars, exitDate) ??
        nearestOnOrAfter(stockBars, exitDate);

      if (
        !entryBar ||
        !exitBar ||
        entryBar.close <= 0 ||
        exitBar.close <= 0 ||
        exitBar.date <= entryBar.date
      ) {
        skippedNoPrice += 1;
        continue;
      }

      const stockReturnPct =
        Math.round(pctReturn(entryBar.close, exitBar.close) * 100) / 100;

      candidates.push({
        ticker: parent.ticker,
        parentName: parent.name,
        earningsDate,
        entryDate: entryBar.date,
        exitDate: exitBar.date,
        searchYoY,
        estimatedRevenueGrowth: row.estimatedRevenueGrowth,
        delta,
        entryPrice: entryBar.close,
        exitPrice: exitBar.close,
        stockReturnPct,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.entryDate.localeCompare(b.entryDate) ||
      a.ticker.localeCompare(b.ticker) ||
      a.earningsDate.localeCompare(b.earningsDate)
  );

  console.log(
    `\nSignals: ${candidates.length} (scanned ${scanned} · pre-2024 ${skippedPre2024} · no YoY ${skippedNoYoy} · |Δ|<15 ${skippedBelow} · no px ${skippedNoPrice})`
  );

  if (candidates.length === 0) {
    throw new Error("No trade signals — cannot run portfolios.");
  }

  const simStart = candidates.reduce(
    (min, t) => (t.entryDate < min ? t.entryDate : min),
    candidates[0].entryDate
  );
  const simEnd = candidates.reduce(
    (max, t) => (t.exitDate > max ? t.exitDate : max),
    candidates[0].exitDate
  );
  // Extend to latest available SPY bar so idle SPY sweep keeps marking.
  const lastSpx = spxBars[spxBars.length - 1]?.date ?? simEnd;
  const calendarEnd = lastSpx > simEnd ? lastSpx : simEnd;
  const calendar = buildCalendar(simStart, calendarEnd, spxBars);
  if (calendar.length === 0) {
    throw new Error("Empty trading calendar.");
  }

  const spxStartPx = priceOn(spxBars, simStart);
  const spxEndPx = priceOn(spxBars, calendarEnd);
  if (spxStartPx == null || spxEndPx == null) {
    throw new Error("Missing SPY prices for benchmark window.");
  }
  const benchmarkReturnPct =
    Math.round(pctReturn(spxStartPx, spxEndPx) * 100) / 100;

  console.log(
    `Sim window: ${simStart} → ${calendarEnd} (${calendar.length} sessions) · SPY BH ${fmtPct(benchmarkReturnPct)}`
  );

  console.log("\nSimulating Portfolio A (Event-Driven / cash idle)…");
  const simA = simulatePortfolioA(candidates, stockBarsByTicker, calendar);
  console.log(
    `  Executed ${simA.executed.length} · skipped ${simA.skippedCash} · final ${fmtUsd(simA.finalEquity)}`
  );

  console.log("Simulating Portfolio B (SPY Sweep)…");
  const simB = simulatePortfolioB(
    candidates,
    stockBarsByTicker,
    spxBars,
    calendar
  );
  console.log(
    `  Executed ${simB.executed.length} · skipped ${simB.skippedCash} · final ${fmtUsd(simB.finalEquity)}`
  );

  const resultA = summarizePortfolio(
    "Portfolio A",
    simA,
    benchmarkReturnPct,
    spxBars,
    simStart,
    calendarEnd
  );
  const resultB = summarizePortfolio(
    "Portfolio B",
    simB,
    benchmarkReturnPct,
    spxBars,
    simStart,
    calendarEnd
  );

  printComparison(
    resultA,
    resultB,
    benchmarkReturnPct,
    candidates.length,
    parentCompanies.length
  );

  // Compact signal ledger (top-level visibility).
  console.log("── Signal Ledger (chronological) ─────────────────────────────────\n");
  for (const t of candidates.slice(0, 40)) {
    const side = t.delta >= DELTA_THRESHOLD ? "BEAT↑" : "MISS↓";
    console.log(
      `  ${t.entryDate}→${t.exitDate}  $${pad(t.ticker, 4)}  ${side}  Δ=${fmtPct(t.delta, 1).padStart(7)}  stock ${fmtPct(t.stockReturnPct, 1).padStart(7)}`
    );
  }
  if (candidates.length > 40) {
    console.log(`  … +${candidates.length - 40} more signals`);
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nAlpha & Beta backtester failed:", err);
    process.exit(1);
  });
