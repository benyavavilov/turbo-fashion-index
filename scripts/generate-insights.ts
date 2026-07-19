/**
 * generate-insights.ts
 *
 * Post-trends ETL (parent-level): V4 YoY search growth + Pearson correlation
 * per child brand, enrich with Yahoo fundamentals + S&P macro regime,
 * ping Gemini ONCE per parent for direction + copy, upsert into `ai_insights`.
 *
 * momentum_pct stores YoY % growth (not absolute short-term point deltas).
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
  directionToSentiment,
  type InsightDirection,
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
/** Match V4 backtest: need full YoY history. */
const YEARS_BACK = 5;
const MA_WEEKS = 4;
const YOY_LAG_WEEKS = 52;
/** V4 structural-trend thresholds (mirrored in run-backtest.ts). */
const YOY_GROWTH_THRESHOLD = 25;
const MIN_POSITIVE_CORR = 0.15;
const GEMINI_PAUSE_MS = 500;
const SPX_TICKER = "^GSPC";

export interface GenerateInsightsResult {
  parents: number;
  ok: number;
  fail: number;
  elapsedSec: number;
}

/** Structured Gemini output — direction is AI-owned, not momentum-hardcoded. */
const GeminiInsightSchema = z.object({
  direction: z.enum(["UP", "DOWN", "SAFE"]),
  hero_text: z.string().min(1),
  bullet_points: z
    .array(z.string())
    .describe(
      "Exactly 4 bullet points explaining the analysis: (1) The Search Trend, (2) Our Edge/History, (3) Wall Street's View, (4) Final Verdict for the next 90 days / upcoming 3 months."
    ),
  confidence_score: z
    .number()
    .describe("Integer confidence from 1 (lowest) to 10 (highest)"),
  reasoning_for_confidence: z
    .string()
    .describe(
      "One short plain-English sentence explaining why this confidence score was assigned"
    ),
});

type GeminiInsightParsed = z.infer<typeof GeminiInsightSchema>;

interface GeminiInsight {
  direction: InsightDirection;
  hero_text: string;
  bullet_points: [string, string, string, string];
  confidence_score: number;
  reasoning_for_confidence: string;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function normalizeGeminiInsight(raw: GeminiInsightParsed): GeminiInsight {
  const points = (raw.bullet_points ?? [])
    .map((p) => String(p).trim())
    .filter(Boolean);
  while (points.length < 4) {
    points.push("See the final verdict above for the takeaway.");
  }
  return {
    direction: raw.direction,
    hero_text: raw.hero_text.trim(),
    bullet_points: [points[0], points[1], points[2], points[3]],
    confidence_score: clampConfidence(raw.confidence_score),
    reasoning_for_confidence:
      String(raw.reasoning_for_confidence ?? "").trim() ||
      "Confidence based on available search and Street evidence.",
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
}

const FUNDAMENTALS_NA: ParentFundamentals = {
  trailingPE: "N/A",
  forwardPE: "N/A",
  peLabel: "N/A",
  nextEarnings: "N/A",
  recommendationKey: "N/A",
  targetMeanPrice: "N/A",
  lastPrice: "N/A",
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
    // Analyst consensus is unreliable on quote(); prefer quoteSummary.financialData.
    const summary = (await getYahoo().quoteSummary(ticker, {
      modules: ["financialData"],
    })) as {
      financialData?: {
        recommendationKey?: string | null;
        targetMeanPrice?: number | null;
        currentPrice?: number | null;
      } | null;
    };

    const financialData = summary?.financialData;
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
    };
  } catch (error) {
    console.warn(`  [fundamentals] quoteSummary failed for ${ticker}:`, error);
    return { ...FUNDAMENTALS_NA };
  }
}

// ---------------------------------------------------------------------------
// V4 YoY momentum helpers (aligned with scripts/run-backtest.ts)
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
 * Latest YoY % growth of search interest:
 * ((Current 4w MA − Last-year 4w MA) / Last-year 4w MA) * 100
 * Drops the trailing incomplete week before measuring.
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

  const yoy = ((currentMa - lastYearMa) / lastYearMa) * 100;
  if (!Number.isFinite(yoy)) return null;
  return Math.round(yoy * 10) / 10;
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
  /** YoY % growth of 4w search MA vs same season last year. */
  yoyGrowth: number | null;
  correlation: number | null;
  avgReturnPct: number | null;
  eventCount: number;
}

