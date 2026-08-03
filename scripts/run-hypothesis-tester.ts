/**
 * run-hypothesis-tester.ts — Master Brand Vetter
 *
 * Winning thesis (strict):
 *   Trigger: |Search YoY − estimatedRevenueGrowth| ≥ 15
 *   Timeframe: earningsDate ≥ 2024-01-01 only
 *   No Pearson / correlation filters
 *
 * Search YoY: 90 days strictly prior to earnings vs same window −1 year.
 * Grade: Δ ≥ 15 → BEAT, Δ ≤ −15 → MISS; CORRECT if that matches
 *   actualRevenueGrowth > estimatedRevenueGrowth (BEAT) else MISS.
 *
 * Output: brand-by-brand scorecard + global aggregate win rate.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/run-hypothesis-tester.ts
 */

import * as fs from "fs";
import path from "node:path";

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
const TREND_YEARS = 5;
const QTD_LOOKBACK_DAYS = 90;
const YOY_LAG_DAYS = 365;
const MIN_PREV_QTD_SUM = 10;
const YOY_GROWTH_CAP = 250;
const MIN_QTD_POINTS = 4;
const DELTA_THRESHOLD = 15;
const MIN_EARNINGS_DATE = "2024-01-01";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EstimateRow {
  date: string;
  estimatedRevenueGrowth: number;
  actualRevenueGrowth: number;
}

interface ScoredEvent {
  ticker: string;
  parentName: string;
  earningsDate: string;
  searchYoY: number;
  estimatedRevenueGrowth: number;
  actualRevenueGrowth: number;
  delta: number;
  actualBeat: boolean;
}

type Prediction = "BEAT" | "MISS";

