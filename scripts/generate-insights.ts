/**
 * generate-insights.ts
 *
 * Lean Earnings Whisper engine: current-quarter Google Search YoY momentum
 * vs Wall Street (+0q) revenue growth estimate → Gemini BEAT/MISS/PRICED_IN
 * call + short terminal verdict. Upserts only the fields the UI needs.
 *
 * Run with:  npm run generate:insights
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProvider,
} from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YahooFinance from "yahoo-finance2";
import { z } from "zod";

import type { EarningsMismatch } from "../lib/ai-insights";
import { parentCompanies, type ParentCompany } from "../lib/entities";
import { fetchTrendHistory } from "../lib/market-data";
import { cleanLlmJsonText } from "../lib/sentiment-parse";
import { extractBrandSeries, type TrendPoint } from "../lib/screener";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;
/** Need full YoY history for 4w MA vs year-ago. */
const YEARS_BACK = 5;
const MA_WEEKS = 4;
const YOY_LAG_WEEKS = 52;
/** Skip / zero YoY when prior-year 4w MA is below this (law of small numbers). */
const MIN_LAST_YEAR_MA = 15;
/** Winsorize YoY growth so outliers don't dominate Gemini / rankings. */
const YOY_GROWTH_CAP = 250;
/** Heuristic thresholds for fallback when Gemini is unavailable. */
const BEAT_DELTA_PP = 15;
const MISS_DELTA_PP = -15;
const GEMINI_PAUSE_MS = 500;

export interface GenerateInsightsResult {
  parents: number;
  ok: number;
  fail: number;
  elapsedSec: number;
}

/** Lean Zod schema — only what Earnings Whisper needs from Gemini. */
const GeminiInsightSchema = z.object({
  earnings_mismatch: z
    .enum(["BEAT_LIKELY", "MISS_LIKELY", "PRICED_IN"])
    .describe(
      "MUST follow the 15% Delta rule only: BEAT_LIKELY if Delta >= 15, MISS_LIKELY if Delta <= -15, otherwise PRICED_IN."
    ),
  terminal_verdict: z
    .string()
    .min(1)
    .describe(
      "A 1-2 sentence explanation of why the search momentum indicates a beat/miss/priced-in outcome compared to the Wall Street estimate."
    ),
});

type GeminiInsightParsed = z.infer<typeof GeminiInsightSchema>;