function buildGeminiPrompt(input: {
  parent: ParentCompany;
  avgYoYGrowth: number | null;
  avgCorrelation: number | null;
  avgReturnPct: number | null;
  eventCount: number;
  children: ChildBrandSignal[];
  macroRegime: string;
  fundamentals: ParentFundamentals;
}): string {
  const childLines = input.children
    .map((c) => {
      const yoy =
        c.yoyGrowth != null
          ? `${c.yoyGrowth >= 0 ? "+" : ""}${c.yoyGrowth.toFixed(1)}% YoY`
          : "n/a";
      const corr =
        c.correlation != null
          ? c.correlation <= MIN_POSITIVE_CORR
            ? `r=${c.correlation.toFixed(2)} (weak/unreliable)`
            : `r=${c.correlation.toFixed(2)}`
          : "r=n/a";
      const hist =
        c.avgReturnPct != null && c.eventCount > 0
          ? `historically stock moved about ${c.avgReturnPct >= 0 ? "+" : ""}${c.avgReturnPct.toFixed(1)}% over 90d after past search spikes (${c.eventCount} cases)`
          : "limited event-study history";
      return `- ${c.brand}: ${yoy}; ${corr}; ${hist}`;
    })
    .join("\n");

  const f = input.fundamentals;
  const streetMissing =
    f.recommendationKey === "N/A" && f.targetMeanPrice === "N/A";

  const corrLabel =
    input.avgCorrelation != null
      ? input.avgCorrelation < MIN_POSITIVE_CORR
        ? `${input.avgCorrelation.toFixed(2)} (≤ ${MIN_POSITIVE_CORR} — weak/spurious; treat as unreliable)`
        : input.avgCorrelation.toFixed(2)
      : "N/A";

  return `You are a clear, direct financial advisor explaining a trade setup to a retail investor. Use plain English. No dense jargon.

We only trade the PARENT stock ${input.parent.name} (${input.parent.ticker}). Child brands are used only as consumer-interest clues.

IMPORTANT TIMEFRAME: You MUST state the timeframe of your projection. Because our historical event study uses a 90-day forward window, explicitly state in your hero_text and bullet_points that your projection is for the "next 90 days" or "upcoming 3 months".

STRICT DIRECTIVE (V4 YoY TREND RULE — MATCH THE BACKTESTER): If YoY Growth is > ${YOY_GROWTH_THRESHOLD}% AND the historical Pearson correlation is strictly positive ( > ${MIN_POSITIVE_CORR}), you MUST assign a HIGH confidence score (7-10) and project "UP". If the correlation is negative or weak (< ${MIN_POSITIVE_CORR}), you MUST assign a LOW confidence score (1-4) and project "SAFE" or "DOWN", explicitly citing that the brand has a spurious/unreliable historical correlation with the stock price.

CRITICAL LOGIC RULE (SPURIOUS CORRELATION): You must NEVER predict a stock will go UP because consumer searches went DOWN. If the historical correlation is mathematically negative, it means the data is noisy and unrelated, NOT that it is an inverse indicator. If YoY search growth is negative, your projection MUST be "DOWN" or "SAFE", never "UP". Treat negative correlations as zero/unreliable.

DIRECTION CONTROL: Follow the STRICT DIRECTIVE above first. Otherwise, if holistic analysis (Search + Fundamentals + Wall Street) projects a rise, return "UP"; fall → "DOWN"; mixed/neutral → "SAFE". Ensure hero_text matches direction.

## Big picture market
${input.macroRegime}

## Our search signal (V4 YoY structural trend)
Parent average YoY search growth (current 4w MA vs same 4w last year): ${
    input.avgYoYGrowth != null
      ? `${input.avgYoYGrowth >= 0 ? "+" : ""}${input.avgYoYGrowth.toFixed(1)}%`
      : "N/A"
  }
Average child Pearson correlation (search↔stock, 5y): ${corrLabel}
What usually happened to the stock over the next 90 days after past search spikes: ${input.avgReturnPct != null ? `${input.avgReturnPct >= 0 ? "+" : ""}${input.avgReturnPct.toFixed(1)}% on average` : "N/A"} (${input.eventCount} past cases)

Child brand details:
${childLines || "(none)"}

## Company basics
- Recent stock price: ${f.lastPrice}
- How expensive the stock looks (P/E): trailing ${f.trailingPE}, forward ${f.forwardPE}
- Next earnings date: ${f.nextEarnings}

## Wall Street's official view
- Analyst rating: ${f.recommendationKey}
- Average price target: ${f.targetMeanPrice}
${streetMissing ? "- IMPORTANT: Wall Street coverage looks missing — say so clearly and lower your confidence." : ""}

Return structured JSON with:
- direction: "UP" | "DOWN" | "SAFE" (your final call)
- hero_text: ONE simple punchy sentence for the next 90 days that matches direction
- bullet_points: EXACTLY 4 strings:
  1) The Search Trend (cite YoY % growth in plain English)
  2) Our Edge/History (90-day history + whether correlation is reliable)
  3) Wall Street's View (or say Wall Street is ignoring this stock)
  4) Final Verdict for the upcoming 3 months (must align with direction)
- confidence_score: number from 1 to 10 (HIGH 7–10 when YoY>${YOY_GROWTH_THRESHOLD}% and r>${MIN_POSITIVE_CORR}; LOW 1–4 when correlation is weak/negative)
- reasoning_for_confidence: one short sentence explaining the score

Rules:
- Persona: clear retail advisor. Short words. No dense jargon.
- hero_text MUST match direction.
- NEVER set direction to UP when YoY growth is negative, or when correlation is ≤ ${MIN_POSITIVE_CORR}.
- You MUST mention "next 90 days" or "upcoming 3 months" in hero_text and in at least the Final Verdict bullet.
- confidence_score is mandatory. Do not omit it.
- Do not invent numbers. If a field is N/A, say so simply.
- No emojis.`;
}

