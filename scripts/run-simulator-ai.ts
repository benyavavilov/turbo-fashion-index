/**
 * run-simulator-ai.ts — AI-Filtered Walk-Forward Simulator
 *
 * V5 math (conviction weighting, 30-day cooldowns, T-Bill sweeps, slippage)
 * plus Gemini Context Engine veto: scandal spikes are skipped; organic /
 * positive demand proceeds. Exports AI bullish/bearish factors for fact-check.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/run-simulator-ai.ts
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import * as fs from "fs";
import path from "node:path";
import YahooFinance from "yahoo-finance2";
import { z } from "zod";

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
import { cleanLlmJsonText } from "../lib/sentiment-parse";

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
/** Round-trip trading friction (applied on each buy and each sell). */
const SLIPPAGE_RATE = 0.002;
const YAHOO_PAUSE_MS = 500;
/** Gemini context window pinned around each math trigger. */
const AI_CONTEXT_LOOKBACK_DAYS = 14;
const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;
/** Polite pause between Gemini calls during the walk-forward. */
const AI_PAUSE_MS = 400;

const STARTING_CAPITAL = 10_000;
/** Flat annual risk-free rate: Sharpe + idle T-Bill yield (weekly = / 52). */
const ANNUAL_RFR = 0.04;
const WEEKLY_RFR = ANNUAL_RFR / 52;

const yahooFinance = new YahooFinance();

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// Gemini Context Engine (strict anti-hallucination)
// ---------------------------------------------------------------------------

export const AiCatalystSchema = z.object({
  bullish_factor: z.string().min(1),
  bearish_factor: z.string().min(1),
  final_verdict: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL"]),
  confidence: z.number().min(1).max(10),
});

export type AiCatalystVerdict = z.infer<typeof AiCatalystSchema>;

const AI_FALLBACK_VERDICT: AiCatalystVerdict = {
  bullish_factor: "None found",
  bearish_factor: "None found",
  final_verdict: "NEUTRAL",
  confidence: 1,
};