interface GeminiInsight {
  earnings_mismatch: EarningsMismatch;
  terminal_verdict: string;
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
    terminal_verdict:
      String(raw.terminal_verdict ?? "").trim() ||
      "Search momentum and Wall Street revenue estimates look roughly aligned.",
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
// Yahoo: current-quarter Street revenue growth + next earnings date
// ---------------------------------------------------------------------------

async function fetchStreetBasics(ticker: string): Promise<{
  expectedRevenueGrowth: string;
  nextEarningsDate: string | null;
}> {
  try {
    const quoteSummary = (await getYahoo().quoteSummary(ticker, {
      modules: ["earningsTrend", "calendarEvents"],
    })) as {
      earningsTrend?: {
        trend?: Array<{
          period?: string | null;
          revenueEstimate?: {
            growth?:
              | { raw?: number | null; fmt?: string | null }
              | number
              | null;
          } | null;
        }> | null;
      } | null;
      calendarEvents?: {
        earnings?: {
          earningsDate?: Array<Date | number | string | null> | null;
        } | null;
      } | null;
    };

    const rawNext =
      quoteSummary.calendarEvents?.earnings?.earningsDate?.[0] || null;
    let nextEarningsDate: string | null = null;
    if (rawNext) {
      try {
        const d = new Date(rawNext);
        if (Number.isFinite(d.getTime())) {
          nextEarningsDate = d.toISOString().split("T")[0];
        }
      } catch {
        nextEarningsDate = null;
      }
    }

    const currentQuarterTrend = quoteSummary.earningsTrend?.trend?.find(
      (t) => t.period === "+0q" || t.period === "0q"
    );
    const growth = currentQuarterTrend?.revenueEstimate?.growth as
      | { raw?: number | null; fmt?: string | null }
      | number
      | null
      | undefined;

    let expectedRevenueGrowth = "N/A";
    if (growth != null && typeof growth === "object") {
      if (growth.fmt) expectedRevenueGrowth = String(growth.fmt);
      else if (typeof growth.raw === "number" && Number.isFinite(growth.raw)) {
        expectedRevenueGrowth =
          Math.abs(growth.raw) <= 2
            ? `${(growth.raw * 100).toFixed(1)}%`
            : `${growth.raw.toFixed(1)}%`;
      }
    } else if (typeof growth === "number" && Number.isFinite(growth)) {
      expectedRevenueGrowth =
        Math.abs(growth) <= 2
          ? `${(growth * 100).toFixed(1)}%`
          : `${growth.toFixed(1)}%`;
    }

    return { expectedRevenueGrowth, nextEarningsDate };
  } catch (error) {
    console.warn(`  [fundamentals] quoteSummary failed for ${ticker}:`, error);
    return { expectedRevenueGrowth: "N/A", nextEarningsDate: null };
  }
}

/** Parse Yahoo fmt / numeric string into a percent number (e.g. "3.2%" → 3.2). */
function parseGrowthPct(value: string): number | null {
  if (!value || value === "N/A") return null;
  const cleaned = value.replace(/%/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Search YoY math (current 4w MA vs year-ago)
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
 * YoY % growth of search interest:
 * ((Current 4w MA − Last-year 4w MA) / Last-year 4w MA) * 100
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
  if (lastYearMa < MIN_LAST_YEAR_MA) return 0;

  let yoy = ((currentMa - lastYearMa) / lastYearMa) * 100;
  if (!Number.isFinite(yoy)) return null;
  if (yoy > YOY_GROWTH_CAP) yoy = YOY_GROWTH_CAP;
  if (yoy < -YOY_GROWTH_CAP) yoy = -YOY_GROWTH_CAP;

  return Math.round(yoy * 10) / 10;
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
  yoyGrowth: number | null;
}

interface ParentDraft {
  ticker: string;
  parent_name: string;
  brand: string;
  momentum_pct: number | null;
  children: ChildBrandSignal[];
}

function buildGeminiPrompt(input: {
  parent: ParentCompany;
  avgYoYGrowth: number | null;
  children: ChildBrandSignal[];
  expectedRevenueGrowth: string;
}): string {
  const childLines = input.children
    .map((c) => {
      const yoy =
        c.yoyGrowth != null
          ? `${c.yoyGrowth >= 0 ? "+" : ""}${c.yoyGrowth.toFixed(1)}% YoY`
          : "YoY n/a";
      return `- ${c.brand}: ${yoy}`;
    })
    .join("\n");

  const yoyLabel =
    input.avgYoYGrowth != null
      ? `${input.avgYoYGrowth >= 0 ? "+" : ""}${input.avgYoYGrowth.toFixed(1)}%`
      : "N/A";

  return `You are an Earnings Whisper analyst. Compare Wall Street's expected revenue growth against our real-time Google Search YoY momentum.

Calculate the Delta: (YoY Search Growth) - (Wall Street Expected Revenue Growth).

CRITICAL RULE: You MUST strictly obey the 15% threshold. If the Delta is >= 15%, you MUST classify as 'BEAT_LIKELY'. If the Delta is <= -15%, you MUST classify as 'MISS_LIKELY'. If the Delta is between -14.9% and +14.9%, you MUST classify it as 'PRICED_IN'.

Do not use judgment, narrative soft thresholds, or "heavily outpaces / severely lags" language to override this math. The classification is determined solely by the Delta vs the 15% rule above.

## Numbers
Parent: ${input.parent.name} ($${input.parent.ticker})
Our Search YoY momentum (avg across child brands): ${yoyLabel}
Wall Street Expected Revenue Growth (current quarter +0q): ${input.expectedRevenueGrowth}
Delta (Search YoY − Street Est): compute from the two figures above when both are numeric.

Child brand Search YoY:
${childLines || "(none)"}

## Output
- earnings_mismatch: BEAT_LIKELY | MISS_LIKELY | PRICED_IN  (MUST match the CRITICAL 15% RULE)
- terminal_verdict: 1-2 sentences explaining the classification using the Street estimate (${input.expectedRevenueGrowth}) and our search figure (${yoyLabel}). Mention the Delta when both inputs are numeric.

Rules:
- No emojis. Do not invent numbers — if a field is N/A, say so and prefer PRICED_IN.
- Focus only on search momentum vs the Street revenue growth estimate.`;
}

/** Hard lock: classification comes from math, not model discretion. */
function classifyMismatchFromDelta(
  avgYoYGrowth: number | null,
  expectedRevenueGrowth: string
): EarningsMismatch | null {
  const streetPct = parseGrowthPct(expectedRevenueGrowth);
  if (avgYoYGrowth == null || streetPct == null) return null;
  const delta = avgYoYGrowth - streetPct;
  if (delta >= BEAT_DELTA_PP) return "BEAT_LIKELY";
  if (delta <= MISS_DELTA_PP) return "MISS_LIKELY";
  return "PRICED_IN";
}

function enforceFifteenPercentRule(
  insight: GeminiInsight,
  avgYoYGrowth: number | null,
  expectedRevenueGrowth: string
): GeminiInsight {
  const locked = classifyMismatchFromDelta(avgYoYGrowth, expectedRevenueGrowth);
  if (locked == null) return insight;
  if (locked === insight.earnings_mismatch) return insight;
  return { ...insight, earnings_mismatch: locked };
}

function buildFallbackInsight(input: {
  avgYoYGrowth: number | null;
  expectedRevenueGrowth: string;
}): GeminiInsight {
  const streetPct = parseGrowthPct(input.expectedRevenueGrowth);
  const yoy = input.avgYoYGrowth;
  let earnings_mismatch: EarningsMismatch = "PRICED_IN";

  if (yoy != null && streetPct != null) {
    const delta = yoy - streetPct;
    if (delta >= BEAT_DELTA_PP) earnings_mismatch = "BEAT_LIKELY";
    else if (delta <= MISS_DELTA_PP) earnings_mismatch = "MISS_LIKELY";
  } else if (yoy != null && yoy >= BEAT_DELTA_PP) {
    earnings_mismatch = "BEAT_LIKELY";
  } else if (yoy != null && yoy <= MISS_DELTA_PP) {
    earnings_mismatch = "MISS_LIKELY";
  }

  const yoyLabel =
    yoy != null ? `${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%` : "n/a";

  return {
    earnings_mismatch,
    terminal_verdict: `Street expects current-quarter revenue growth of ${input.expectedRevenueGrowth}; our Search YoY is ${yoyLabel}, so the setup looks ${earnings_mismatch.replace(/_/g, " ").toLowerCase()} (fallback — no live model).`,
  };
}

async function generateParentGeminiCopy(input: {
  parent: ParentCompany;
  avgYoYGrowth: number | null;
  children: ChildBrandSignal[];
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
          prompt,
        });
        return enforceFifteenPercentRule(
          normalizeGeminiInsight(object),
          input.avgYoYGrowth,
          input.expectedRevenueGrowth
        );
      } catch (objectError) {
        console.warn(
          `  [gemini] generateObject ${modelId} failed, trying generateText:`,
          objectError
        );
      }