function buildFallbackInsight(input: {
  parent: ParentCompany;
  avgYoYGrowth: number | null;
  avgCorrelation: number | null;
  avgReturnPct: number | null;
  eventCount: number;
  children: ChildBrandSignal[];
  fundamentals: ParentFundamentals;
}): GeminiInsight {
  const f = input.fundamentals;
  const streetMissing =
    f.recommendationKey === "N/A" && f.targetMeanPrice === "N/A";
  const top = [...input.children]
    .filter((c) => c.yoyGrowth != null)
    .sort((a, b) => Math.abs(b.yoyGrowth!) - Math.abs(a.yoyGrowth!))[0];

  const strongSignal =
    input.avgYoYGrowth != null &&
    input.avgYoYGrowth > YOY_GROWTH_THRESHOLD &&
    input.avgCorrelation != null &&
    input.avgCorrelation > MIN_POSITIVE_CORR;

  const weakCorr =
    input.avgCorrelation == null ||
    input.avgCorrelation <= MIN_POSITIVE_CORR;

  const direction: InsightDirection = strongSignal
    ? "UP"
    : weakCorr
      ? "SAFE"
      : "SAFE";

  return {
    direction,
    hero_text: strongSignal
      ? `Over the next 90 days, expect ${input.parent.ticker} to rise as YoY search demand is surging with a reliable stock link.`
      : `Over the upcoming 3 months, ${input.parent.ticker} looks mixed — search and Street signals need more conviction.`,
    bullet_points: [
      top
        ? `${top.brand} search interest is ${top.yoyGrowth! >= 0 ? "up" : "down"} ${Math.abs(top.yoyGrowth!).toFixed(1)}% vs the same weeks last year.`
        : "Consumer search history is too thin to measure a clean year-over-year trend.",
      input.avgCorrelation != null && input.avgCorrelation > MIN_POSITIVE_CORR
        ? `Search and the stock have moved together historically (r=${input.avgCorrelation.toFixed(2)}), so this trend is more trustworthy.`
        : "Historical search↔stock correlation is weak or unreliable for this parent — treat the signal cautiously.",
      streetMissing
        ? "Wall Street is ignoring this stock — no clear rating or price target showed up."
        : `Wall Street's view: ${f.recommendationKey} with an average target around ${f.targetMeanPrice}.`,
      strongSignal
        ? `Final take for the next 90 days: lean UP on ${input.parent.ticker} — YoY search strength plus positive correlation.`
        : `Final take for the upcoming 3 months (lower confidence): keep ${input.parent.ticker} SAFE until correlation quality improves.`,
    ],
    confidence_score: strongSignal ? 8 : 3,
    reasoning_for_confidence: strongSignal
      ? "We are trusting our search data over the Street."
      : "This is a low-conviction setup; Wall Street's consensus is likely a safer bet.",
  };
}