interface BrandScorecard {
  ticker: string;
  parentName: string;
  signals: number;
  correct: number;
  incorrect: number;
  winRatePct: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return " ".repeat(n - s.length) + s;
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

function predictionFromDelta(delta: number): Prediction | null {
  if (Math.abs(delta) < DELTA_THRESHOLD) return null;
  return delta >= DELTA_THRESHOLD ? "BEAT" : "MISS";
}

function loadEstimatesMap(): Record<string, EstimateRow[]> {
  return JSON.parse(fs.readFileSync(ESTIMATES_PATH, "utf8")) as Record<
    string,
    EstimateRow[]
  >;
}

function printBrandScorecard(rows: BrandScorecard[]): void {
  const cols = {
    ticker: 8,
    name: 28,
    signals: 10,
    correct: 10,
    incorrect: 12,
    win: 10,
  };

  const top =
    "┌" +
    "─".repeat(cols.ticker) +
    "┬" +
    "─".repeat(cols.name) +
    "┬" +
    "─".repeat(cols.signals) +
    "┬" +
    "─".repeat(cols.correct) +
    "┬" +
    "─".repeat(cols.incorrect) +
    "┬" +
    "─".repeat(cols.win) +
    "┐";
  const rule =
    "├" +
    "─".repeat(cols.ticker) +
    "┼" +
    "─".repeat(cols.name) +
    "┼" +
    "─".repeat(cols.signals) +
    "┼" +
    "─".repeat(cols.correct) +
    "┼" +
    "─".repeat(cols.incorrect) +
    "┼" +
    "─".repeat(cols.win) +
    "┤";
  const bottom =
    "└" +
    "─".repeat(cols.ticker) +
    "┴" +
    "─".repeat(cols.name) +
    "┴" +
    "─".repeat(cols.signals) +
    "┴" +
    "─".repeat(cols.correct) +
    "┴" +
    "─".repeat(cols.incorrect) +
    "┴" +
    "─".repeat(cols.win) +
    "┘";

  console.log(top);
  console.log(
    "│" +
      pad(" Ticker", cols.ticker) +
      "│" +
      pad(" Parent", cols.name) +
      "│" +
      padLeft("Signals ", cols.signals) +
      "│" +
      padLeft("Correct ", cols.correct) +
      "│" +
      padLeft("Incorrect ", cols.incorrect) +
      "│" +
      padLeft("Win Rate ", cols.win) +
      "│"
  );
  console.log(rule);

  for (const row of rows) {
    const winLabel =
      row.signals === 0 || row.winRatePct == null
        ? "N/A"
        : `${row.winRatePct.toFixed(1)}%`;
    console.log(
      "│" +
        pad(` $${row.ticker}`, cols.ticker) +
        "│" +
        pad(` ${row.parentName}`, cols.name) +
        "│" +
        padLeft(`${row.signals} `, cols.signals) +
        "│" +
        padLeft(`${row.correct} `, cols.correct) +
        "│" +
        padLeft(`${row.incorrect} `, cols.incorrect) +
        "│" +
        padLeft(`${winLabel} `, cols.win) +
        "│"
    );
  }

  console.log(bottom);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Earnings Whisper · Master Brand Vetter (15% / Post-2024)        ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  console.log(
    `Rule: |Δ| ≥ ${DELTA_THRESHOLD}pp · earnings ≥ ${MIN_EARNINGS_DATE} · no correlation filter`
  );
  console.log(
    `Search YoY: ${QTD_LOOKBACK_DAYS}d pre-earnings vs −${YOY_LAG_DAYS}d\n`
  );

  const estimatesMap = loadEstimatesMap();
  const tickers = Object.keys(estimatesMap).sort();

  const brandNames = [
    ...new Set(
      tickers.flatMap((t) => getParentByTicker(t)?.childBrands ?? [])
    ),
  ];

  console.log(
    `Estimates tickers: ${tickers.length} · Config parents: ${parentCompanies.length} · Child brands to load: ${brandNames.length}`
  );
  console.log("Loading Google Trends (5y, market_metrics)…");

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
  console.log(`  → ${trends.length} weekly trend rows\n`);

  const childSeriesByTicker = new Map<string, TrendPoint[][]>();
  for (const ticker of tickers) {
    const parent = getParentByTicker(ticker);
    if (!parent) continue;
    childSeriesByTicker.set(
      ticker,
      parent.childBrands.map((b) => extractBrandSeries(trends, b))
    );
  }

  const scored: ScoredEvent[] = [];
  let skippedPre2024 = 0;
  let skippedNoYoy = 0;

  for (const ticker of tickers) {
    const parent = getParentByTicker(ticker);
    const parentName = parent?.name ?? ticker;
    const childSeries = childSeriesByTicker.get(ticker) ?? [];
    const rows = estimatesMap[ticker] ?? [];

    for (const row of rows) {
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
      scored.push({
        ticker,
        parentName,
        earningsDate,
        searchYoY,
        estimatedRevenueGrowth: row.estimatedRevenueGrowth,
        actualRevenueGrowth: row.actualRevenueGrowth,
        delta,
        actualBeat: row.actualRevenueGrowth > row.estimatedRevenueGrowth,
      });
    }
  }

  console.log(
    `Post-2024 scored events: ${scored.length} (skipped pre-2024: ${skippedPre2024}, no Search YoY: ${skippedNoYoy})\n`
  );

  // Every brand in historical-estimates.json gets a row (even 0 signals).
  const byTicker = new Map<string, BrandScorecard>();
  for (const ticker of tickers) {
    const parent = getParentByTicker(ticker);
    byTicker.set(ticker, {
      ticker,
      parentName: parent?.name ?? ticker,
      signals: 0,
      correct: 0,
      incorrect: 0,
      winRatePct: null,
    });
  }

  for (const event of scored) {
    const prediction = predictionFromDelta(event.delta);
    if (prediction == null) continue;

    const bucket = byTicker.get(event.ticker)!;
    bucket.signals += 1;
    const actual: Prediction = event.actualBeat ? "BEAT" : "MISS";
    if (prediction === actual) bucket.correct += 1;
    else bucket.incorrect += 1;
  }

  for (const bucket of byTicker.values()) {
    if (bucket.signals > 0) {
      bucket.winRatePct =
        Math.round((bucket.correct / bucket.signals) * 1000) / 10;
    } else {
      bucket.winRatePct = null;
    }
  }

  const scorecard = [...byTicker.values()].sort((a, b) => {
    const ar = a.winRatePct ?? -1;
    const br = b.winRatePct ?? -1;
    if (ar !== br) return br - ar; // strongest first for vetting
    if (b.signals !== a.signals) return b.signals - a.signals;
    return a.ticker.localeCompare(b.ticker);
  });

  console.log("── Brand-by-Brand Scorecard (15% Δ · Post-2024) ─────────────────\n");
  printBrandScorecard(scorecard);

  let globalSignals = 0;
  let globalCorrect = 0;
  for (const row of scorecard) {
    globalSignals += row.signals;
    globalCorrect += row.correct;
  }
  const globalWin =
    globalSignals > 0
      ? Math.round((globalCorrect / globalSignals) * 1000) / 10
      : null;

  console.log("\n── Global Aggregate ──────────────────────────────────────────────");
  console.log(
    `  Signals fired : ${globalSignals}`
  );
  console.log(
    `  Correct       : ${globalCorrect}`
  );
  console.log(
    `  Incorrect     : ${globalSignals - globalCorrect}`
  );
  console.log(
    `  Win Rate      : ${globalWin == null ? "N/A" : `${globalWin.toFixed(1)}%`}`
  );
  console.log("");
}

main().catch((err) => {
  console.error("\nFatal error in Master Brand Vetter:", err);
  process.exit(1);
});