      const { text } = await generateText({
        model: google(modelId),
        prompt:
          prompt +
          `\n\nWrite STRICT JSON only:\n{"earnings_mismatch":"BEAT_LIKELY"|"MISS_LIKELY"|"PRICED_IN","terminal_verdict":"..."}`,
      });
      const parsed = GeminiInsightSchema.safeParse(
        JSON.parse(cleanLlmJsonText(text ?? ""))
      );
      if (parsed.success) {
        return enforceFifteenPercentRule(
          normalizeGeminiInsight(parsed.data),
          input.avgYoYGrowth,
          input.expectedRevenueGrowth
        );
      }
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

function aggregateParent(
  parent: ParentCompany,
  children: ChildBrandSignal[]
): ParentDraft | null {
  if (children.length === 0) return null;

  const yoys = children
    .map((c) => c.yoyGrowth)
    .filter((m): m is number => m != null);
  const avgYoY =
    yoys.length > 0 ? Math.round((mean(yoys) as number) * 10) / 10 : null;

  const drivers = [...children]
    .filter((c) => c.yoyGrowth != null)
    .sort(
      (a, b) => Math.abs(b.yoyGrowth ?? 0) - Math.abs(a.yoyGrowth ?? 0)
    )
    .slice(0, 3)
    .map((c) => c.brand);
  const brandLabel = drivers.length > 0 ? drivers.join(" · ") : parent.name;

  return {
    ticker: parent.ticker,
    parent_name: parent.name,
    brand: brandLabel,
    momentum_pct: avgYoY,
    children,
  };
}

// ---------------------------------------------------------------------------
// Pipeline entry (CLI + Vercel Cron)
// ---------------------------------------------------------------------------

/**
 * Search YoY vs Street estimate → lean Gemini Earnings Whisper rows.
 * Shared by `npm run generate:insights` and `/api/cron`.
 */
export async function runGenerateInsights(): Promise<GenerateInsightsResult> {
  const startedAt = Date.now();
  console.log("\n=== Earnings Whisper Insight Generator (lean) ===\n");

  const brandNames = [
    ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
  ];
  console.log(
    `Scanning ${parentCompanies.length} parents / ${brandNames.length} child brands…`
  );
  console.log(
    `Search math: 4w MA YoY · prior-year MA ≥ ${MIN_LAST_YEAR_MA} · cap ±${YOY_GROWTH_CAP}%`
  );
  console.log(
    `Gemini: earnings_mismatch + terminal_verdict only (no correlation)\n`
  );

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

  const drafts: ParentDraft[] = [];

  for (const parent of parentCompanies) {
    const children: ChildBrandSignal[] = [];

    for (const brand of parent.childBrands) {
      const series = extractBrandSeries(trendData, brand);
      if (series.length < YOY_LAG_WEEKS + MA_WEEKS) {
        console.log(`  skip ${brand} — insufficient series (${series.length})`);
        continue;
      }

      children.push({
        brand,
        yoyGrowth: computeYoYGrowthPct(series),
      });
    }

    const draft = aggregateParent(parent, children);
    if (!draft) {
      console.log(`  skip ${parent.ticker} — no usable child series`);
      continue;
    }
    drafts.push(draft);
    console.log(
      `  ${parent.ticker.padEnd(6)} YoY=${draft.momentum_pct != null ? `${draft.momentum_pct}%` : "n/a"} drivers=${draft.brand}`
    );
  }

  console.log(
    `\nQuant complete — ${drafts.length} parents. Fetching Street estimates + Gemini…\n`
  );

  const rows: Record<string, unknown>[] = [];
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const parent = parentCompanies.find((p) => p.ticker === d.ticker)!;
    const label = `[${i + 1}/${drafts.length}] ${d.ticker}`;
    try {
      const { expectedRevenueGrowth, nextEarningsDate } =
        await fetchStreetBasics(d.ticker);
      console.log(
        `  ${label} Street revGrowth=${expectedRevenueGrowth} nextEarnings=${nextEarningsDate ?? "n/a"}`
      );

      const copy = await generateParentGeminiCopy({
        parent,
        avgYoYGrowth: d.momentum_pct,
        children: d.children,
        expectedRevenueGrowth,
      });

      // Lean upsert payload — no correlation.
      rows.push({
        ticker: d.ticker,
        parent_name: d.parent_name,
        brand: d.brand,
        momentum_pct: d.momentum_pct,
        expected_revenue_growth: expectedRevenueGrowth,
        next_earnings_date: nextEarningsDate
          ? new Date(nextEarningsDate).toISOString().split("T")[0]
          : null,
        earnings_mismatch: copy.earnings_mismatch,
        terminal_verdict: copy.terminal_verdict,
      });
      ok++;
      console.log(
        `  ${label} → ${copy.earnings_mismatch} · YoY=${d.momentum_pct ?? "n/a"} · rev=${expectedRevenueGrowth}`
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
