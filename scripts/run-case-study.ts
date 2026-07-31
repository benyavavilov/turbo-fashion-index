/**
 * run-case-study.ts — Dual-Engine Case Study (Show Your Work)
 *
 * Backtests the Dual-Engine architecture on a historical date:
 *   Engine 1 (Spike)      — short-term 4w vs prior 4w momentum
 *   Engine 2 (Compounder) — YoY growth + 5y Pearson correlation
 *   AI Bouncer            — Gemini + native Google Search (no google-trends-api)
 *   Reveal                — actual 90-day stock vs SPX returns
 *
 * Data sources: Supabase market_metrics + Yahoo Finance + @ai-sdk/google.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/run-case-study.ts HESAY 2026-04-13
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import YahooFinance from "yahoo-finance2";
import { z } from "zod";

import { normalizeDateString, type TrendDatum } from "../lib/chart-data";
import { getParentByTicker, normalizeTickerParam } from "../lib/entities";
import { fetchStockQuotes, fetchTrendHistory } from "../lib/market-data";
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
const SPX_TICKER = "^GSPC";
const MA_WEEKS = 4;
const YOY_LAG_WEEKS = 52;
const HOLD_DAYS = 90;
const NEWS_LOOKBACK_DAYS = 28;
const YAHOO_PAUSE_MS = 400;

const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;

const yahooFinance = new YahooFinance();

const DualEngineVerdictSchema = z.object({
  catalyst_found: z.string().min(1),
  sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL"]),
  reasoning: z.string().min(1),
  terminal_verdict: z.enum([
    "PROJECTED UP",
    "PROJECTED DOWN",
    "SAFE HOLD",
  ]),
});

export type DualEngineVerdict = z.infer<typeof DualEngineVerdictSchema>;

interface DailyBar {
  date: string;
  close: number;
}

interface ChildMath {
  brand: string;
  asOfDate: string | null;
  /** Engine 1: current 4w MA − previous 4w MA (interest points). */
  spikePts: number | null;
  current4wMa: number | null;
  prior4wMa: number | null;
  /** Engine 2: YoY % of 4w MA vs ~52w ago. */
  yoyGrowthPct: number | null;
  yearAgo4wMa: number | null;
  /** Engine 2: 5y Pearson r through targetDate. */
  correlation: number | null;
}

interface ParentMath {
  children: ChildMath[];
  spikePts: number | null;
  yoyGrowthPct: number | null;
  correlation: number | null;
  driverBrand: string | null;
}

// ---------------------------------------------------------------------------
// CLI / formatting
// ---------------------------------------------------------------------------

function usageAndExit(message?: string): never {
  if (message) console.error(`\nError: ${message}\n`);
  console.error(
    "Usage: npx tsx --env-file=.env.local scripts/run-case-study.ts <TICKER> <YYYY-MM-DD>"
  );
  console.error(
    "Example: npx tsx --env-file=.env.local scripts/run-case-study.ts HESAY 2026-04-13"
  );
  process.exit(1);
}