async function generateParentGeminiCopy(input: {
  parent: ParentCompany;
  avgYoYGrowth: number | null;
  avgCorrelation: number | null;
  avgReturnPct: number | null;
  eventCount: number;
  children: ChildBrandSignal[];
  macroRegime: string;
  fundamentals: ParentFundamentals;
}): Promise<GeminiInsight> {
  const prompt = buildGeminiPrompt(input);
  const fallback = buildFallbackInsight(input);

  for (const modelId of GOOGLE_MODEL_IDS) {
    try {
      const { object } = await generateObject({
        model: getGoogle()(modelId),
        schema: GeminiInsightSchema,
        prompt,
      });
      return normalizeGeminiInsight(object);
    } catch (error) {
      console.warn(
        `  [gemini] generateObject ${modelId} failed for ${input.parent.ticker}:`,
        error
      );
      if (!isModelNotFoundError(error)) {
        try {
          const { text } = await generateText({
            model: getGoogle()(modelId),
            prompt:
              prompt +
              `\n\nWrite STRICT JSON only:\n{"direction":"UP"|"DOWN"|"SAFE","hero_text":"...","bullet_points":["...","...","...","..."],"confidence_score":8,"reasoning_for_confidence":"..."}`,
          });
          const parsed = GeminiInsightSchema.safeParse(
            JSON.parse(cleanLlmJsonText(text ?? ""))
          );
          if (parsed.success) return normalizeGeminiInsight(parsed.data);
        } catch (parseError) {
          console.warn(
            `  [gemini] generateText fallback failed for ${input.parent.ticker}:`,
            parseError
          );
        }
        break;
      }
    }
  }

  return fallback;
}