function isModelNotFoundError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const lower = message.toLowerCase();
  return lower.includes("404") || lower.includes("not found");
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Exact [start, end] window ending on `asOfDate` (YYYY-MM-DD). */
function aiDateWindow(
  asOfDate: string,
  lookbackDays: number = AI_CONTEXT_LOOKBACK_DAYS
): { startDate: string; endDate: string } {
  const end = new Date(`${normalizeDateString(asOfDate)}T12:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  return { startDate: formatIsoDate(start), endDate: formatIsoDate(end) };
}

function buildAiSystemPrompt(
  brand: string,
  startDate: string,
  endDate: string
): string {
  return `You are a highly skeptical Chief Investment Officer. I am giving you a specific 14-day window where search volume for a brand spiked. Use Google Search to find financial or product news strictly from that window. CRITICAL ANTI-HALLUCINATION RULE: Brands rarely have massive news. If you cannot find a major headline, do NOT fabricate one. It is highly likely the spike is just organic, 'boring' consumer demand for their clothes. If there is no specific news, return 'None found' and rate the verdict 'POSITIVE' (organic demand). ONLY rate the verdict 'NEGATIVE' if you find concrete proof of a brand-destroying scandal, boycott, or bankruptcy threat.

Brand: '${brand}'
Date window: ${startDate} to ${endDate}
You MUST restrict your Google Search to news published strictly between ${startDate} and ${endDate}.

Return a strict JSON object with exactly these four keys:
- 'bullish_factor': strongest positive financial/product news in that window (or "None found")
- 'bearish_factor': strongest negative news/scandal in that window (or "None found")
- 'final_verdict': 'POSITIVE', 'NEGATIVE', or 'NEUTRAL'
- 'confidence': number from 1 to 10`;
}

/**
 * Gemini Search grounding for a math-triggered spike.
 * Cached by brand + date window to avoid repeat calls in the walk-forward.
 */
const aiVerdictCache = new Map<string, AiCatalystVerdict>();

async function analyzeSpikeWithAi(
  brand: string,
  asOfDate: string
): Promise<AiCatalystVerdict> {
  const { startDate, endDate } = aiDateWindow(asOfDate);
  const cacheKey = `${brand}|${startDate}|${endDate}`;
  const cached = aiVerdictCache.get(cacheKey);
  if (cached) return cached;

  const apiKey = process.env[GOOGLE_API_KEY_ENV];
  if (!apiKey) {
    console.warn(
      `  [AI] Missing ${GOOGLE_API_KEY_ENV} — defaulting to NEUTRAL (no veto).`
    );
    aiVerdictCache.set(cacheKey, AI_FALLBACK_VERDICT);
    return AI_FALLBACK_VERDICT;
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const prompt = buildAiSystemPrompt(brand, startDate, endDate);

  console.log(
    `  [AI] Investigating ${brand} spike ${startDate} → ${endDate}…`
  );

  for (const modelId of GOOGLE_MODEL_IDS) {
    try {
      // Prefer generateObject + schema. Gemini Search grounding may require
      // generateText in this AI SDK — fall through on failure.
      try {
        const { object } = await generateObject({
          model: google(modelId),
          schema: AiCatalystSchema,
          // @ts-ignore - Bypassing Vercel AI SDK strict type mismatch for tools
          tools: {
            google_search: google.tools.googleSearch({}),
          },
          prompt,
        });
        aiVerdictCache.set(cacheKey, object);
        await sleep(AI_PAUSE_MS);
        return object;
      } catch (objectError) {
        console.warn(
          `  [AI] generateObject ${modelId} failed, trying generateText:`,
          objectError
        );
      }

      const { text } = await generateText({
        model: google(modelId),
        // @ts-ignore - Bypassing Vercel AI SDK strict type mismatch for tools
        tools: {
          google_search: google.tools.googleSearch({}),
        },
        prompt,
      });
      const parsed = AiCatalystSchema.safeParse(
        JSON.parse(cleanLlmJsonText(text ?? ""))
      );
      if (parsed.success) {
        aiVerdictCache.set(cacheKey, parsed.data);
        await sleep(AI_PAUSE_MS);
        return parsed.data;
      }
      console.warn(`  [AI] Zod parse failed for ${modelId}:`, text);
    } catch (error) {
      console.warn(`  [AI] ${modelId} failed:`, error);
      if (!isModelNotFoundError(error)) continue;
    }
  }

  console.warn(
    `  [AI] All models failed for ${brand} @ ${asOfDate} — defaulting to NEUTRAL.`
  );
  aiVerdictCache.set(cacheKey, AI_FALLBACK_VERDICT);
  return AI_FALLBACK_VERDICT;
}

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
  /** Gemini Context Engine factors at entry (fact-check export). */
  aiBullishFactor: string;
  aiBearishFactor: string;
  aiVerdict: AiCatalystVerdict["final_verdict"];
  aiConfidence: number;
}

type ExitReason = "max_hold" | "early_yoy" | "forced_eod";

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
  aiBullishFactor: string;
  aiBearishFactor: string;
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
}): { trade: ClosedTrade; sellFee: number; netProceeds: number } {
  const { pos, exitBar, spxBars, exitReason } = input;
  const grossProceeds = pos.shares * exitBar.close;
  const sellFee = grossProceeds * SLIPPAGE_RATE;
  const proceeds = grossProceeds - sellFee;
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
      exitPrice: exitBar.close,
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
      aiBullishFactor: pos.aiBullishFactor,
      aiBearishFactor: pos.aiBearishFactor,
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
    "=== TURBO FASHION INDEX: AI-FILTERED SIMULATION REPORT ===",
    `Starting Capital:, ${fmtCsvUsd(summary.startingCapital)}`,
    `Final Portfolio Value:, ${fmtCsvUsd(summary.finalPortfolioValue)}`,
    `V5+AI Strategy Return:, ${fmtCsvPct(summary.strategyReturnPct)}`,
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
      "AI Bullish Factor",
      "AI Bearish Factor",
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
        csvEscape(t.aiBullishFactor),
        csvEscape(t.aiBearishFactor),
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
  console.log("║  AI-Filtered Walk-Forward Simulator (V5 + Gemini)        ║");
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
    `Entry: YoY > ${YOY_GROWTH_THRESHOLD}% · r > ${MIN_POSITIVE_CORR} · then Gemini ${AI_CONTEXT_LOOKBACK_DAYS}d veto`
  );
  console.log(
    `Exit: early if YoY < ${EARLY_EXIT_YOY_THRESHOLD}% after ${MIN_HOLD_WEEKS_BEFORE_EARLY_EXIT}w · else max ${HOLD_DAYS}d (~${HOLD_WEEKS}w)`
  );
  console.log(
    `Cooldown: no re-buy of same brand for ${COOLDOWN_DAYS}d (~${COOLDOWN_WEEKS}w) after sell`
  );
  console.log(
    `Idle cash: ${ANNUAL_RFR * 100}% T-Bill · Friction: ${SLIPPAGE_RATE * 100}% per side · Rolling Catalyst: re-trigger extends hold`
  );
  console.log(
    `AI: NEGATIVE = scandal veto · POSITIVE/NEUTRAL = allow buy (organic demand OK)`
  );
  console.log(
    `Window: last ${SIM_YEARS}y of trading (first year reserved for YoY baseline)\n`
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
  let catalystExtensions = 0;
  let aiVetos = 0;
  let aiInvestigations = 0;
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
    // SELL: max hold (13w / 90d) OR early YoY crash after ≥ 3 weeks
    // ------------------------------------------------------------------
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

      const exitReason: ExitReason = isLastWeek && !maxHoldReached && !earlyYoYCrash
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
      if (exitReason === "early_yoy") earlyExits += 1;
      open.splice(i, 1);
    }

    if (!isLastWeek) {
      // ------------------------------------------------------------------
      // SCAN → BUY funnel: Math → Held → Cooldown → Capital → AI Bouncer
      // Gemini is only called when a BUY is about to execute.
      // ------------------------------------------------------------------
      const rawTriggers: WeekTrigger[] = [];
      for (const b of brands) {
        const idx = seriesIndexOnOrBefore(b, weekDate);
        if (idx == null) continue;

        // Step A: Math gate
        const yoyGrowth = yoyGrowthAt(b.series, idx);
        const stockBars = stockBarsByTicker.get(b.ticker)!;
        const correlation = correlationAsOf(b.series, stockBars, weekDate);
        if (
          yoyGrowth == null ||
          yoyGrowth < YOY_GROWTH_THRESHOLD ||
          !Number.isFinite(correlation) ||
          correlation < MIN_POSITIVE_CORR
        ) {
          continue;
        }

        const score = convictionScore(yoyGrowth, correlation);
        rawTriggers.push({
          brand: b.brand,
          parentName: b.parentName,
          ticker: b.ticker,
          date: b.series[idx].date,
          yoyGrowthPct: yoyGrowth,
          correlation: Math.round(correlation * 100) / 100,
          convictionScore: Math.round(score * 10) / 10,
        });
      }

      // One signal per ticker: keep highest conviction if multiple brands fire.
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
      const buyable: { signal: WeekTrigger; entryBar: WeeklyBar }[] = [];

      for (const signal of candidates) {
        // Step B: already held → Rolling Catalyst only (no AI, no new buy)
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
          catalystExtensions += 1;
          continue;
        }

        // Step C: post-sale cooldown
        const soldOn = lastSoldDate[signal.brand];
        if (soldOn != null) {
          const daysSinceSell = daysBetween(soldOn, weekDate);
          if (daysSinceSell <= COOLDOWN_DAYS) continue;
        }

        const bars = stockBarsByTicker.get(signal.ticker);
        if (!bars) continue;
        const entryBar =
          nearestOnOrAfter(bars, weekDate) ?? nearestOnOrBefore(bars, weekDate);
        if (!entryBar || entryBar.close <= 0) continue;
        buyable.push({ signal, entryBar });
      }

      if (buyable.length > 0 && cash > 0) {
        const portfolioValue =
          cash + markToMarket(open, stockBarsByTicker, weekDate);
        // Step D: capital / conviction sizing (who is actually fundable)
        const deployable = cash / (1 + SLIPPAGE_RATE);
        const allocations = allocateByConviction(
          buyable,
          deployable,
          portfolioValue
        );

        for (const { signal, entryBar, allocation } of allocations) {
          const buyFee = allocation * SLIPPAGE_RATE;
          const totalDebit = allocation + buyFee;
          if (totalDebit > cash + 1e-9) continue;

          // Step E: AI Bouncer — only when we are about to BUY
          aiInvestigations += 1;
          const ai = await analyzeSpikeWithAi(signal.brand, signal.date);
          if (ai.final_verdict === "NEGATIVE") {
            aiVetos += 1;
            console.log(
              `  [AI VETO] Skipping BUY ${signal.brand} (${signal.ticker}) @ ${signal.date} — scandal: ${ai.bearish_factor}`
            );
            continue;
          }

          const shares = allocation / entryBar.close;
          cash -= totalDebit;
          totalFeesPaid += buyFee;
          open.push({
            ticker: signal.ticker,
            brand: signal.brand,
            parentName: signal.parentName,
            originalEntryDate: entryBar.date,
            entryDate: entryBar.date,
            entryWeekIdx: w,
            entryPrice: entryBar.close,
            shares,
            cost: allocation,
            buyFee,
            yoyGrowthPct: signal.yoyGrowthPct,
            correlation: signal.correlation,
            convictionScore: signal.convictionScore,
            aiBullishFactor: ai.bullish_factor,
            aiBearishFactor: ai.bearish_factor,
            aiVerdict: ai.final_verdict,
            aiConfidence: ai.confidence,
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
  console.log("│  AI-Filtered Walk-Forward Simulator (V5 + Gemini)        │");
  console.log("├──────────────────────────────────────────────────────────┤");
  console.log(
    `│  Starting Capital            ${pad(fmtUsd(STARTING_CAPITAL), 26)}│`
  );
  console.log(
    `│  Final Portfolio Value       ${pad(fmtUsd(finalValue), 26)}│`
  );
  console.log(
    `│  AI-Filtered Strategy Ret    ${pad(fmtPct(strategyReturnPct), 26)}│`
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
    `│  Rolling Catalyst Ext.       ${pad(String(catalystExtensions), 26)}│`
  );
  console.log(
    `│  AI Investigations           ${pad(String(aiInvestigations), 26)}│`
  );
  console.log(
    `│  AI Scandal Vetos            ${pad(String(aiVetos), 26)}│`
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
            : "";
      console.log(
        `  ${t.entryDate}→${t.exitDate}  ${t.ticker.padEnd(6)} ${pad(t.brand, 16)} ${fmtPct(t.returnPct)}  α ${fmtPct(t.alphaPct)}  PnL ${fmtUsd(t.pnl)}${tag}`
      );
    }
    console.log("");
  }

  const tradeLogPath = path.join(process.cwd(), "simulator_ai_trades.csv");
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
  console.log("📊 Full trade log exported to simulator_ai_trades.csv");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFatal simulator error:", err);
    process.exit(1);
  });
