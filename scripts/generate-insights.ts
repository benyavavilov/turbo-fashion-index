/**
 * generate-insights.ts
 *
 * Production AI engine (parent-level): Dual-Engine Spike vs YoY math +
 * Wall Street revenue growth estimates (earningsTrend +0q), then Gemini
 * (Google Search grounding) for an Earnings Whisper Asset Profile.
 * Upserts into `ai_insights` with earnings_mismatch.
 *
 * Math sanitization: prior-year 4w MA must be ≥ 15; YoY capped at 250%.
 * Setup types: VOLATILE_SPIKE (massive short-term) vs STRUCTURAL_YOY (steady).
 *
 * Run with:  npm run generate:insights
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YahooFinance from "yahoo-finance2";
import { z } from "zod";

import {
  mismatchToDirection,
  mismatchToSentiment,
  type EarningsMismatch,
} from "../lib/ai-insights";
import { mergeStockPrices } from "../lib/chart-data";
import { parentCompanies, type ParentCompany } from "../lib/entities";
import { runEventStudy } from "../lib/event-study";
import {
  fetchStockQuotes,
  fetchTrendHistory,
  latestQuote,
} from "../lib/market-data";
import { cleanLlmJsonText } from "../lib/sentiment-parse";
import {
  correlationTrendVsStock,
  extractBrandSeries,
  type TrendPoint,
} from "../lib/screener";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;
const STOCK_KEY = "__stock";
/** Match Dual-Engine / backtest: need full YoY history. */
const YEARS_BACK = 5;
const MA_WEEKS = 4;
const YOY_LAG_WEEKS = 52;
/** Engine 2 structural-trend thresholds. */
const YOY_GROWTH_THRESHOLD = 25;
const MIN_POSITIVE_CORR = 0.15;
/** STRUCTURAL_YOY path requires stronger positive correlation. */
const STRONG_CORR = 0.2;
/** Skip / zero YoY when prior-year 4w MA is below this (law of small numbers). */
const MIN_LAST_YEAR_MA = 15;
/** Winsorize YoY growth so outliers don't dominate Gemini / rankings. */
const YOY_GROWTH_CAP = 250;
/** Absolute interest-point jump (current 4w − prior 4w) that counts as massive. */
const MASSIVE_SPIKE_PTS = 15;
const GEMINI_PAUSE_MS = 500;
const SPX_TICKER = "^GSPC";

export type SetupType = "VOLATILE_SPIKE" | "STRUCTURAL_YOY";

export interface GenerateInsightsResult {
  parents: number;
  ok: number;
  fail: number;
  elapsedSec: number;
}

/** Fluid Earnings Whisper handbook — Gemini synthesizes search vs Street estimates. */
const GeminiInsightSchema = z.object({
  earnings_mismatch: z
    .enum(["BEAT_LIKELY", "MISS_LIKELY", "PRICED_IN"])
    .describe(
      "Delta call: BEAT_LIKELY if search hype outpaces Street revenue growth; MISS_LIKELY if search lags; PRICED_IN if aligned."
    ),
  strategy_profile: z
    .string()
    .min(1)
    .describe(
      "1-sentence custom profile of expected stock behavior into earnings."
    ),
  terminal_verdict: z
    .string()
    .min(1)
    .describe(
      "1-sentence definitive recommendation that states the exact Wall Street revenue estimate and contrasts it with our search signal."
    ),
  the_buzz: z
    .string()
    .min(1)
    .describe(
      "1-2 sentences on the real-world news/catalyst behind search demand (use Google Search; last 6 months only)."
    ),
  the_risk: z
    .string()
    .min(1)
    .describe(
      "1-2 sentences on correlation / estimate risk — warn if r is weak."
    ),
});

type GeminiInsightParsed = z.infer<typeof GeminiInsightSchema>;

interface GeminiInsight {
  earnings_mismatch: EarningsMismatch;
  strategy_profile: string;
  terminal_verdict: string;
  the_buzz: string;
  the_risk: string;
}

function normalizeGeminiInsight(raw: GeminiInsightParsed): GeminiInsight {
  const earnings_mismatch: EarningsMismatch =
    raw.earnings_mismatch === "BEAT_LIKELY" ||
    raw.earnings_mismatch === "MISS_LIKELY" ||
    raw.earnings_mismatch === "PRICED_IN"
      ? raw.earnings_mismatch
      : "PRICED_IN";
  return {
    earnings_mismatch,
    strategy_profile:
      String(raw.strategy_profile ?? "").trim() ||
      "Mixed earnings setup — wait for clearer search vs Street delta.",
    terminal_verdict:
      String(raw.terminal_verdict ?? "").trim() ||
      "Hold for now — search signal and Wall Street revenue estimates are not cleanly misaligned.",
    the_buzz:
      String(raw.the_buzz ?? "").trim() ||
      "Recent catalysts are unclear.",
    the_risk:
      String(raw.the_risk ?? "").trim() ||
      "Historical search↔stock correlation is thin; treat any earnings trade as speculative.",
  };
}

let supabaseClient: SupabaseClient | null = null;
let googleProvider: GoogleGenerativeAIProvider | null = null;
let yahooFinanceClient: InstanceType<typeof YahooFinance> | null = null;

function getSupabase(): SupabaseClient {
  if (supabaseClient) return supabaseClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Supabase credentials. Ensure NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY are set."
    );
  }
  supabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseClient;
}

