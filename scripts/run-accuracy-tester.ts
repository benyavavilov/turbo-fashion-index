/**
 * run-accuracy-tester.ts — Earnings Accuracy + Search↔Revenue Correlation
 *
 * Uses the same QTD AUC search math as the human-window earnings tester:
 *   Start of Quarter = earnings − 90 days
 *   Decision Date    = earnings − 14 days
 *   Current QTD Sum  = Σ search [SoQ → Decision]
 *   Previous QTD Sum = Σ search [SoQ−52w → Decision−52w]
 *   YoY QTD Growth   = (Current − Previous) / Previous × 100
 *
 * Trigger: Delta = YoY QTD − estimatedRevenueGrowth > 15
 * Accuracy: actualRevenueGrowth strictly exceeds estimatedRevenueGrowth
 *   → ✅ BEAT (correct) / ❌ MISS (incorrect)
 *
 * Also profiles each brand: Pearson r(YoY QTD Search, actualRevenueGrowth)
 * across all quarters with valid QTD data (not only triggered signals).
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/run-accuracy-tester.ts
 */

import * as fs from "fs";
import path from "node:path";

import { normalizeDateString } from "../lib/chart-data";
import { getParentByTicker, parentCompanies } from "../lib/entities";
import { fetchTrendHistory } from "../lib/market-data";
import { calculatePearson } from "../lib/math";
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
const QUARTER_START_OFFSET_DAYS = 90;
const DECISION_OFFSET_DAYS = 14;
const YOY_LAG_DAYS = 52 * 7;
const DELTA_THRESHOLD = 15;
const MIN_PREV_QTD_SUM = 10;
const YOY_GROWTH_CAP = 250;
const MIN_QTD_POINTS = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EstimateRow {
  date: string;
  estimatedRevenueGrowth: number;
  actualRevenueGrowth: number;
}

interface EarningsEvent {
  ticker: string;
  parentName: string;
  earningsDate: string;
  estimatedRevenueGrowth: number;
  actualRevenueGrowth: number;
}

interface EventResult {
  earningsDate: string;
  decisionDate: string;
  ticker: string;
  parentName: string;
  yoyQtdPct: number;
  estimatedRevenueGrowth: number;
  actualRevenueGrowth: number;
  delta: number;
  beat: boolean;
}