function parseArgs(argv: string[]): { ticker: string; targetDate: string } {
  const args = argv.filter((a) => !a.startsWith("-"));
  if (args.length < 2) usageAndExit("ticker and targetDate are required");

  const ticker = normalizeTickerParam(args[0]);
  const targetDate = normalizeDateString(args[1]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    usageAndExit(`invalid date "${args[1]}" — expected YYYY-MM-DD`);
  }
  const parsed = new Date(`${targetDate}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    usageAndExit(`invalid date "${args[1]}"`);
  }
  return { ticker, targetDate };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pctReturn(start: number, end: number): number {
  if (!Number.isFinite(start) || start === 0) return NaN;
  return ((end - start) / start) * 100;
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtPts(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)} pts`;
}

function fmtCorr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(2);
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtMa(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(2);
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${normalizeDateString(isoDate)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function divider(title?: string) {
  if (title) {
    console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
  } else {
    console.log("─".repeat(62));
  }
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

// ---------------------------------------------------------------------------
// Math engines (point-in-time, no look-ahead)
// ---------------------------------------------------------------------------

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

function seriesIndexOnOrBefore(
  series: TrendPoint[],
  asOfDate: string
): number | null {
  const asOf = normalizeDateString(asOfDate);
  for (let j = series.length - 1; j >= 0; j--) {
    if (normalizeDateString(series[j].date) <= asOf) return j;
  }
  return null;
}

/** Engine 1 — Spike: current 4w MA − previous 4w MA. */
function spikeAt(
  series: TrendPoint[],
  i: number
): {
  spikePts: number | null;
  current4wMa: number | null;
  prior4wMa: number | null;
} {
  const current4wMa = maEndingAt(series, i);
  const priorEnd = i - MA_WEEKS;
  const prior4wMa = priorEnd >= MA_WEEKS - 1 ? maEndingAt(series, priorEnd) : null;
  if (current4wMa == null || prior4wMa == null) {
    return { spikePts: null, current4wMa, prior4wMa };
  }
  const spikePts = Math.round((current4wMa - prior4wMa) * 10) / 10;
  return { spikePts, current4wMa, prior4wMa };
}

/** Engine 2 — YoY % growth of 4w MA vs year-ago 4w MA. */
function yoyGrowthAt(
  series: TrendPoint[],
  i: number
): { yoyGrowthPct: number | null; yearAgo4wMa: number | null; current4wMa: number | null } {
  if (i < YOY_LAG_WEEKS + MA_WEEKS - 1) {
    return { yoyGrowthPct: null, yearAgo4wMa: null, current4wMa: null };
  }
  const current4wMa = maEndingAt(series, i);
  const yIdx = yearAgoIndex(series, i);
  if (yIdx == null) {
    return { yoyGrowthPct: null, yearAgo4wMa: null, current4wMa };
  }
  const yearAgo4wMa = maEndingAt(series, yIdx);
  if (current4wMa == null || yearAgo4wMa == null) {
    return { yoyGrowthPct: null, yearAgo4wMa, current4wMa };
  }
  if (!Number.isFinite(yearAgo4wMa) || Math.abs(yearAgo4wMa) < 1e-6) {
    return { yoyGrowthPct: null, yearAgo4wMa, current4wMa };
  }
  const yoy = ((current4wMa - yearAgo4wMa) / yearAgo4wMa) * 100;
  if (!Number.isFinite(yoy)) {
    return { yoyGrowthPct: null, yearAgo4wMa, current4wMa };
  }
  return {
    yoyGrowthPct: Math.round(yoy * 10) / 10,
    yearAgo4wMa,
    current4wMa,
  };
}

/** Engine 2 — 5y Pearson r through asOfDate (no look-ahead). */
function correlationAsOf(
  series: TrendPoint[],
  stockByDate: Map<string, number>,
  asOfDate: string
): number {
  const asOf = normalizeDateString(asOfDate);
  const floor = addDays(asOf, -Math.round(YEARS_BACK * 365.25));

  const truncated = series.filter((p) => {
    const d = normalizeDateString(p.date);
    return d >= floor && d <= asOf;
  });

  const stockMap = new Map<string, number>();
  for (const [date, close] of stockByDate) {
    const d = normalizeDateString(date);
    if (d >= floor && d <= asOf) stockMap.set(d, close);
  }

  if (truncated.length < YOY_LAG_WEEKS + MA_WEEKS || stockMap.size < 20) {
    return NaN;
  }
  return correlationTrendVsStock(truncated, stockMap);
}

function computeParentMath(
  brands: string[],
  trendsAsOf: TrendDatum[],
  stockWeeklyMap: Map<string, number>,
  targetDate: string
): ParentMath {
  const children: ChildMath[] = [];

  for (const brand of brands) {
    const series = extractBrandSeries(trendsAsOf, brand);
    const idx = seriesIndexOnOrBefore(series, targetDate);
    if (idx == null) {
      children.push({
        brand,
        asOfDate: null,
        spikePts: null,
        current4wMa: null,
        prior4wMa: null,
        yoyGrowthPct: null,
        yearAgo4wMa: null,
        correlation: null,
      });
      continue;
    }

    const spike = spikeAt(series, idx);
    const yoy = yoyGrowthAt(series, idx);
    const corrRaw = correlationAsOf(series, stockWeeklyMap, targetDate);
    const correlation = Number.isFinite(corrRaw)
      ? Math.round(corrRaw * 100) / 100
      : null;

    children.push({
      brand,
      asOfDate: series[idx].date,
      spikePts: spike.spikePts,
      current4wMa: spike.current4wMa,
      prior4wMa: spike.prior4wMa,
      yoyGrowthPct: yoy.yoyGrowthPct,
      yearAgo4wMa: yoy.yearAgo4wMa,
      correlation,
    });
  }

  const spikes = children
    .map((c) => c.spikePts)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const yoys = children
    .map((c) => c.yoyGrowthPct)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const corrs = children
    .map((c) => c.correlation)
    .filter((v): v is number => v != null && Number.isFinite(v));

  // Driver = child with largest |YoY|; fall back to largest |spike|.
  const driver =
    [...children]
      .filter((c) => c.yoyGrowthPct != null)
      .sort(
        (a, b) => Math.abs(b.yoyGrowthPct!) - Math.abs(a.yoyGrowthPct!)
      )[0] ??
    [...children]
      .filter((c) => c.spikePts != null)
      .sort((a, b) => Math.abs(b.spikePts!) - Math.abs(a.spikePts!))[0] ??
    null;

  return {
    children,
    spikePts:
      spikes.length > 0
        ? Math.round((mean(spikes) as number) * 10) / 10
        : null,
    yoyGrowthPct:
      yoys.length > 0 ? Math.round((mean(yoys) as number) * 10) / 10 : null,
    correlation:
      corrs.length > 0 ? Math.round((mean(corrs) as number) * 100) / 100 : null,
    driverBrand: driver?.brand ?? null,
  };
}

// ---------------------------------------------------------------------------
// Yahoo helpers
// ---------------------------------------------------------------------------

async function fetchDailyBars(
  ticker: string,
  period1: string,
  period2: string
): Promise<DailyBar[]> {
  const chart = await yahooFinance.chart(ticker, {
    period1: new Date(`${period1}T12:00:00Z`),
    period2: new Date(`${period2}T12:00:00Z`),
    interval: "1d",
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

function nearestOnOrAfter(
  bars: DailyBar[],
  targetDate: string
): DailyBar | null {
  const target = normalizeDateString(targetDate);
  for (const bar of bars) {
    if (bar.date >= target) return bar;
  }
  return null;
}

function nearestOnOrBefore(
  bars: DailyBar[],
  targetDate: string
): DailyBar | null {
  const target = normalizeDateString(targetDate);
  let best: DailyBar | null = null;
  for (const bar of bars) {
    if (bar.date <= target) best = bar;
    else break;
  }
  return best;
}

// ---------------------------------------------------------------------------
// AI Bouncer (Gemini + native Google Search — no Trends CAPTCHA API)
// ---------------------------------------------------------------------------

function buildBouncerPrompt(input: {
  brand: string;
  parentName: string;
  ticker: string;
  targetDate: string;
  math: ParentMath;
}): string {
  const newsStart = addDays(input.targetDate, -NEWS_LOOKBACK_DAYS);
  const mathBlock = [
    `Spike (Engine 1 — current 4w MA − prior 4w MA): ${fmtPts(input.math.spikePts)}`,
    `YoY Growth (Engine 2 — current 4w MA vs ~52w ago): ${fmtPct(input.math.yoyGrowthPct)}`,
    `Pearson correlation (Engine 2 — 5y search↔stock through ${input.targetDate}): ${fmtCorr(input.math.correlation)}`,
    input.math.driverBrand
      ? `Primary child brand driver: ${input.math.driverBrand}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `I am testing a quantitative trading model for ${input.brand} (${input.parentName}, $${input.ticker}) on the specific date of ${input.targetDate}.

The math shows:
${mathBlock}

Use your Google Search tool to find news published specifically in the 4 weeks leading up to ${input.targetDate} (from ${newsStart} to ${input.targetDate}). Do not use news after ${input.targetDate}.

Determine if the search momentum is driven by a POSITIVE catalyst (product hype, earnings beat, structural growth) or a NEGATIVE catalyst (scandal, boycott, missed earnings).

Return a strict JSON object:
catalyst_found: The exact news or event you found (or 'No specific news found, likely organic growth').
sentiment: POSITIVE, NEGATIVE, or NEUTRAL.
reasoning: 1-2 sentences explaining WHY this will affect the stock price.
terminal_verdict: PROJECTED UP, PROJECTED DOWN, or SAFE HOLD.`;
}

async function runAiBouncer(input: {
  brand: string;
  parentName: string;
  ticker: string;
  targetDate: string;
  math: ParentMath;
}): Promise<DualEngineVerdict> {
  const apiKey = process.env[GOOGLE_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `Missing ${GOOGLE_API_KEY_ENV}. Set it in .env.local to run the AI bouncer.`
    );
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const prompt = buildBouncerPrompt(input);

  for (const modelId of GOOGLE_MODEL_IDS) {
    try {
      try {
        const { object } = await generateObject({
          model: google(modelId),
          schema: DualEngineVerdictSchema,
          // @ts-expect-error googleSearch is supported at runtime for Gemini grounding
          tools: {
            google_search: google.tools.googleSearch({}),
          },
          prompt,
        });
        return object;
      } catch (objectError) {
        console.warn(
          `  [bouncer] generateObject ${modelId} failed, trying generateText:`,
          objectError instanceof Error ? objectError.message : objectError
        );
      }

      const { text } = await generateText({
        model: google(modelId),
        // @ts-expect-error googleSearch is supported at runtime for Gemini grounding
        tools: {
          google_search: google.tools.googleSearch({}),
        },
        prompt,
      });

      const parsed = DualEngineVerdictSchema.safeParse(
        JSON.parse(cleanLlmJsonText(text ?? ""))
      );
      if (parsed.success) return parsed.data;
      console.warn(`  [bouncer] Zod parse failed for ${modelId}:`, text);
    } catch (error) {
      console.warn(
        `  [bouncer] ${modelId} failed:`,
        error instanceof Error ? error.message : error
      );
      if (!isModelNotFoundError(error)) continue;
    }
  }

  throw new Error("All Gemini models failed for Dual-Engine AI synthesis.");
}

function verdictAligned(
  verdict: DualEngineVerdict["terminal_verdict"],
  alphaPct: number
): string {
  if (!Number.isFinite(alphaPct)) return "n/a";
  if (verdict === "PROJECTED UP") {
    return alphaPct > 0 ? "HIT (alpha > 0)" : "MISS (alpha ≤ 0)";
  }
  if (verdict === "PROJECTED DOWN") {
    return alphaPct < 0 ? "HIT (alpha < 0)" : "MISS (alpha ≥ 0)";
  }
  // SAFE HOLD — absolute stock move mild vs expecting big directional alpha
  return Math.abs(alphaPct) < 5
    ? "HIT (|alpha| < 5%)"
    : "MISS (|alpha| ≥ 5%)";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { ticker, targetDate } = parseArgs(process.argv.slice(2));
  const parent = getParentByTicker(ticker);
  if (!parent) {
    usageAndExit(
      `unknown ticker "${ticker}" — not in parentCompanies config (lib/entities.ts)`
    );
  }

  const horizonEndIdeal = addDays(targetDate, HOLD_DAYS);
  const today = todayIso();
  const horizonEnd = horizonEndIdeal <= today ? horizonEndIdeal : today;
  const incomplete = horizonEndIdeal > today;
  const brandLabel = parent.childBrands[0] ?? parent.name;

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║  Dual-Engine Case Study — Show Your Work                   ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nTicker     : $${ticker} (${parent.name})`);
  console.log(`Target date: ${targetDate}`);
  console.log(`Child brands: ${parent.childBrands.join(", ")}`);
  console.log(
    `Forward window: ${targetDate} → ${horizonEndIdeal}${
      incomplete ? ` (capped at ${horizonEnd})` : ""
    }`
  );
  console.log(
    "Data: Supabase market_metrics + Yahoo Finance + Gemini Google Search"
  );
  console.log("(No google-trends-api / CAPTCHA path.)");

  // --- Fetch (point-in-time) ---
  divider("1) Fetch (≤ targetDate)");
  console.log("Loading Google Trends from Supabase…");
  const trendRows = await fetchTrendHistory(
    parent.childBrands,
    YEARS_BACK + 1,
    "market_metrics"
  );
  const trendsAsOf = trendRows.filter(
    (row) => normalizeDateString(String(row.date)) <= targetDate
  );
  console.log(
    `  Trends: ${trendRows.length} rows total → ${trendsAsOf.length} on/before ${targetDate}`
  );

  console.log(`Loading Yahoo weekly history for $${ticker} (correlation)…`);
  const stockWeeklyMap = await fetchStockQuotes(ticker, YEARS_BACK + 1);
  const weeklyAsOf = [...stockWeeklyMap.keys()].filter((d) => d <= targetDate)
    .length;
  console.log(
    `  Weekly closes: ${stockWeeklyMap.size} total → ${weeklyAsOf} on/before ${targetDate}`
  );
  await sleep(YAHOO_PAUSE_MS);

  // --- Math engines ---
  divider("2) Dual Math Engines (Show Your Work)");
  const math = computeParentMath(
    parent.childBrands,
    trendsAsOf,
    stockWeeklyMap,
    targetDate
  );

  for (const child of math.children) {
    console.log(`\n  Brand: ${child.brand}`);
    console.log(`    Signal as-of week : ${child.asOfDate ?? "n/a"}`);
    console.log(
      `    Engine 1 (Spike)   : current 4w MA ${fmtMa(child.current4wMa)} − prior 4w MA ${fmtMa(child.prior4wMa)} = ${fmtPts(child.spikePts)}`
    );
    console.log(
      `    Engine 2 (YoY)     : current 4w MA ${fmtMa(child.current4wMa)} vs year-ago 4w MA ${fmtMa(child.yearAgo4wMa)} → ${fmtPct(child.yoyGrowthPct)}`
    );
    console.log(
      `    Engine 2 (Pearson) : 5y search↔stock r = ${fmtCorr(child.correlation)}`
    );
  }

  console.log("\n  ══════════════════════════════════════");
  console.log("  PARENT AGGREGATE (audit these numbers)");
  console.log(`  Spike amount     : ${fmtPts(math.spikePts)}`);
  console.log(`  YoY Growth       : ${fmtPct(math.yoyGrowthPct)}`);
  console.log(`  Correlation (r)  : ${fmtCorr(math.correlation)}`);
  console.log(`  Driver brand     : ${math.driverBrand ?? "n/a"}`);
  console.log("  ══════════════════════════════════════");

  // --- AI Bouncer ---
  divider("3) AI Synthesis (The Bouncer)");
  console.log(
    `Searching news ${addDays(targetDate, -NEWS_LOOKBACK_DAYS)} → ${targetDate} via Gemini Google Search…\n`
  );
  const ai = await runAiBouncer({
    brand: brandLabel,
    parentName: parent.name,
    ticker,
    targetDate,
    math,
  });

  console.log("AI exact JSON output:");
  console.log(JSON.stringify(ai, null, 2));
  console.log("\n  catalyst_found   :", ai.catalyst_found);
  console.log("  sentiment        :", ai.sentiment);
  console.log("  reasoning        :", ai.reasoning);
  console.log("  terminal_verdict :", ai.terminal_verdict);

  // --- Forward reveal ---
  divider("4) The Reveal (90-day reality)");
  console.log(`Loading Yahoo daily closes for $${ticker} + ${SPX_TICKER}…`);
  const dailyStart = addDays(targetDate, -14);
  const dailyEnd = addDays(horizonEnd, 7);
  const stockDaily = await fetchDailyBars(ticker, dailyStart, dailyEnd);
  await sleep(YAHOO_PAUSE_MS);
  const spxDaily = await fetchDailyBars(SPX_TICKER, dailyStart, dailyEnd);

  const stockEntry =
    nearestOnOrAfter(stockDaily, targetDate) ??
    nearestOnOrBefore(stockDaily, targetDate);
  const stockExit = nearestOnOrBefore(stockDaily, horizonEnd);
  const spxEntry =
    nearestOnOrAfter(spxDaily, targetDate) ??
    nearestOnOrBefore(spxDaily, targetDate);
  const spxExit = nearestOnOrBefore(spxDaily, horizonEnd);

  if (!stockEntry || !stockExit || !spxEntry || !spxExit) {
    console.error("\nCould not resolve forward prices for the reveal window.");
    process.exit(1);
  }

  const stockReturnPct = pctReturn(stockEntry.close, stockExit.close);
  const spxReturnPct = pctReturn(spxEntry.close, spxExit.close);
  const alphaPct = stockReturnPct - spxReturnPct;

  console.log(
    `\n  $${ticker}: ${fmtUsd(stockEntry.close)} (${stockEntry.date}) → ${fmtUsd(stockExit.close)} (${stockExit.date})`
  );
  console.log(
    `  SPX    : ${fmtUsd(spxEntry.close)} (${spxEntry.date}) → ${fmtUsd(spxExit.close)} (${spxExit.date})`
  );
  if (incomplete) {
    console.log(
      `  Note   : Ideal +${HOLD_DAYS}d end was ${horizonEndIdeal}; using ${horizonEnd}.`
    );
  }

  divider();
  console.log(`\nCase Study: $${ticker} on ${targetDate}\n`);
  console.log(
    `Our Math   : Spike ${fmtPts(math.spikePts)} · YoY ${fmtPct(math.yoyGrowthPct)} · r ${fmtCorr(math.correlation)}`
  );
  console.log(
    `AI Verdict : ${ai.terminal_verdict} (${ai.sentiment}) — ${ai.catalyst_found}`
  );
  console.log(
    `The Result : Stock ${fmtPct(stockReturnPct)} · SPX ${fmtPct(spxReturnPct)} · Alpha ${fmtPct(alphaPct)}`
  );
  console.log(
    `Scorecard  : ${verdictAligned(ai.terminal_verdict, alphaPct)}`
  );
  console.log("");
}

main().catch((err) => {
  console.error("\nDual-Engine case study failed:", err);
  process.exit(1);
});