function getGoogle(): GoogleGenerativeAIProvider {
  if (googleProvider) return googleProvider;
  const apiKey = process.env[GOOGLE_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `Missing ${GOOGLE_API_KEY_ENV}. Set it to generate insights.`
    );
  }
  googleProvider = createGoogleGenerativeAI({ apiKey });
  return googleProvider;
}

function getYahoo(): InstanceType<typeof YahooFinance> {
  if (!yahooFinanceClient) yahooFinanceClient = new YahooFinance();
  return yahooFinanceClient;
}

// ---------------------------------------------------------------------------
// Yahoo fundamentals + macro regime
// ---------------------------------------------------------------------------

interface ParentFundamentals {
  trailingPE: string;
  forwardPE: string;
  peLabel: string;
  nextEarnings: string;
  recommendationKey: string;
  targetMeanPrice: string;
  lastPrice: string;
  /** Current quarter (+0q) Street revenue growth estimate (fmt string). */
  expectedRevenueGrowth: string;
}

const FUNDAMENTALS_NA: ParentFundamentals = {
  trailingPE: "N/A",
  forwardPE: "N/A",
  peLabel: "N/A",
  nextEarnings: "N/A",
  recommendationKey: "N/A",
  targetMeanPrice: "N/A",
  lastPrice: "N/A",
  expectedRevenueGrowth: "N/A",
};

function formatNum(value: unknown, digits = 2): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "N/A";
  return value.toFixed(digits);
}

function formatEarningsTimestamp(value: unknown): string {
  if (value == null) return "N/A";
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    // Yahoo often returns unix seconds
    date = new Date(value > 1e12 ? value : value * 1000);
  } else if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date || Number.isNaN(date.getTime())) return "N/A";
  return date.toISOString().slice(0, 10);
}

/**
 * Recent ~30-day S&P 500 performance → macro regime string for the prompt.
 */
async function fetchSpxMacroRegime(): Promise<{
  label: string;
  changePct: number | null;
}> {
  try {
    const period1 = new Date();
    period1.setDate(period1.getDate() - 40);
    const chart = await getYahoo().chart(SPX_TICKER, {
      period1,
      period2: new Date(),
      interval: "1d",
    });
    const rawQuotes =
      (chart as { quotes?: { date?: Date; close?: number | null }[] }).quotes ??
      [];
    const closes = rawQuotes
      .filter((q) => q.close != null && q.date != null)
      .map((q) => ({
        date: new Date(q.date as Date).getTime(),
        close: q.close as number,
      }))
      .sort((a, b) => a.date - b.date);

    if (closes.length < 2) {
      return { label: "S&P 500 regime unavailable (N/A)", changePct: null };
    }

    const latest = closes[closes.length - 1];
    const cutoff = latest.date - 30 * 24 * 60 * 60 * 1000;
    let anchor = closes[0];
    for (const pt of closes) {
      if (pt.date <= cutoff) anchor = pt;
      else break;
    }

    const changePct =
      Math.round(((latest.close - anchor.close) / anchor.close) * 1000) / 10;
    const direction = changePct >= 0 ? "UP" : "DOWN";
    const abs = Math.abs(changePct).toFixed(1);
    return {
      label: `S&P 500 is ${direction} ${abs}% over the last ~30 days`,
      changePct,
    };
  } catch (error) {
    console.warn("  [macro] Failed to fetch ^GSPC regime:", error);
    return { label: "S&P 500 regime unavailable (N/A)", changePct: null };
  }
}

