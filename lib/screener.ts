import type { TrendDatum } from "@/lib/chart-data";
import {
  consolidateRowsByDate,
  mergeStockPrices,
  normalizeDateString,
} from "@/lib/chart-data";
import { calculatePearson } from "@/lib/math";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const SCREENER_SPIKE_LOOKBACK_DAYS = 30;
export const SCREENER_TREND_WINDOW_DAYS = 90;
export const SCREENER_CORR_YEARS = 2;

export type StrategyId = "momentum" | "macro" | "contrarian";
export type StrategyRisk = "High Risk" | "Low Risk" | "Opportunistic";

export interface StrategyPick {
  strategyId: StrategyId;
  strategyName: string;
  riskLevel: StrategyRisk;
  brand: string;
  ticker: string;
  /** Human-readable metric, e.g. "+32 pt spike" or "r = +0.81" */
  dataPoint: string;
  /** Numeric intensity used to pick the Breaking Catalyst */
  anomalyScore: number;
  asOfDate: string;
  /** Strict 1–3 word action, e.g. STRONG BUY / SHORT / ACCUMULATE */
  verdict: string;
  /** Exactly two short bullet strings (catalyst + risk). */
  bullets: [string, string];
  sentiment?: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  /** Latest stock close used when adding to paper portfolio (if available). */
  lastPrice?: number | null;
}

export interface BreakingCatalyst {
  strategyId: StrategyId;
  brand: string;
  ticker: string;
  headline: string;
  dataPoint: string;
  verdict: string;
  bullets: [string, string];
  anomalyScore: number;
}

export interface StrategyRankerResponse {
  strategies: StrategyPick[];
  breakingCatalyst: BreakingCatalyst | null;
  scannedBrands: number;
  generatedAt: string;
}

function dateToMs(dateStr: string): number {
  return new Date(`${normalizeDateString(dateStr)}T12:00:00`).getTime();
}

export interface TrendPoint {
  date: string;
  value: number;
}

export interface BrandMetrics {
  brand: string;
  ticker: string;
  series: TrendPoint[];
  /** Largest positive rise vs trailing 30d min within lookback. */
  spikeIncrease: number;
  spikeDate: string;
  /** Sharpest drop vs trailing 30d max within lookback (negative or zero). */
  dropDecrease: number;
  dropDate: string;
  /** Net change: latest − value ~30d earlier (or first available). */
  recentNetChange: number;
  correlation: number | null;
}

/** Extract a single brand's interest series from wide chart rows. */
export function extractBrandSeries(
  data: TrendDatum[],
  brand: string
): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (const row of data) {
    const v = row[brand];
    if (typeof v === "number" && !Number.isNaN(v)) {
      points.push({ date: normalizeDateString(String(row.date)), value: v });
    }
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Largest positive spike in lookback (threshold 0 — always returns best rise,
 * or null only if series is empty).
 */
export function findLargestPositiveMove(
  series: TrendPoint[],
  lookbackDays = SCREENER_SPIKE_LOOKBACK_DAYS
): { date: string; value: number; increase: number } | null {
  if (series.length < 2) return null;

  const latestMs = dateToMs(series[series.length - 1].date);
  const lookbackStart = latestMs - lookbackDays * MS_PER_DAY;

  let best: { date: string; value: number; increase: number } | null = null;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    const pointMs = dateToMs(point.date);
    if (pointMs < lookbackStart) continue;

    let trailingMin = point.value;
    for (let j = 0; j <= i; j++) {
      const prior = series[j];
      const daysBack = (pointMs - dateToMs(prior.date)) / MS_PER_DAY;
      if (daysBack < 0 || daysBack > lookbackDays) continue;
      trailingMin = Math.min(trailingMin, prior.value);
    }

    const increase = point.value - trailingMin;
    if (increase > 0 && (!best || increase > best.increase)) {
      best = { date: point.date, value: point.value, increase };
    }
  }

  return best;
}

/** Sharpest drop in lookback (most negative peak-to-point move). */
export function findSharpestDrop(
  series: TrendPoint[],
  lookbackDays = SCREENER_SPIKE_LOOKBACK_DAYS
): { date: string; value: number; decrease: number } | null {
  if (series.length < 2) return null;

  const latestMs = dateToMs(series[series.length - 1].date);
  const lookbackStart = latestMs - lookbackDays * MS_PER_DAY;

  let worst: { date: string; value: number; decrease: number } | null = null;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    const pointMs = dateToMs(point.date);
    if (pointMs < lookbackStart) continue;

    let trailingMax = point.value;
    for (let j = 0; j <= i; j++) {
      const prior = series[j];
      const daysBack = (pointMs - dateToMs(prior.date)) / MS_PER_DAY;
      if (daysBack < 0 || daysBack > lookbackDays) continue;
      trailingMax = Math.max(trailingMax, prior.value);
    }

    const decrease = point.value - trailingMax; // ≤ 0
    if (decrease < 0 && (!worst || decrease < worst.decrease)) {
      worst = { date: point.date, value: point.value, decrease };
    }
  }

  return worst;
}

export function recentNetChange(
  series: TrendPoint[],
  lookbackDays = SCREENER_SPIKE_LOOKBACK_DAYS
): number {
  if (series.length === 0) return 0;
  const latest = series[series.length - 1];
  const latestMs = dateToMs(latest.date);
  const target = latestMs - lookbackDays * MS_PER_DAY;

  let anchor = series[0];
  for (const p of series) {
    if (dateToMs(p.date) <= target) anchor = p;
    else break;
  }
  return latest.value - anchor.value;
}

