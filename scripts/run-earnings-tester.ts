/**
 * run-earnings-tester.ts — Ultimate Earnings Mismatch Tester
 *
 * Human run-up & pop window over ~14 quarters × 12 parents:
 *   Decision Date  = earnings − 14 days
 *   Exit Date      = earnings + 7 days
 *   Hold           = 21 calendar days vs ^GSPC
 *
 * Search metric = Quarter-To-Date Area Under the Curve (AUC):
 *   Start of Quarter = earnings − 90 days
 *   Current QTD Sum  = Σ search [SoQ → Decision] (~76d / ~11w)
 *   Previous QTD Sum = Σ search [SoQ−52w → Decision−52w]
 *   YoY QTD Growth   = (Current − Previous) / Previous × 100
 *
 * Trigger (no correlation filter):
 *   Delta = YoY QTD − Street estimatedRevenueGrowth
 *   HUMAN BUY when Delta > 15pp
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/run-earnings-tester.ts
 */

import * as fs from "fs";
import path from "node:path";
import YahooFinance from "yahoo-finance2";

import { normalizeDateString } from "../lib/chart-data";
import { getParentByTicker, parentCompanies } from "../lib/entities";
import { fetchStockQuotes, fetchTrendHistory } from "../lib/market-data";
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
/** Trends must cover earliest SoQ−52w (~early 2022). */
const TREND_YEARS = 5;
/** Equities must cover earliest Decision Date (~early 2023). */
const STOCK_YEARS = 5;
const QUARTER_START_OFFSET_DAYS = 90;
const DECISION_OFFSET_DAYS = 14;
const EXIT_OFFSET_DAYS = 7;
const YOY_LAG_DAYS = 52 * 7;
const DELTA_THRESHOLD = 15;
const MIN_PREV_QTD_SUM = 10;
const YOY_GROWTH_CAP = 250;
const MIN_QTD_POINTS = 6;
const YAHOO_PAUSE_MS = 400;

const yahooFinance = new YahooFinance();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EstimateRow {
  date: string;
  estimatedRevenueGrowth: number;
}

interface EarningsEvent {
  ticker: string;
  parentName: string;
  earningsDate: string;
  estimatedRevenueGrowth: number;
}

interface WeeklyBar {
  date: string;
  close: number;
}