interface BrandCorrRow {
  ticker: string;
  parentName: string;
  n: number;
  correlation: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${normalizeDateString(isoDate)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
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
      if (
        typeof row.actualRevenueGrowth !== "number" ||
        !Number.isFinite(row.actualRevenueGrowth)
      ) {
        console.warn(
          `  WARN: $${ticker} ${row.date} missing actualRevenueGrowth — skipping`
        );
        continue;
      }
      events.push({
        ticker: ticker.toUpperCase(),
        parentName: parent.name,
        earningsDate: normalizeDateString(row.date),
        estimatedRevenueGrowth: row.estimatedRevenueGrowth,
        actualRevenueGrowth: row.actualRevenueGrowth,
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

function formatSignalLine(row: EventResult): string {
  const result = row.beat ? "✅ BEAT" : "❌ MISS";
  return (
    `${row.earningsDate} | $${row.ticker.padEnd(4)} | ` +
    `QTD Search YoY: ${fmtPct(row.yoyQtdPct).padStart(7)} | ` +
    `Est Rev Growth: ${fmtPct(row.estimatedRevenueGrowth).padStart(7)} | ` +
    `Actual Rev Growth: ${fmtPct(row.actualRevenueGrowth).padStart(7)} | ` +
    `Result: [${result}]`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║  Earnings Accuracy Tester · Search↔Revenue Correlation     ║");
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
    `Trigger: Δ = YoY QTD − Est Rev > ${DELTA_THRESHOLD}pp · Accuracy: Actual > Est → BEAT\n`
  );

  console.log("Loading Google Trends (5y)…");
  const trends = await loadTrendsForBrands(brandNames);
  if (trends.length === 0) {
    throw new Error("No trend rows available from Supabase.");
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

  /** All events with valid QTD YoY (for per-brand Pearson). */
  const scored: EventResult[] = [];
  let noYoy = 0;

  for (const event of events) {
    const childSeries = childSeriesByTicker.get(event.ticker);
    if (!childSeries) {
      noYoy += 1;
      continue;
    }

    const quarterStart = addDays(
      event.earningsDate,
      -QUARTER_START_OFFSET_DAYS
    );
    const decisionDate = addDays(event.earningsDate, -DECISION_OFFSET_DAYS);
    const yoy = parentYoYQtdAsOf(childSeries, quarterStart, decisionDate);
    if (yoy == null) {
      noYoy += 1;
      continue;
    }

    const delta =
      Math.round((yoy - event.estimatedRevenueGrowth) * 10) / 10;
    const beat = event.actualRevenueGrowth > event.estimatedRevenueGrowth;

    scored.push({
      earningsDate: event.earningsDate,
      decisionDate,
      ticker: event.ticker,
      parentName: event.parentName,
      yoyQtdPct: yoy,
      estimatedRevenueGrowth: event.estimatedRevenueGrowth,
      actualRevenueGrowth: event.actualRevenueGrowth,
      delta,
      beat,
    });
  }

  const signals = scored.filter((r) => r.delta > DELTA_THRESHOLD);

  console.log("── Triggered Signals (Δ > 15) ────────────────────────────────\n");
  if (signals.length === 0) {
    console.log("  (none)\n");
  } else {
    for (const row of signals) {
      console.log(formatSignalLine(row));
    }
    console.log("");
  }

  const correct = signals.filter((r) => r.beat).length;
  const accuracyPct =
    signals.length > 0 ? (correct / signals.length) * 100 : 0;

  // Per-brand Pearson: YoY QTD Search vs actualRevenueGrowth (all scored quarters)
  const byTicker = new Map<string, EventResult[]>();
  for (const row of scored) {
    const list = byTicker.get(row.ticker) ?? [];
    list.push(row);
    byTicker.set(row.ticker, list);
  }

  const corrRows: BrandCorrRow[] = [];
  for (const ticker of tickers) {
    const parent = getParentByTicker(ticker);
    const rows = byTicker.get(ticker) ?? [];
    const x = rows.map((r) => r.yoyQtdPct);
    const y = rows.map((r) => r.actualRevenueGrowth);
    const r =
      x.length >= 2 ? calculatePearson(x, y) : Number.NaN;
    corrRows.push({
      ticker,
      parentName: parent?.name ?? ticker,
      n: rows.length,
      correlation: Number.isFinite(r) ? Math.round(r * 100) / 100 : NaN,
    });
  }
  corrRows.sort((a, b) => {
    const ar = Number.isFinite(a.correlation) ? a.correlation : -Infinity;
    const br = Number.isFinite(b.correlation) ? b.correlation : -Infinity;
    return br - ar;
  });

  console.log("── Summary ───────────────────────────────────────────────────\n");
  console.log("┌────────────────────────────────────┬──────────────────────────┐");
  console.log("│ Metric                             │ Value                    │");
  console.log("├────────────────────────────────────┼──────────────────────────┤");
  console.log(
    `│ ${pad("Total Signals Triggered (Δ>15)", 34)} │ ${pad(String(signals.length), 24)} │`
  );
  console.log(
    `│ ${pad("Earnings Prediction Accuracy", 34)} │ ${pad(`${accuracyPct.toFixed(1)}% (${correct}/${signals.length})`, 24)} │`
  );
  console.log("└────────────────────────────────────┴──────────────────────────┘");

  console.log("\n── Brand Correlation Profile (Search YoY vs Actual Rev YoY) ─\n");
  console.log("┌────────┬──────────────────────────────┬──────┬──────────────┐");
  console.log("│ Ticker │ Brand                        │   n  │ Pearson r    │");
  console.log("├────────┼──────────────────────────────┼──────┼──────────────┤");
  for (const row of corrRows) {
    const rLabel = Number.isFinite(row.correlation)
      ? (row.correlation >= 0 ? "+" : "") + row.correlation.toFixed(2)
      : "n/a";
    console.log(
      `│ $${pad(row.ticker, 5)} │ ${pad(row.parentName, 28)} │ ${String(row.n).padStart(4)} │ ${pad(rLabel, 12)} │`
    );
  }
  console.log("└────────┴──────────────────────────────┴──────┴──────────────┘");

  console.log(
    `\n  Scanned ${events.length} events · QTD-scored: ${scored.length} · no QTD YoY: ${noYoy} · parents: ${parentCompanies.length}\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nEarnings accuracy tester failed:", err);
    process.exit(1);
  });