async function fetchParentFundamentals(
  ticker: string
): Promise<ParentFundamentals> {
  try {
    // Street consensus + current-quarter revenue growth estimate.
    const quoteSummary = (await getYahoo().quoteSummary(ticker, {
      modules: ["financialData", "earningsTrend"],
    })) as {
      financialData?: {
        recommendationKey?: string | null;
        targetMeanPrice?: number | null;
        currentPrice?: number | null;
      } | null;
      earningsTrend?: {
        trend?: Array<{
          period?: string | null;
          revenueEstimate?: {
            growth?: { raw?: number | null; fmt?: string | null } | number | null;
            avg?: { raw?: number | null; fmt?: string | null } | null;
          } | null;
        }> | null;
      } | null;
    };

    const financialData = quoteSummary?.financialData;
    const recommendationKey =
      financialData &&
      typeof financialData.recommendationKey === "string" &&
      financialData.recommendationKey.trim()
        ? financialData.recommendationKey.trim().toLowerCase()
        : "N/A";
    const targetMeanPrice =
      financialData &&
      typeof financialData.targetMeanPrice === "number" &&
      !Number.isNaN(financialData.targetMeanPrice)
        ? `$${formatNum(financialData.targetMeanPrice)}`
        : "N/A";

    const currentQuarterTrend = quoteSummary.earningsTrend?.trend?.find(
      (t) => t.period === "+0q" || t.period === "0q"
    );
    let expectedRevenueGrowth = "N/A";
    const growth = currentQuarterTrend?.revenueEstimate?.growth as
      | { raw?: number | null; fmt?: string | null }
      | number
      | null
      | undefined;
    if (growth != null && typeof growth === "object") {
      if (growth.fmt) {
        expectedRevenueGrowth = String(growth.fmt);
      } else if (typeof growth.raw === "number" && Number.isFinite(growth.raw)) {
        expectedRevenueGrowth =
          Math.abs(growth.raw) <= 2
            ? `${(growth.raw * 100).toFixed(1)}%`
            : `${growth.raw.toFixed(1)}%`;
      }
    } else if (typeof growth === "number" && Number.isFinite(growth)) {
      // yahoo-finance2 often returns a raw fraction (e.g. 0.032 → 3.2%).
      expectedRevenueGrowth =
        Math.abs(growth) <= 2
          ? `${(growth * 100).toFixed(1)}%`
          : `${growth.toFixed(1)}%`;
    }

    // Soft enrichment for valuation / earnings / last price (optional).
    let trailingPE = "N/A";
    let forwardPE = "N/A";
    let nextEarnings = "N/A";
    let lastPrice =
      financialData &&
      typeof financialData.currentPrice === "number" &&
      !Number.isNaN(financialData.currentPrice)
        ? `$${formatNum(financialData.currentPrice)}`
        : "N/A";

    try {
      const q = (await getYahoo().quote(ticker)) as Record<string, unknown>;
      trailingPE = formatNum(q.trailingPE);
      forwardPE = formatNum(q.forwardPE);
      nextEarnings = formatEarningsTimestamp(
        q.earningsTimestamp ??
          q.earningsTimestampStart ??
          q.earningsTimestampEnd ??
          null
      );
      if (
        lastPrice === "N/A" &&
        typeof q.regularMarketPrice === "number" &&
        !Number.isNaN(q.regularMarketPrice)
      ) {
        lastPrice = `$${formatNum(q.regularMarketPrice)}`;
      }
    } catch {
      // Valuation extras are optional — Street consensus already resolved above.
    }

    const peLabel =
      trailingPE !== "N/A"
        ? `trailing P/E ${trailingPE}`
        : forwardPE !== "N/A"
          ? `forward P/E ${forwardPE}`
          : "N/A";

    return {
      trailingPE,
      forwardPE,
      peLabel,
      nextEarnings,
      recommendationKey,
      targetMeanPrice,
      lastPrice,
      expectedRevenueGrowth,
    };
  } catch (error) {
    console.warn(`  [fundamentals] quoteSummary failed for ${ticker}:`, error);
    return { ...FUNDAMENTALS_NA };
  }
}

// ---------------------------------------------------------------------------
// Dual-Engine math (Spike + sanitized YoY)
// ---------------------------------------------------------------------------