/** @deprecated Prefer findLargestPositiveMove — kept for compatibility. */
export function findRecentSpike(
  series: TrendPoint[],
  threshold = 0,
  lookbackDays = SCREENER_SPIKE_LOOKBACK_DAYS
): { date: string; value: number; increase: number } | null {
  const move = findLargestPositiveMove(series, lookbackDays);
  if (!move || move.increase < threshold) return null;
  return move;
}

/** Pearson between search interest and stock close over aligned dates. */
export function correlationTrendVsStock(
  trendSeries: TrendPoint[],
  stockByDate: Map<string, number>
): number {
  const trendRows: TrendDatum[] = trendSeries.map((p) => ({
    date: p.date,
    interest: p.value,
  }));

  const merged = mergeStockPrices(trendRows, stockByDate, "stock");
  const trends: number[] = [];
  const stocks: number[] = [];

  for (const row of consolidateRowsByDate(merged)) {
    const t = row.interest;
    const s = row.stock;
    if (
      typeof t === "number" &&
      typeof s === "number" &&
      !Number.isNaN(t) &&
      !Number.isNaN(s)
    ) {
      trends.push(t);
      stocks.push(s);
    }
  }

  return calculatePearson(trends, stocks);
}

export function sliceSeriesByDays(
  series: TrendPoint[],
  days: number
): TrendPoint[] {
  if (series.length === 0) return [];
  const latestMs = dateToMs(series[series.length - 1].date);
  const cutoff = latestMs - days * MS_PER_DAY;
  return series.filter((p) => dateToMs(p.date) >= cutoff);
}

export function formatSpikeDataPoint(increase: number): string {
  const rounded = Math.round(increase * 10) / 10;
  return `${rounded >= 0 ? "+" : ""}${rounded} pt spike`;
}

export function formatDropDataPoint(decrease: number): string {
  const rounded = Math.round(decrease * 10) / 10;
  return `${rounded} pt search drop`;
}

export function formatCorrDataPoint(r: number): string {
  return `r = ${r >= 0 ? "+" : ""}${r.toFixed(2)}`;
}

export function computeBrandMetrics(
  brand: string,
  ticker: string,
  series: TrendPoint[],
  correlation: number | null
): BrandMetrics {
  const window = sliceSeriesByDays(series, SCREENER_TREND_WINDOW_DAYS);
  const working = window.length >= 2 ? window : series;
  const spike = findLargestPositiveMove(working);
  const drop = findSharpestDrop(working);
  const latest = working[working.length - 1];

  return {
    brand,
    ticker,
    series,
    spikeIncrease: spike?.increase ?? 0,
    spikeDate: spike?.date ?? latest?.date ?? "",
    dropDecrease: drop?.decrease ?? 0,
    dropDate: drop?.date ?? latest?.date ?? "",
    recentNetChange: recentNetChange(working),
    correlation,
  };
}

/**
 * Pick strategy tops — always returns 3 slots when metrics exist.
 * Prefers unique brands across strategies when possible.
 */
export function rankStrategyCandidates(metrics: BrandMetrics[]): {
  momentum: BrandMetrics | null;
  macro: BrandMetrics | null;
  contrarian: BrandMetrics | null;
} {
  if (metrics.length === 0) {
    return { momentum: null, macro: null, contrarian: null };
  }

  const bySpike = [...metrics].sort(
    (a, b) => b.spikeIncrease - a.spikeIncrease
  );
  const momentum = bySpike[0] ?? null;

  const withPositiveTrend = metrics
    .filter((m) => m.recentNetChange > 0 || m.spikeIncrease > 0)
    .sort((a, b) => (b.correlation ?? -2) - (a.correlation ?? -2));
  const byCorr = [...metrics].sort(
    (a, b) => (b.correlation ?? -2) - (a.correlation ?? -2)
  );
  let macro = withPositiveTrend[0] ?? byCorr[0] ?? null;
  if (macro && momentum && macro.brand === momentum.brand && withPositiveTrend.length > 1) {
    macro = withPositiveTrend.find((m) => m.brand !== momentum.brand) ?? macro;
  } else if (macro && momentum && macro.brand === momentum.brand && byCorr.length > 1) {
    macro = byCorr.find((m) => m.brand !== momentum.brand) ?? macro;
  }

  const byDrop = [...metrics].sort((a, b) => a.dropDecrease - b.dropDecrease);
  let contrarian = byDrop[0] ?? null;
  const used = new Set(
    [momentum?.brand, macro?.brand].filter(Boolean) as string[]
  );
  if (contrarian && used.has(contrarian.brand)) {
    contrarian =
      byDrop.find((m) => !used.has(m.brand)) ??
      byDrop[0] ??
      null;
  }

  // Prefer a large spike as contrarian candidate if drop is mild — sentiment decides later.
  if (
    contrarian &&
    Math.abs(contrarian.dropDecrease) < 5 &&
    bySpike[0] &&
    bySpike[0].spikeIncrease >= 10
  ) {
    const alt = bySpike.find((m) => !used.has(m.brand) && m.brand !== contrarian!.brand);
    if (alt && alt.spikeIncrease > Math.abs(contrarian.dropDecrease)) {
      // Keep drop-based pick unless sentiment path will re-evaluate; ranking uses drop primarily.
    }
  }

  return { momentum, macro, contrarian };
}
