/**
 * Shared Earnings Whisper Sniper accuracy math.
 * Delta = Search YoY − Wall St Est; fire at |Δ| ≥ 15.
 */

import { normalizeDateString, type TrendDatum } from "@/lib/chart-data";
import { extractBrandSeries, type TrendPoint } from "@/lib/screener";

export const SNIPER_DELTA_THRESHOLD = 15;
export const SNIPER_LEDGER_MIN_DATE = "2024-01-01";

const QTD_LOOKBACK_DAYS = 90;
const YOY_LAG_DAYS = 365;
const MIN_PREV_QTD_SUM = 10;
const YOY_GROWTH_CAP = 250;
const MIN_QTD_POINTS = 4;

export type SniperPrediction = "BEAT" | "MISS" | "NO_SIGNAL";

export interface HistoricalEstimateRow {
  date: string;
  estimatedRevenueGrowth: number;
  actualRevenueGrowth: number;
}

export interface SniperLedgerRow {
  date: string;
  estimated: number;
  actual: number;
  searchYoY: number | null;
  prediction: SniperPrediction | null;
  accuracy: { label: string; correct: boolean | null };
}

export interface SniperAccuracySummary {
  wins: number;
  trades: number;
  winRatePct: number | null;
  /** e.g. "4/5 • 80%" or "—" */
  label: string;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function addCalendarDays(dateStr: string, days: number): string {
  const d = new Date(`${normalizeDateString(dateStr)}T12:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

/** Search YoY: 90d pre-earnings vs same window −1y (avg across child brands). */
export function computeHistoricalSearchYoY(
  earningsDate: string,
  trendData: TrendDatum[],
  brandKeys: string[]
): number | null {
  if (brandKeys.length === 0) return null;

  const end = normalizeDateString(earningsDate);
  const currentEnd = addCalendarDays(end, -1);
  const currentStart = addCalendarDays(end, -QTD_LOOKBACK_DAYS);
  const prevEnd = addCalendarDays(currentEnd, -YOY_LAG_DAYS);
  const prevStart = addCalendarDays(currentStart, -YOY_LAG_DAYS);

  const yoys: number[] = [];
  for (const brand of brandKeys) {
    const series = extractBrandSeries(trendData, brand);
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

export function classifyActualOutcome(
  estimated: number,
  actual: number
): "BEAT" | "MISS" {
  return actual > estimated ? "BEAT" : "MISS";
}

/** 15% Sniper: BEAT / MISS / NO_SIGNAL. */
export function sniperPredictionFromSearch(
  searchYoY: number | null,
  estimated: number,
  threshold = SNIPER_DELTA_THRESHOLD
): SniperPrediction | null {
  if (searchYoY == null) return null;
  const delta = searchYoY - estimated;
  if (delta >= threshold) return "BEAT";
  if (delta <= -threshold) return "MISS";
  return "NO_SIGNAL";
}

export function sniperAccuracyLabel(
  prediction: SniperPrediction | null,
  actual: "BEAT" | "MISS"
): { label: string; correct: boolean | null } {
  if (prediction == null || prediction === "NO_SIGNAL") {
    return { label: "", correct: null };
  }
  const correct = prediction === actual;
  return {
    label: correct ? "CORRECT" : "INCORRECT",
    correct,
  };
}

export function calculateHistoricalSniperAccuracy(
  rows: Array<{
    prediction: SniperPrediction | null;
    accuracy: { correct: boolean | null };
  }>
): SniperAccuracySummary {
  let trades = 0;
  let wins = 0;
  for (const row of rows) {
    if (row.prediction !== "BEAT" && row.prediction !== "MISS") continue;
    trades += 1;
    if (row.accuracy.correct === true) wins += 1;
  }
  if (trades === 0) {
    return { wins: 0, trades: 0, winRatePct: null, label: "—" };
  }
  const winRatePct = Math.round((wins / trades) * 100);
  return {
    wins,
    trades,
    winRatePct,
    label: `${wins}/${trades} • ${winRatePct}%`,
  };
}

export function buildSniperLedgerRows(
  estimates: HistoricalEstimateRow[],
  trendData: TrendDatum[],
  brandKeys: string[],
  options?: { minDate?: string }
): SniperLedgerRow[] {
  const minDate = options?.minDate ?? SNIPER_LEDGER_MIN_DATE;

  return estimates
    .map((row) => {
      const earningsDate = normalizeDateString(row.date);
      if (earningsDate < minDate) return null;

      const searchYoY = computeHistoricalSearchYoY(
        earningsDate,
        trendData,
        brandKeys
      );
      const actual = classifyActualOutcome(
        row.estimatedRevenueGrowth,
        row.actualRevenueGrowth
      );
      const prediction = sniperPredictionFromSearch(
        searchYoY,
        row.estimatedRevenueGrowth
      );
      const accuracy = sniperAccuracyLabel(prediction, actual);
      return {
        date: earningsDate,
        estimated: row.estimatedRevenueGrowth,
        actual: row.actualRevenueGrowth,
        searchYoY,
        prediction,
        accuracy,
      };
    })
    .filter((row): row is SniperLedgerRow => row != null);
}

export function sniperAccuracyForTicker(
  estimates: HistoricalEstimateRow[],
  trendData: TrendDatum[],
  brandKeys: string[],
  options?: { minDate?: string }
): SniperAccuracySummary {
  return calculateHistoricalSniperAccuracy(
    buildSniperLedgerRows(estimates, trendData, brandKeys, options)
  );
}