function sortSeriesChronologically(series: TrendPoint[]): TrendPoint[] {
  return [...series].sort((a, b) => {
    const cmp = a.date.localeCompare(b.date);
    if (cmp !== 0) return cmp;
    return a.value - b.value;
  });
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
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

/**
 * Engine 1 — Short-term spike:
 * current 4w MA − previous 4w MA (interest points).
 * Drops the trailing incomplete week before measuring.
 */
export function computeShortTermSpikePts(series: TrendPoint[]): number | null {
  const sorted = sortSeriesChronologically(series);
  const cleanData = sorted.length > 0 ? sorted.slice(0, -1) : sorted;
  if (cleanData.length < MA_WEEKS * 2) return null;

  const i = cleanData.length - 1;
  const currentMa = maEndingAt(cleanData, i);
  const priorMa = maEndingAt(cleanData, i - MA_WEEKS);
  if (currentMa == null || priorMa == null) return null;
  return Math.round((currentMa - priorMa) * 10) / 10;
}

/**
 * Engine 2 — YoY % growth of search interest:
 * ((Current 4w MA − Last-year 4w MA) / Last-year 4w MA) * 100
 *
 * Sanitization:
 *   - If prior-year 4w MA < MIN_LAST_YEAR_MA → return 0 (law of small numbers)
 *   - Cap absolute YoY at YOY_GROWTH_CAP (±250%)
 */
export function computeYoYGrowthPct(series: TrendPoint[]): number | null {
  const sorted = sortSeriesChronologically(series);
  const cleanData = sorted.length > 0 ? sorted.slice(0, -1) : sorted;
  if (cleanData.length < YOY_LAG_WEEKS + MA_WEEKS) return null;

  const i = cleanData.length - 1;
  const currentMa = maEndingAt(cleanData, i);
  const yIdx = yearAgoIndex(cleanData, i);
  if (yIdx == null) return null;
  const lastYearMa = maEndingAt(cleanData, yIdx);

  if (currentMa == null || lastYearMa == null) return null;
  if (!Number.isFinite(lastYearMa) || Math.abs(lastYearMa) < 1e-6) return null;

  // Denominator baseline — prevent 1050% glitches from tiny prior-year averages.
  if (lastYearMa < MIN_LAST_YEAR_MA) return 0;

  let yoy = ((currentMa - lastYearMa) / lastYearMa) * 100;
  if (!Number.isFinite(yoy)) return null;

  if (yoy > YOY_GROWTH_CAP) yoy = YOY_GROWTH_CAP;
  if (yoy < -YOY_GROWTH_CAP) yoy = -YOY_GROWTH_CAP;

  return Math.round(yoy * 10) / 10;
}

/**
 * Classify Dual-Engine setup:
 *   VOLATILE_SPIKE  — massive short-term spike (needs Google Search WHY)
 *   STRUCTURAL_YOY  — steady / strong YoY without a massive short-term jolt
 */
export function classifySetupType(
  spikePts: number | null,
  yoyGrowth: number | null
): SetupType {
  const spikeAbs =
    spikePts != null && Number.isFinite(spikePts) ? Math.abs(spikePts) : 0;
  const yoy =
    yoyGrowth != null && Number.isFinite(yoyGrowth) ? yoyGrowth : 0;

  if (spikeAbs >= MASSIVE_SPIKE_PTS) return "VOLATILE_SPIKE";
  if (yoy > YOY_GROWTH_THRESHOLD) return "STRUCTURAL_YOY";
  // Mild residual: spike still the louder story → treat as volatile.
  if (spikeAbs >= 8 && spikeAbs >= yoy / 10) return "VOLATILE_SPIKE";
  return "STRUCTURAL_YOY";
}

/** @deprecated Prefer computeYoYGrowthPct — kept for any external imports. */
export function computeMomentum4v4(series: TrendPoint[]): number | null {
  return computeYoYGrowthPct(series);
}

/** @deprecated Prefer computeYoYGrowthPct. */
export function computeMomentum30v30(series: TrendPoint[]): number | null {
  return computeYoYGrowthPct(series);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

interface ChildBrandSignal {
  brand: string;
  /** Engine 1: current 4w MA − prior 4w MA (interest points). */
  spikePts: number | null;
  /** Engine 2: sanitized YoY % growth of 4w search MA vs same season last year. */
  yoyGrowth: number | null;
  correlation: number | null;
  avgReturnPct: number | null;
  eventCount: number;
  setupType: SetupType;
}

function buildGeminiPrompt(input: {
  parent: ParentCompany;
  setupType: SetupType;
  avgSpikePts: number | null;
  avgYoYGrowth: number | null;
  avgCorrelation: number | null;
  avgReturnPct: number | null;
  eventCount: number;
  children: ChildBrandSignal[];
  macroRegime: string;
  fundamentals: ParentFundamentals;
  wallStreetConsensus: string;
  expectedRevenueGrowth: string;
}): string {
  const childLines = input.children
    .map((c) => {
      const spike =
        c.spikePts != null
          ? `${c.spikePts >= 0 ? "+" : ""}${c.spikePts.toFixed(1)} pts spike`
          : "spike n/a";
      const yoy =
        c.yoyGrowth != null
          ? `${c.yoyGrowth >= 0 ? "+" : ""}${c.yoyGrowth.toFixed(1)}% YoY`
          : "YoY n/a";
      const corr =
        c.correlation != null
          ? c.correlation < MIN_POSITIVE_CORR
            ? `r=${c.correlation.toFixed(2)} (weak/unpredictable)`
            : `r=${c.correlation.toFixed(2)}`
          : "r=n/a";
      const hist =
        c.avgReturnPct != null && c.eventCount > 0
          ? `historically stock moved about ${c.avgReturnPct >= 0 ? "+" : ""}${c.avgReturnPct.toFixed(1)}% over 90d after past search spikes (${c.eventCount} cases)`
          : "limited event-study history";
      return `- ${c.brand} [${c.setupType}]: ${spike}; ${yoy}; ${corr}; ${hist}`;
    })
    .join("\n");

  const f = input.fundamentals;
  const streetMissing = input.wallStreetConsensus === "N/A";
  const estimateMissing = input.expectedRevenueGrowth === "N/A";

  const corrLabel =
    input.avgCorrelation != null
      ? input.avgCorrelation < MIN_POSITIVE_CORR
        ? `${input.avgCorrelation.toFixed(2)} (< ${MIN_POSITIVE_CORR} — historically unpredictable; lean conservative)`
        : input.avgCorrelation.toFixed(2)
      : "N/A";

  const spikeLabel =
    input.avgSpikePts != null
      ? `${input.avgSpikePts >= 0 ? "+" : ""}${input.avgSpikePts.toFixed(1)} pts`
      : "N/A";
  const yoyLabel =
    input.avgYoYGrowth != null
      ? `${input.avgYoYGrowth >= 0 ? "+" : ""}${input.avgYoYGrowth.toFixed(1)}%`
      : "N/A";

  const currentYear = new Date().getFullYear();

  return `You are the Lead Analyst for an institutional Alternative Data terminal. Your goal is to provide an 'Earnings Whisper' profile for retail investors.

Use plain, jargon-free English. Write custom prose that fits THIS stock — strategy_profile should be a bespoke behavior label into earnings.

## CRITICAL TEMPORAL ANCHOR
The current year is ${currentYear}. You MUST ONLY use your Google Search tool to find news, product launches, or events from the last 6 months. DO NOT reference 2023 or 2024 under any circumstances. If you cannot find recent news, state "Recent catalysts are unclear" rather than fabricating old data.

## THE DELTA DIRECTIVE (Search vs Street Revenue)
Evaluate the Delta: Compare our YoY Search Growth against Wall Street's Expected Revenue Growth. If consumer hype is massively outpacing their revenue estimate, flag as 'BEAT_LIKELY'. If the search data severely lags expectations or is just organic without outpacing estimates, flag as 'MISS_LIKELY' or 'PRICED_IN'.

Our YoY Search Growth: ${yoyLabel}
Wall Street Expected Revenue Growth (current quarter +0q): ${input.expectedRevenueGrowth}
Wall Street recommendationKey: ${input.wallStreetConsensus}
Setup type: ${input.setupType}
Short-term spike: ${spikeLabel}
Pearson correlation (search↔stock): ${corrLabel}

State the exact Wall Street revenue estimate (${input.expectedRevenueGrowth}) in your 'terminal_verdict' to highlight the contrast.

## SETUP CONTEXT
1. STRUCTURAL_YOY with strong positive correlation (> ${STRONG_CORR}) can support BEAT_LIKELY when search clearly outpaces Street revenue growth — steady popularity is enough; you do not need a massive news catalyst.
2. VOLATILE_SPIKE setups MUST use Google Search to find the WHY. Scandal / clearance → lean MISS_LIKELY. Product launch / viral demand outpacing estimates → BEAT_LIKELY.
3. CRITICAL RISK RULE: If historical Pearson correlation is weak or negative (r < ${MIN_POSITIVE_CORR}), warn that this brand is historically unpredictable and lean PRICED_IN / conservative even if searches are high.

## Directives
1. Put the live catalyst (or organic-growth note) in the_buzz.
2. terminal_verdict MUST name the Street revenue estimate (${input.expectedRevenueGrowth}) and whether our search signal beats, misses, or is priced in vs that estimate. Also mention recommendationKey "${input.wallStreetConsensus}".
3. Write a custom strategy_profile for how this name should trade into earnings.
4. Set earnings_mismatch to BEAT_LIKELY, MISS_LIKELY, or PRICED_IN using the Delta Directive.

## Big picture market
${input.macroRegime}

## Dual-Engine search signal
Setup type: ${input.setupType}
Short-term spike: ${spikeLabel}
YoY growth: ${yoyLabel}
Average child Pearson correlation (5y): ${corrLabel}
Past 90d post-spike stock move: ${input.avgReturnPct != null ? `${input.avgReturnPct >= 0 ? "+" : ""}${input.avgReturnPct.toFixed(1)}% on average` : "N/A"} (${input.eventCount} past cases)

Child brand details:
${childLines || "(none)"}

## Company basics
- Parent stock: ${input.parent.name} (${input.parent.ticker})
- Recent stock price: ${f.lastPrice}
- P/E: trailing ${f.trailingPE}, forward ${f.forwardPE}
- Next earnings date: ${f.nextEarnings}

## Wall Street
- recommendationKey: ${input.wallStreetConsensus}
- Expected revenue growth (+0q): ${input.expectedRevenueGrowth}
- Average price target: ${f.targetMeanPrice}
${streetMissing ? "- IMPORTANT: Wall Street recommendation looks missing — say so clearly.\n" : ""}${estimateMissing ? "- IMPORTANT: Current-quarter revenue growth estimate is N/A — say so and lean PRICED_IN unless search evidence is extreme.\n" : ""}
Return structured JSON with exactly these keys:
- earnings_mismatch: "BEAT_LIKELY" | "MISS_LIKELY" | "PRICED_IN"
- strategy_profile: 1 sentence custom behavior profile
- terminal_verdict: 1 sentence that states the exact Street revenue estimate and the search contrast
- the_buzz: 1-2 sentences on catalysts / organic demand (last 6 months only)
- the_risk: 1-2 sentences on correlation / estimate risk (must warn if r < ${MIN_POSITIVE_CORR})

Rules:
- No emojis. Do not invent numbers — if a field is N/A, say so.
- Never cite 2023 or 2024 events.
- Focus on the upcoming earnings / next 90 days.`;
}

function buildFallbackInsight(input: {
  parent: ParentCompany;
  setupType: SetupType;
  avgSpikePts: number | null;
  avgYoYGrowth: number | null;
  avgCorrelation: number | null;
  avgReturnPct: number | null;
  eventCount: number;
  children: ChildBrandSignal[];
  fundamentals: ParentFundamentals;
  wallStreetConsensus: string;
  expectedRevenueGrowth: string;
}): GeminiInsight {
  const top = [...input.children]
    .filter((c) => c.yoyGrowth != null || c.spikePts != null)
    .sort((a, b) => {
      const aScore = Math.max(
        Math.abs(a.yoyGrowth ?? 0),
        Math.abs(a.spikePts ?? 0) * 5
      );
      const bScore = Math.max(
        Math.abs(b.yoyGrowth ?? 0),
        Math.abs(b.spikePts ?? 0) * 5
      );
      return bScore - aScore;
    })[0];

  const street = input.wallStreetConsensus;
  const est = input.expectedRevenueGrowth;
  const weakCorr =
    input.avgCorrelation == null ||
    input.avgCorrelation < MIN_POSITIVE_CORR;

  const yoy = input.avgYoYGrowth;
  let earnings_mismatch: EarningsMismatch = "PRICED_IN";
  if (!weakCorr && yoy != null && yoy > YOY_GROWTH_THRESHOLD) {
    earnings_mismatch = "BEAT_LIKELY";
  } else if (!weakCorr && yoy != null && yoy < 0) {
    earnings_mismatch = "MISS_LIKELY";
  }

  return {
    earnings_mismatch,
    strategy_profile:
      earnings_mismatch === "BEAT_LIKELY"
        ? "Earnings Whisper long — search hype appears ahead of Street revenue growth."
        : earnings_mismatch === "MISS_LIKELY"
          ? "Earnings Whisper fade — search demand is soft vs Street expectations."
          : "Priced-in / watchlist — search and Street estimates look roughly aligned (fallback).",
    terminal_verdict: `Street expects current-quarter revenue growth of ${est} (recommendation: ${street}); our YoY search is ${yoy != null ? `${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%` : "n/a"} → ${earnings_mismatch.replace(/_/g, " ")} (fallback mode).`,
    the_buzz: top
      ? `${top.brand} shows ${top.setupType}: spike ${top.spikePts != null ? `${top.spikePts >= 0 ? "+" : ""}${top.spikePts.toFixed(1)} pts` : "n/a"}, YoY ${top.yoyGrowth != null ? `${top.yoyGrowth >= 0 ? "+" : ""}${top.yoyGrowth.toFixed(1)}%` : "n/a"}; recent catalysts are unclear (fallback mode — no live search).`
      : "Recent catalysts are unclear.",
    the_risk: weakCorr
      ? `CRITICAL: historical Pearson correlation is weak (r=${input.avgCorrelation?.toFixed(2) ?? "n/a"} < ${MIN_POSITIVE_CORR}) — this brand is historically unpredictable into earnings.`
      : `Even with r=${input.avgCorrelation?.toFixed(2)}, past spikes only moved the stock about ${input.avgReturnPct != null ? `${input.avgReturnPct.toFixed(1)}%` : "n/a"} over 90 days on average (${input.eventCount} cases).`,
  };
}

async function generateParentGeminiCopy(input: {
  parent: ParentCompany;
  setupType: SetupType;
  avgSpikePts: number | null;
  avgYoYGrowth: number | null;
  avgCorrelation: number | null;
  avgReturnPct: number | null;
  eventCount: number;
  children: ChildBrandSignal[];
  macroRegime: string;
  fundamentals: ParentFundamentals;
  wallStreetConsensus: string;
  expectedRevenueGrowth: string;
}): Promise<GeminiInsight> {
  const prompt = buildGeminiPrompt(input);
  const fallback = buildFallbackInsight(input);
  const google = getGoogle();

  for (const modelId of GOOGLE_MODEL_IDS) {
    try {
      try {
        const { object } = await generateObject({
          model: google(modelId),
          schema: GeminiInsightSchema,
          // @ts-expect-error googleSearch is supported at runtime for Gemini grounding
          tools: {
            google_search: google.tools.googleSearch({}),
          },
          prompt,
        });
        return normalizeGeminiInsight(object);
      } catch (objectError) {
        console.warn(
          `  [gemini] generateObject ${modelId} failed, trying generateText:`,
          objectError
        );
      }

      const { text } = await generateText({
        model: google(modelId),
        tools: {
          google_search: google.tools.googleSearch({}),
        },
        prompt:
          prompt +
          `\n\nWrite STRICT JSON only:\n{"earnings_mismatch":"BEAT_LIKELY"|"MISS_LIKELY"|"PRICED_IN","strategy_profile":"...","terminal_verdict":"...","the_buzz":"...","the_risk":"..."}`,
      });
      const parsed = GeminiInsightSchema.safeParse(
        JSON.parse(cleanLlmJsonText(text ?? ""))
      );
      if (parsed.success) return normalizeGeminiInsight(parsed.data);
    } catch (error) {
      console.warn(
        `  [gemini] ${modelId} failed for ${input.parent.ticker}:`,
        error
      );
      if (!isModelNotFoundError(error)) break;
    }
  }

  return fallback;
}

/** Aggregate child Dual-Engine signals into one parent draft. */
function aggregateParent(
  parent: ParentCompany,
  children: ChildBrandSignal[],
  lastPrice: number | null
): {
  ticker: string;
  parent_name: string;
  brand: string;
  /** Stored as momentum_pct — sanitized YoY % growth. */
  momentum_pct: number | null;
  spike_pts: number | null;
  setup_type: SetupType;
  correlation: number | null;
  average_return_pct: number | null;
  event_count: number;
  last_price: number | null;
  data_point: string;
  children: ChildBrandSignal[];
} | null {
  if (children.length === 0) return null;

  const yoys = children
    .map((c) => c.yoyGrowth)
    .filter((m): m is number => m != null);
  const spikes = children
    .map((c) => c.spikePts)
    .filter((s): s is number => s != null);
  const corrs = children
    .map((c) => c.correlation)
    .filter((c): c is number => c != null);
  const returns = children
    .filter((c) => c.eventCount > 0 && c.avgReturnPct != null)
    .map((c) => c.avgReturnPct as number);

  const avgYoY =
    yoys.length > 0 ? Math.round((mean(yoys) as number) * 10) / 10 : null;
  const avgSpike =
    spikes.length > 0 ? Math.round((mean(spikes) as number) * 10) / 10 : null;
  const avgCorr =
    corrs.length > 0 ? Math.round((mean(corrs) as number) * 100) / 100 : null;
  const avgReturn =
    returns.length > 0
      ? Math.round((mean(returns) as number) * 10) / 10
      : null;
  const eventCount = children.reduce((s, c) => s + c.eventCount, 0);

  const setupType = classifySetupType(avgSpike, avgYoY);

  const drivers = [...children]
    .filter((c) => c.yoyGrowth != null || c.spikePts != null)
    .sort((a, b) => {
      const aScore = Math.max(
        Math.abs(a.yoyGrowth ?? 0),
        Math.abs(a.spikePts ?? 0) * 5
      );
      const bScore = Math.max(
        Math.abs(b.yoyGrowth ?? 0),
        Math.abs(b.spikePts ?? 0) * 5
      );
      return bScore - aScore;
    })
    .slice(0, 3)
    .map((c) => c.brand);
  const brandLabel = drivers.length > 0 ? drivers.join(" · ") : parent.name;

  const dataPoint =
    setupType === "VOLATILE_SPIKE" && avgSpike != null
      ? `${setupType} · ${avgSpike >= 0 ? "+" : ""}${avgSpike.toFixed(1)} pts`
      : avgYoY != null
        ? `${setupType} · ${avgYoY >= 0 ? "+" : ""}${avgYoY.toFixed(1)}% YoY`
        : avgCorr != null
          ? `r = ${avgCorr >= 0 ? "+" : ""}${avgCorr.toFixed(2)}`
          : "—";

  return {
    ticker: parent.ticker,
    parent_name: parent.name,
    brand: brandLabel,
    momentum_pct: avgYoY,
    spike_pts: avgSpike,
    setup_type: setupType,
    correlation: avgCorr,
    average_return_pct: avgReturn,
    event_count: eventCount,
    last_price: lastPrice,
    data_point: dataPoint,
    children,
  };
}

// ---------------------------------------------------------------------------
// Pipeline entry (CLI + Vercel Cron)
// ---------------------------------------------------------------------------

/**
 * Dual-Engine Spike vs YoY + Earnings Whisper Gemini profiles for all parents.
 * Shared by `npm run generate:insights` and `/api/cron`.
 */
export async function runGenerateInsights(): Promise<GenerateInsightsResult> {
  const startedAt = Date.now();
  console.log("\n=== TurboFashion Insight Generator (Earnings Whisper) ===\n");

  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];
  console.log(
    `Scanning ${parentCompanies.length} parents / ${brandNames.length} child brands…`
  );
  console.log(
    `Sanitization: prior-year 4w MA ≥ ${MIN_LAST_YEAR_MA} · YoY cap ±${YOY_GROWTH_CAP}%`
  );
  console.log(
    `Setup: VOLATILE_SPIKE if |spike|≥${MASSIVE_SPIKE_PTS} pts · else STRUCTURAL_YOY when YoY>${YOY_GROWTH_THRESHOLD}%`
  );
  console.log(
    `Risk: lean conservative if r < ${MIN_POSITIVE_CORR}; STRUCTURAL needs r > ${STRONG_CORR} for UP bias\n`
  );

  console.log("Fetching S&P 500 (^GSPC) 30-day macro regime…");
  const macro = await fetchSpxMacroRegime();
  console.log(`  Macro: ${macro.label}\n`);

  const trendData = await fetchTrendHistory(
    brandNames,
    YEARS_BACK,
    "market_metrics"
  );
  if (trendData.length === 0) {
    throw new Error(
      "No trend rows from Supabase — run npm run fetch:trends first."
    );
  }

  type ParentDraft = NonNullable<ReturnType<typeof aggregateParent>>;
  const drafts: ParentDraft[] = [];

  for (const parent of parentCompanies) {
    let stockMap: Map<string, number>;
    try {
      stockMap = await fetchStockQuotes(parent.ticker, YEARS_BACK);
    } catch (error) {
      console.warn(`  Stock failed for ${parent.ticker}:`, error);
      stockMap = new Map();
    }

    const lastPrice = latestQuote(stockMap);
    const merged = mergeStockPrices(trendData, stockMap, STOCK_KEY);
    const children: ChildBrandSignal[] = [];

    for (const brand of parent.childBrands) {
      const series = extractBrandSeries(trendData, brand);
      if (series.length < YOY_LAG_WEEKS + MA_WEEKS) {
        console.log(`  skip ${brand} — insufficient series (${series.length})`);
        continue;
      }

      const spikePts = computeShortTermSpikePts(series);
      const yoyGrowth = computeYoYGrowthPct(series);
      const setupType = classifySetupType(spikePts, yoyGrowth);
      // Baseline Pearson on full available history (matches Dual-Engine).
      const correlation =
        stockMap.size > 0 ? correlationTrendVsStock(series, stockMap) : null;
      const corr =
        correlation != null && !Number.isNaN(correlation) ? correlation : null;
      const study = runEventStudy(merged, brand, STOCK_KEY);

      children.push({
        brand,
        spikePts,
        yoyGrowth,
        correlation: corr,
        avgReturnPct: study.eventCount > 0 ? study.averageReturnPct : null,
        eventCount: study.eventCount,
        setupType,
      });
    }

    const draft = aggregateParent(parent, children, lastPrice);
    if (!draft) {
      console.log(`  skip ${parent.ticker} — no usable child series`);
      continue;
    }
    drafts.push(draft);
    console.log(
      `  ${parent.ticker.padEnd(6)} ${draft.setup_type.padEnd(15)} spike=${draft.spike_pts != null ? `${draft.spike_pts}pts` : "n/a"} YoY=${draft.momentum_pct != null ? `${draft.momentum_pct}%` : "n/a"} r=${draft.correlation ?? "n/a"} drivers=${draft.brand}`
    );
  }

  console.log(
    `\nQuant complete — ${drafts.length} parents. Fetching Street consensus + Gemini Asset Profiles…\n`
  );

  const generatedAt = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const parent = parentCompanies.find((p) => p.ticker === d.ticker)!;
    const label = `[${i + 1}/${drafts.length}] ${d.ticker}`;
    try {
      const fundamentals = await fetchParentFundamentals(d.ticker);
      const wallStreetConsensus =
        fundamentals.recommendationKey?.trim() || "N/A";
      console.log(
        `  ${label} fundamentals: PE=${fundamentals.peLabel}, earn=${fundamentals.nextEarnings}, street=${wallStreetConsensus}, revGrowth=${fundamentals.expectedRevenueGrowth}, tgt=${fundamentals.targetMeanPrice}`
      );

      const copy = await generateParentGeminiCopy({
        parent,
        setupType: d.setup_type,
        avgSpikePts: d.spike_pts,
        avgYoYGrowth: d.momentum_pct,
        avgCorrelation: d.correlation,
        avgReturnPct: d.average_return_pct,
        eventCount: d.event_count,
        children: d.children,
        macroRegime: macro.label,
        fundamentals,
        wallStreetConsensus,
        expectedRevenueGrowth: fundamentals.expectedRevenueGrowth,
      });

      const earningsMismatch = copy.earnings_mismatch;
      const direction = mismatchToDirection(earningsMismatch);
      const strongSignal =
        earningsMismatch === "BEAT_LIKELY" &&
        d.momentum_pct != null &&
        d.momentum_pct > YOY_GROWTH_THRESHOLD &&
        d.correlation != null &&
        d.correlation > STRONG_CORR;

      rows.push({
        ticker: d.ticker,
        parent_name: d.parent_name,
        // Parent-level sentinel: brand column stores top child drivers for UI.
        brand: d.brand,
        earnings_mismatch: earningsMismatch,
        // Legacy column kept in sync for any old consumers.
        direction,
        momentum_pct: d.momentum_pct,
        correlation: d.correlation,
        hero_text: copy.terminal_verdict,
        bullet_points: [
          copy.strategy_profile,
          copy.the_buzz,
          copy.the_risk,
          copy.terminal_verdict,
        ],
        sentiment: mismatchToSentiment(earningsMismatch),
        data_point: d.data_point,
        average_return_pct: d.average_return_pct,
        event_count: d.event_count,
        last_price: d.last_price,
        confidence_score: strongSignal ? 8 : 5,
        reasoning_for_confidence: `${d.setup_type} · ${earningsMismatch} · ${copy.strategy_profile}`,
        // Fluid Asset Profile handbook fields
        strategy_profile: copy.strategy_profile,
        wall_street_consensus: wallStreetConsensus,
        expected_revenue_growth: fundamentals.expectedRevenueGrowth,
        terminal_verdict: copy.terminal_verdict,
        the_buzz: copy.the_buzz,
        the_risk: copy.the_risk,
        generated_at: generatedAt,
      });
      ok++;
      console.log(
        `  ${label} → ${earningsMismatch} · ${d.setup_type} · street=${wallStreetConsensus} · rev=${fundamentals.expectedRevenueGrowth} · profile ok`
      );
    } catch (error) {
      fail++;
      console.error(`  ${label} → FAIL`, error);
    }

    if (i < drafts.length - 1) await sleep(GEMINI_PAUSE_MS);
  }

  if (rows.length === 0) {
    throw new Error("No insights generated — aborting upsert.");
  }

  // Replace prior child-level / stale rows with a clean parent-level set.
  console.log(
    `\nReplacing ai_insights with ${rows.length} parent rows…`
  );
  const { error: delError } = await getSupabase()
    .from("ai_insights")
    .delete()
    .neq("ticker", "");
  if (delError) {
    console.warn(
      `  Warning: could not clear old rows (${delError.message}). Upserting anyway.`
    );
  }

  const { error } = await getSupabase().from("ai_insights").upsert(rows, {
    onConflict: "ticker,brand",
  });

  if (error) {
    // Fallback: insert without conflict target if unique layout differs.
    const { error: insertError } = await getSupabase()
      .from("ai_insights")
      .insert(rows);
    if (insertError) {
      throw new Error(
        `Supabase write failed: ${error.message}; insert: ${insertError.message}`
      );
    }
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log("\n=== Insight generation complete ===");
  console.log(`  Parents  : ${rows.length}`);
  console.log(`  Gemini OK : ${ok}`);
  console.log(`  Gemini KO : ${fail}`);
  console.log(`  Elapsed   : ${elapsedSec.toFixed(1)}s`);

  return { parents: rows.length, ok, fail, elapsedSec };
}

function isExecutedDirectly(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === metaUrl;
  } catch {
    return entry.replace(/\\/g, "/").includes("/scripts/generate-insights");
  }
}

if (isExecutedDirectly(import.meta.url)) {
  runGenerateInsights()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\nFatal error during insight generation:", err);
      process.exit(1);
    });
}

/*
-- Preferred parent-level schema (one row per ticker). If you already created
-- unique(ticker, brand), the script clears the table then upserts.
--
-- alter table ai_insights drop constraint if exists ai_insights_ticker_brand_key;
-- create unique index if not exists ai_insights_ticker_uidx on ai_insights (ticker);
--
-- alter table ai_insights
--   add column if not exists confidence_score integer,
--   add column if not exists reasoning_for_confidence text,
--   add column if not exists strategy_profile text,
--   add column if not exists wall_street_consensus text,
--   add column if not exists expected_revenue_growth text,
--   add column if not exists earnings_mismatch text,
--   add column if not exists terminal_verdict text,
--   add column if not exists the_buzz text,
--   add column if not exists the_risk text;
*/