interface BuyEvent {
  earningsDate: string;
  decisionDate: string;
  exitDate: string;
  ticker: string;
  parentName: string;
  estimatedRevenueGrowth: number;
  yoyQtdPct: number;
  delta: number;
  stockReturnPct: number;
  spxReturnPct: number;
  alphaPct: number;
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
  const d = new Date(`${normalizeDateString(isoDate)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pctReturn(start: number, end: number): number {
  if (!Number.isFinite(start) || start === 0) return NaN;
  return ((end - start) / start) * 100;
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
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

async function fetchWeeklyBars(
  ticker: string,
  yearsBack: number
): Promise<WeeklyBar[]> {
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - Math.floor(yearsBack));
  period1.setMonth(period1.getMonth() - Math.round((yearsBack % 1) * 12));

  const chart = await yahooFinance.chart(ticker, {
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

function loadEstimateEvents(): EarningsEvent[] {
  const raw = JSON.parse(fs.readFileSync(ESTIMATES_PATH, "utf8")) as Record<
    string,
    EstimateRow[]
  >;
  const events: EarningsEvent[] = [];
  for (const [ticker, rows] of Object.entries(raw)) {
    const parent = getParentByTicker(ticker);
    if (!parent) {
      console.warn(`  WARN: $${ticker} not in parentCompanies — skipping`);
      continue;
    }
    for (const row of rows) {
      events.push({
        ticker: ticker.toUpperCase(),
        parentName: parent.name,
        earningsDate: normalizeDateString(row.date),
        estimatedRevenueGrowth: row.estimatedRevenueGrowth,
      });
    }
  }
  return events.sort(
    (a, b) =>
      a.earningsDate.localeCompare(b.earningsDate) ||
      a.ticker.localeCompare(b.ticker)
  );
}

/** Sum (AUC) of weekly search values in [startDate, endDate] inclusive. */
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

/**
 * YoY QTD AUC growth for one brand:
 *   Current  = Σ [earnings−90d → earnings−14d]
 *   Previous = Σ [same window −52 weeks]
 */
function yoyQtdGrowthAt(
  series: TrendPoint[],
  quarterStart: string,
  decisionDate: string
): number | null {
  const prevQuarterStart = addDays(quarterStart, -YOY_LAG_DAYS);
  const prevDecisionDate = addDays(decisionDate, -YOY_LAG_DAYS);

  const currentSum = qtdSum(series, quarterStart, decisionDate);
  const previousSum = qtdSum(series, prevQuarterStart, prevDecisionDate);
  if (currentSum == null || previousSum == null) return null;
  if (!Number.isFinite(previousSum) || previousSum < MIN_PREV_QTD_SUM) {
    return previousSum != null && previousSum > 0 ? 0 : null;
  }

  let yoy = ((currentSum - previousSum) / previousSum) * 100;
  if (!Number.isFinite(yoy)) return null;
  if (yoy > YOY_GROWTH_CAP) yoy = YOY_GROWTH_CAP;
  if (yoy < -YOY_GROWTH_CAP) yoy = -YOY_GROWTH_CAP;
  return Math.round(yoy * 10) / 10;
}

/** Parent average YoY QTD AUC across child brands. */
function parentYoYQtdAsOf(
  childSeries: TrendPoint[][],
  quarterStart: string,
  decisionDate: string
): number | null {
  const yoys: number[] = [];
  for (const series of childSeries) {
    const yoy = yoyQtdGrowthAt(series, quarterStart, decisionDate);
    if (yoy != null) yoys.push(yoy);
  }
  if (yoys.length === 0) return null;
  return Math.round((mean(yoys) as number) * 10) / 10;
}

async function loadTrendsForBrands(
  brandNames: string[]
): Promise<Awaited<ReturnType<typeof fetchTrendHistory>>> {
  return fetchTrendHistory(brandNames, TREND_YEARS, "market_metrics");
}

function formatBuyLine(row: BuyEvent): string {
  return (
    `[🔥 HUMAN BUY] ${row.earningsDate} | $${row.ticker.padEnd(4)} | ` +
    `YoY QTD: ${fmtPct(row.yoyQtdPct).padStart(7)} | ` +
    `WS Est: ${`${row.estimatedRevenueGrowth.toFixed(1)}%`.padStart(7)} | ` +
    `Delta: ${fmtPct(row.delta).padStart(7)} | ` +
    `Stock Return: ${fmtPct(row.stockReturnPct).padStart(7)} | ` +
    `SPX: ${fmtPct(row.spxReturnPct).padStart(7)} | ` +
    `α: ${fmtPct(row.alphaPct).padStart(7)}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║  Ultimate Earnings Mismatch — QTD AUC · Human Window       ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  const events = loadEstimateEvents();
  const tickers = [...new Set(events.map((e) => e.ticker))];
  const brandNames = [
    ...new Set(
      tickers.flatMap((t) => getParentByTicker(t)?.childBrands ?? [])
    ),
  ];

  console.log(
    `Universe: ${tickers.length} parents · ${brandNames.length} child brands · ${events.length} earnings events`
  );
  console.log(
    `Search: QTD AUC (SoQ = earnings − ${QUARTER_START_OFFSET_DAYS}d → Decision = earnings − ${DECISION_OFFSET_DAYS}d) vs −52w`
  );
  console.log(
    `Trade: Decision → Exit = earnings + ${EXIT_OFFSET_DAYS}d (21d run-up & pop)`
  );
  console.log(
    `Trigger: Δ = YoY QTD − WS Est > ${DELTA_THRESHOLD}pp (no correlation filter)\n`
  );

  console.log("Loading Google Trends (5y)…");
  const trends = await loadTrendsForBrands(brandNames);
  if (trends.length === 0) {
    throw new Error("No trend rows available from Supabase.");
  }
  console.log(`  → ${trends.length} weekly trend rows`);

  const childSeriesByTicker = new Map<string, TrendPoint[][]>();
  for (const ticker of tickers) {
    const parent = getParentByTicker(ticker);
    if (!parent) continue;
    childSeriesByTicker.set(
      ticker,
      parent.childBrands.map((b) => extractBrandSeries(trends, b))
    );
  }

  console.log(`\nFetching ${SPX_TICKER} weekly history (${STOCK_YEARS}y)…`);
  const spxBars = await fetchWeeklyBars(SPX_TICKER, STOCK_YEARS);
  console.log(`  → ${spxBars.length} SPX bars`);
  await sleep(YAHOO_PAUSE_MS);

  const stockBarsByTicker = new Map<string, WeeklyBar[]>();
  console.log("\nFetching parent equity histories…");
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    process.stdout.write(`  ${ticker} (${i + 1}/${tickers.length})… `);
    try {
      const map = await fetchStockQuotes(ticker, STOCK_YEARS);
      const bars = mapToWeeklyBars(map);
      if (bars.length < 10) {
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

  console.log("\n── HUMAN BUY Ledger (Δ > 15 · QTD AUC) ─────────────────────\n");

  const buys: BuyEvent[] = [];
  let scanned = 0;
  let noYoy = 0;
  let belowThreshold = 0;
  let noPrice = 0;

  for (const event of events) {
    scanned += 1;
    const quarterStart = addDays(
      event.earningsDate,
      -QUARTER_START_OFFSET_DAYS
    );
    const decisionDate = addDays(event.earningsDate, -DECISION_OFFSET_DAYS);
    const exitDate = addDays(event.earningsDate, EXIT_OFFSET_DAYS);
    const stockBars = stockBarsByTicker.get(event.ticker);
    const childSeries = childSeriesByTicker.get(event.ticker);

    if (!stockBars || !childSeries) {
      noPrice += 1;
      continue;
    }

    const yoy = parentYoYQtdAsOf(childSeries, quarterStart, decisionDate);
    if (yoy == null) {
      noYoy += 1;
      continue;
    }

    const delta =
      Math.round((yoy - event.estimatedRevenueGrowth) * 10) / 10;
    if (delta <= DELTA_THRESHOLD) {
      belowThreshold += 1;
      continue;
    }

    const stockEntry =
      nearestOnOrAfter(stockBars, decisionDate) ??
      nearestOnOrBefore(stockBars, decisionDate);
    const stockExit =
      nearestOnOrBefore(stockBars, exitDate) ??
      nearestOnOrAfter(stockBars, exitDate);
    const spxEntry =
      nearestOnOrAfter(spxBars, decisionDate) ??
      nearestOnOrBefore(spxBars, decisionDate);
    const spxExit =
      nearestOnOrBefore(spxBars, exitDate) ??
      nearestOnOrAfter(spxBars, exitDate);

    if (
      !stockEntry ||
      !stockExit ||
      !spxEntry ||
      !spxExit ||
      stockEntry.close <= 0 ||
      stockExit.close <= 0 ||
      spxEntry.close <= 0 ||
      spxExit.close <= 0 ||
      stockExit.date <= stockEntry.date ||
      spxExit.date <= spxEntry.date
    ) {
      noPrice += 1;
      continue;
    }

    const stockReturnPct =
      Math.round(pctReturn(stockEntry.close, stockExit.close) * 10) / 10;
    const spxReturnPct =
      Math.round(pctReturn(spxEntry.close, spxExit.close) * 10) / 10;
    const alphaPct =
      Math.round((stockReturnPct - spxReturnPct) * 10) / 10;

    const row: BuyEvent = {
      earningsDate: event.earningsDate,
      decisionDate,
      exitDate,
      ticker: event.ticker,
      parentName: event.parentName,
      estimatedRevenueGrowth: event.estimatedRevenueGrowth,
      yoyQtdPct: yoy,
      delta,
      stockReturnPct,
      spxReturnPct,
      alphaPct,
    };
    buys.push(row);
    console.log(formatBuyLine(row));
  }

  const wins = buys.filter((r) => r.stockReturnPct > 0);
  const losses = buys.filter((r) => r.stockReturnPct <= 0);
  const absoluteWinRate =
    buys.length > 0 ? (wins.length / buys.length) * 100 : 0;
  const avgWin =
    wins.length > 0
      ? wins.reduce((s, r) => s + r.stockReturnPct, 0) / wins.length
      : NaN;
  const avgLoss =
    losses.length > 0
      ? losses.reduce((s, r) => s + r.stockReturnPct, 0) / losses.length
      : NaN;
  const avgSpx =
    buys.length > 0
      ? buys.reduce((s, r) => s + r.spxReturnPct, 0) / buys.length
      : NaN;
  const avgAlpha =
    buys.length > 0
      ? buys.reduce((s, r) => s + r.alphaPct, 0) / buys.length
      : NaN;

  console.log(
    "\n── Summary — Ultimate Earnings Mismatch (Δ > 15 · QTD AUC) ─\n"
  );
  console.log("┌────────────────────────────────────┬──────────────────────────┐");
  console.log("│ Metric                             │ Value                    │");
  console.log("├────────────────────────────────────┼──────────────────────────┤");
  console.log(
    `│ ${pad("Total Advice Issued", 34)} │ ${pad(String(buys.length), 24)} │`
  );
  console.log(
    `│ ${pad("Absolute Win Rate (%)", 34)} │ ${pad(`${absoluteWinRate.toFixed(1)}% (${wins.length}/${buys.length})`, 24)} │`
  );
  console.log(
    `│ ${pad("Average Win (%)", 34)} │ ${pad(fmtPct(avgWin), 24)} │`
  );
  console.log(
    `│ ${pad("Average Loss (%)", 34)} │ ${pad(fmtPct(avgLoss), 24)} │`
  );
  console.log(
    `│ ${pad("Average S&P 500 Return (%)", 34)} │ ${pad(fmtPct(avgSpx), 24)} │`
  );
  console.log(
    `│ ${pad("Average Alpha per Trade (%)", 34)} │ ${pad(fmtPct(avgAlpha), 24)} │`
  );
  console.log("└────────────────────────────────────┴──────────────────────────┘");

  console.log(
    `\n  Scanned ${scanned} events · below Δ: ${belowThreshold} · no QTD YoY: ${noYoy} · no price: ${noPrice}`
  );
  console.log(
    `  Config parents: ${parentCompanies.length} · JSON ∩ entities: ${tickers.length}\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nUltimate earnings mismatch tester failed:", err);
    process.exit(1);
  });