/** Aggregate child YoY + correlation into one parent draft. */
function aggregateParent(
  parent: ParentCompany,
  children: ChildBrandSignal[],
  lastPrice: number | null
): {
  ticker: string;
  parent_name: string;
  brand: string;
  /** Stored as momentum_pct — now YoY % growth. */
  momentum_pct: number | null;
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
  const corrs = children
    .map((c) => c.correlation)
    .filter((c): c is number => c != null);
  const returns = children
    .filter((c) => c.eventCount > 0 && c.avgReturnPct != null)
    .map((c) => c.avgReturnPct as number);

  const avgYoY =
    yoys.length > 0 ? Math.round((mean(yoys) as number) * 10) / 10 : null;
  const avgCorr =
    corrs.length > 0 ? Math.round((mean(corrs) as number) * 100) / 100 : null;
  const avgReturn =
    returns.length > 0
      ? Math.round((mean(returns) as number) * 10) / 10
      : null;
  const eventCount = children.reduce((s, c) => s + c.eventCount, 0);

  const drivers = [...children]
    .filter((c) => c.yoyGrowth != null)
    .sort((a, b) => Math.abs(b.yoyGrowth!) - Math.abs(a.yoyGrowth!))
    .slice(0, 3)
    .map((c) => c.brand);
  const brandLabel = drivers.length > 0 ? drivers.join(" · ") : parent.name;

  const dataPoint =
    avgYoY != null
      ? `${avgYoY >= 0 ? "+" : ""}${avgYoY.toFixed(1)}% YoY search`
      : avgCorr != null
        ? `r = ${avgCorr >= 0 ? "+" : ""}${avgCorr.toFixed(2)}`
        : "—";

  return {
    ticker: parent.ticker,
    parent_name: parent.name,
    brand: brandLabel,
    momentum_pct: avgYoY,
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
 * V4 YoY quant + Gemini insight generation for all parents.
 * Shared by `npm run generate:insights` and `/api/cron`.
 */
export async function runGenerateInsights(): Promise<GenerateInsightsResult> {
  const startedAt = Date.now();
  console.log("\n=== TurboFashion Insight Generator (V4 YoY) ===\n");

  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];
  console.log(
    `Scanning ${parentCompanies.length} parents / ${brandNames.length} child brands…`
  );
  console.log(
    `Rules: YoY 4w-MA growth · Pearson r (5y) · HIGH if YoY>${YOY_GROWTH_THRESHOLD}% & r>${MIN_POSITIVE_CORR}\n`
  );

  console.log("Fetching S&P 500 (^GSPC) 30-day macro regime…");
  const macro = await fetchSpxMacroRegime();
  console.log(`  Macro: ${macro.label}\n`);

  const trendData = await fetchTrendHistory(brandNames, YEARS_BACK);
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

      const yoyGrowth = computeYoYGrowthPct(series);
      // Baseline Pearson on full available history (matches V4 backtester).
      const correlation =
        stockMap.size > 0 ? correlationTrendVsStock(series, stockMap) : null;
      const corr =
        correlation != null && !Number.isNaN(correlation) ? correlation : null;
      const study = runEventStudy(merged, brand, STOCK_KEY);

      children.push({
        brand,
        yoyGrowth,
        correlation: corr,
        avgReturnPct: study.eventCount > 0 ? study.averageReturnPct : null,
        eventCount: study.eventCount,
      });
    }

    const draft = aggregateParent(parent, children, lastPrice);
    if (!draft) {
      console.log(`  skip ${parent.ticker} — no usable child series`);
      continue;
    }
    drafts.push(draft);
    console.log(
      `  ${parent.ticker.padEnd(6)} YoY=${draft.momentum_pct != null ? `${draft.momentum_pct}%` : "n/a"} r=${draft.correlation ?? "n/a"} drivers=${draft.brand}`
    );
  }

  console.log(
    `\nQuant complete — ${drafts.length} parents. Fetching fundamentals + Gemini (AI owns direction)…\n`
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
      console.log(
        `  ${label} fundamentals: PE=${fundamentals.peLabel}, earn=${fundamentals.nextEarnings}, street=${fundamentals.recommendationKey}, tgt=${fundamentals.targetMeanPrice}`
      );

      const copy = await generateParentGeminiCopy({
        parent,
        avgYoYGrowth: d.momentum_pct,
        avgCorrelation: d.correlation,
        avgReturnPct: d.average_return_pct,
        eventCount: d.event_count,
        children: d.children,
        macroRegime: macro.label,
        fundamentals,
      });

      rows.push({
        ticker: d.ticker,
        parent_name: d.parent_name,
        // Parent-level sentinel: brand column stores top child drivers for UI.
        brand: d.brand,
        // Direction comes from Gemini holistic analysis — not avgMom sign.
        direction: copy.direction,
        momentum_pct: d.momentum_pct,
        correlation: d.correlation,
        hero_text: copy.hero_text,
        bullet_points: copy.bullet_points,
        sentiment: directionToSentiment(copy.direction),
        data_point: d.data_point,
        average_return_pct: d.average_return_pct,
        event_count: d.event_count,
        last_price: d.last_price,
        confidence_score: copy.confidence_score,
        reasoning_for_confidence: copy.reasoning_for_confidence,
        generated_at: generatedAt,
      });
      ok++;
      console.log(
        `  ${label} → ${copy.direction} conf=${copy.confidence_score}/10 ok`
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
  console.log(`\nReplacing ai_insights with ${rows.length} parent rows…`);
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
--   add column if not exists reasoning_for_confidence text;
*/
