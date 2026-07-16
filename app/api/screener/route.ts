import { NextResponse } from "next/server";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import YahooFinance from "yahoo-finance2";

import type { TrendDatum } from "@/lib/chart-data";
import { normalizeDateString } from "@/lib/chart-data";
import { entities } from "@/lib/entities";
import {
  computeBrandMetrics,
  correlationTrendVsStock,
  extractBrandSeries,
  formatCorrDataPoint,
  formatDropDataPoint,
  formatSpikeDataPoint,
  rankStrategyCandidates,
  SCREENER_CORR_YEARS,
  sliceSeriesByDays,
  type BrandMetrics,
  type BreakingCatalyst,
  type StrategyPick,
  type StrategyRankerResponse,
} from "@/lib/screener";
import {
  parseStrategyAdvice,
  STRATEGY_ADVICE_FALLBACK,
  type StrategyAdvice,
} from "@/lib/sentiment-parse";
import { createBrowserSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 120;

const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;

const yahooFinance = new YahooFinance();

interface MetricJoinRow {
  recorded_date: string;
  interest_value: number;
  tracked_entities: { name: string; category: string } | null;
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

function reshapeForRecharts(rows: MetricJoinRow[]): TrendDatum[] {
  const byDate = new Map<string, TrendDatum>();

  for (const row of rows) {
    const entity = row.tracked_entities;
    if (!entity?.name) continue;

    const date = normalizeDateString(row.recorded_date);
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = { date };
      byDate.set(date, bucket);
    }
    bucket[entity.name] = row.interest_value;
  }

  return Array.from(byDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}

async function fetchTrendHistory(
  brandNames: string[],
  yearsBack: number
): Promise<TrendDatum[]> {
  const supabase = createBrowserSupabase();
  if (!supabase || brandNames.length === 0) return [];

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - yearsBack);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const { data: entityRows, error: entityError } = await supabase
    .from("tracked_entities")
    .select("id, name")
    .in("name", brandNames);

  if (entityError) throw entityError;
  if (!entityRows?.length) return [];

  const entityIds = entityRows.map((row) => row.id as string);

  const { data: rows, error } = await supabase
    .from("market_metrics")
    .select(
      "recorded_date, interest_value, tracked_entities!inner(name, category)"
    )
    .in("entity_id", entityIds)
    .gte("recorded_date", cutoffIso)
    .order("recorded_date", { ascending: true })
    .limit(20000);

  if (error) throw error;
  return reshapeForRecharts((rows ?? []) as unknown as MetricJoinRow[]);
}

async function fetchStockQuotes(
  ticker: string,
  yearsBack: number
): Promise<Map<string, number>> {
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - yearsBack);

  const chart = await yahooFinance.chart(ticker, {
    period1,
    period2: new Date(),
    interval: "1wk",
  });

  const rawQuotes =
    (chart as { quotes?: { date?: Date; close?: number | null }[] }).quotes ??
    [];

  const map = new Map<string, number>();
  for (const q of rawQuotes) {
    if (q.close == null || q.date == null) continue;
    const date = new Date(q.date).toISOString().slice(0, 10);
    map.set(date, Math.round(q.close * 100) / 100);
  }
  return map;
}

function latestQuote(map: Map<string, number>): number | null {
  if (map.size === 0) return null;
  const lastDate = [...map.keys()].sort().at(-1);
  return lastDate ? (map.get(lastDate) ?? null) : null;
}

async function askGeminiJson(prompt: string): Promise<string> {
  const googleKey = process.env[GOOGLE_API_KEY_ENV];
  if (!googleKey) return "";

  const google = createGoogleGenerativeAI({ apiKey: googleKey });

  for (const modelId of GOOGLE_MODEL_IDS) {
    try {
      const { text } = await generateText({
        model: google(modelId),
        tools: {
          google_search: google.tools.googleSearch({}),
        },
        prompt,
      });
      return text ?? "";
    } catch (error) {
      console.warn(`[api/screener] Gemini ${modelId} failed:`, error);
      if (!isModelNotFoundError(error)) break;
    }
  }

  return "";
}

const JSON_CONTRACT = `Respond with STRICT JSON only — no markdown, no prose:
{"verdict":"1-3 WORD ACTION","bullets":["catalyst bullet ≤18 words","risk bullet ≤18 words"],"sentiment":"POSITIVE"|"NEGATIVE"|"NEUTRAL"}
verdict examples: "STRONG BUY", "ACCUMULATE", "SHORT", "FADE", "WATCH".`;

async function adviseMomentum(
  brand: string,
  date: string,
  spike: number
): Promise<StrategyAdvice> {
  const raw = await askGeminiJson(
    `You are a fashion-markets trading desk AI with Google Search.
${brand} posted a +${spike.toFixed(1)} pt Google search spike around ${date}.
Give a concise long-biased momentum call. ${JSON_CONTRACT}`
  );
  return raw ? parseStrategyAdvice(raw) : { ...STRATEGY_ADVICE_FALLBACK, verdict: "ACCUMULATE", sentiment: "POSITIVE" };
}

async function adviseMacro(
  brand: string,
  ticker: string,
  corr: number
): Promise<StrategyAdvice> {
  const raw = await askGeminiJson(
    `You are a fundamental equity analyst with Google Search.
${brand} (${ticker}) has 2Y search↔price correlation r=${corr.toFixed(2)} and a recent positive search trend.
Give a concise lower-risk value/accumulate call. ${JSON_CONTRACT}`
  );
  return raw ? parseStrategyAdvice(raw) : { ...STRATEGY_ADVICE_FALLBACK, verdict: "ACCUMULATE", sentiment: "POSITIVE" };
}

async function adviseContrarian(
  brand: string,
  date: string,
  drop: number,
  spike: number
): Promise<StrategyAdvice> {
  const raw = await askGeminiJson(
    `You are a financial historian with Google Search covering fashion equities.
Brand: ${brand}. Around ${date}, search interest showed ${
      Math.abs(drop) >= spike
        ? `a sharp drop of ${drop.toFixed(1)} points`
        : `a +${spike.toFixed(1)} pt spike that may reflect negative news`
    }.
Prefer short/contrarian framing if scandal, miss, boycott, or demand fade is likely. ${JSON_CONTRACT}`
  );
  return raw
    ? parseStrategyAdvice(raw)
    : {
        ...STRATEGY_ADVICE_FALLBACK,
        verdict: "SHORT",
        sentiment: "NEGATIVE",
        bullets: [
          "Search interest weakening or negative catalyst likely.",
          "Risk: rebound if the story was a fakeout.",
        ],
      };
}

function pickBreakingCatalyst(strategies: StrategyPick[]): BreakingCatalyst | null {
  if (strategies.length === 0) return null;
  const winner = [...strategies].sort(
    (a, b) => Math.abs(b.anomalyScore) - Math.abs(a.anomalyScore)
  )[0];
  return {
    strategyId: winner.strategyId,
    brand: winner.brand,
    ticker: winner.ticker,
    headline:
      winner.strategyId === "contrarian"
        ? "Urgent downside catalyst"
        : winner.strategyId === "momentum"
          ? "Extreme search momentum"
          : "High-conviction correlated move",
    dataPoint: winner.dataPoint,
    verdict: winner.verdict,
    bullets: winner.bullets,
    anomalyScore: winner.anomalyScore,
  };
}

export async function POST() {
  try {
    const brands = entities.filter(
      (e) => e.category === "brand" && Boolean(e.ticker)
    );

    const trendData = await fetchTrendHistory(
      brands.map((b) => b.name),
      SCREENER_CORR_YEARS
    );

    const metrics: BrandMetrics[] = [];
    const priceByTicker = new Map<string, number | null>();

    await Promise.all(
      brands.map(async (brand) => {
        if (!brand.ticker) return;
        const series = extractBrandSeries(trendData, brand.name);
        if (series.length === 0) return;

        let correlation: number | null = null;
        let lastPrice: number | null = null;
        try {
          const stockMap = await fetchStockQuotes(
            brand.ticker,
            SCREENER_CORR_YEARS
          );
          lastPrice = latestQuote(stockMap);
          priceByTicker.set(brand.ticker, lastPrice);
          if (stockMap.size > 0) {
            const corrSeries = sliceSeriesByDays(
              series,
              SCREENER_CORR_YEARS * 365
            );
            correlation = correlationTrendVsStock(corrSeries, stockMap);
          }
        } catch (error) {
          console.error(
            `[api/screener] Stock fetch failed for ${brand.name}:`,
            error
          );
          priceByTicker.set(brand.ticker, null);
        }

        metrics.push(
          computeBrandMetrics(brand.name, brand.ticker, series, correlation)
        );
      })
    );

    if (metrics.length === 0) {
      const empty: StrategyRankerResponse = {
        strategies: [],
        breakingCatalyst: null,
        scannedBrands: brands.length,
        generatedAt: new Date().toISOString(),
      };
      return NextResponse.json(empty);
    }

    const ranked = rankStrategyCandidates(metrics);
    let { momentum, macro, contrarian } = ranked;

    let contrarianPre: StrategyAdvice | null = null;
    const usedBrands = new Set(
      [momentum?.brand, macro?.brand].filter(Boolean) as string[]
    );
    const topSpikes = [...metrics]
      .filter((m) => !usedBrands.has(m.brand))
      .sort((a, b) => b.spikeIncrease - a.spikeIncrease);

    if (
      contrarian &&
      Math.abs(contrarian.dropDecrease) < 8 &&
      topSpikes[0] &&
      topSpikes[0].spikeIncrease >= 12
    ) {
      const probe = topSpikes[0];
      const probed = await adviseContrarian(
        probe.brand,
        probe.spikeDate,
        probe.dropDecrease,
        probe.spikeIncrease
      );
      if (probed.sentiment === "NEGATIVE" || probed.verdict.includes("SHORT")) {
        contrarian = probe;
        contrarianPre = probed;
      }
    }

    const strategies: StrategyPick[] = [];

    if (momentum) {
      const advice = await adviseMomentum(
        momentum.brand,
        momentum.spikeDate,
        momentum.spikeIncrease
      );
      strategies.push({
        strategyId: "momentum",
        strategyName: "High-Risk Momentum",
        riskLevel: "High Risk",
        brand: momentum.brand,
        ticker: momentum.ticker,
        dataPoint: formatSpikeDataPoint(momentum.spikeIncrease),
        anomalyScore: momentum.spikeIncrease,
        asOfDate: momentum.spikeDate,
        verdict: advice.verdict,
        bullets: advice.bullets,
        sentiment: advice.sentiment ?? "POSITIVE",
        lastPrice: priceByTicker.get(momentum.ticker) ?? null,
      });
    }

    if (macro) {
      const corr = macro.correlation ?? 0;
      const advice = await adviseMacro(macro.brand, macro.ticker, corr);
      strategies.push({
        strategyId: "macro",
        strategyName: "Macro Value",
        riskLevel: "Low Risk",
        brand: macro.brand,
        ticker: macro.ticker,
        dataPoint: formatCorrDataPoint(corr),
        anomalyScore:
          Math.abs(corr) * 20 + Math.max(0, macro.spikeIncrease) * 0.25,
        asOfDate: macro.spikeDate || macro.dropDate,
        verdict: advice.verdict,
        bullets: advice.bullets,
        sentiment: advice.sentiment ?? "POSITIVE",
        lastPrice: priceByTicker.get(macro.ticker) ?? null,
      });
    }

    if (contrarian) {
      const advice =
        contrarianPre ??
        (await adviseContrarian(
          contrarian.brand,
          Math.abs(contrarian.dropDecrease) >= contrarian.spikeIncrease
            ? contrarian.dropDate
            : contrarian.spikeDate,
          contrarian.dropDecrease,
          contrarian.spikeIncrease
        ));

      const useDrop =
        Math.abs(contrarian.dropDecrease) >= contrarian.spikeIncrease ||
        advice.sentiment !== "NEGATIVE";

      strategies.push({
        strategyId: "contrarian",
        strategyName: "Contrarian Short",
        riskLevel: "Opportunistic",
        brand: contrarian.brand,
        ticker: contrarian.ticker,
        dataPoint: useDrop
          ? formatDropDataPoint(contrarian.dropDecrease)
          : formatSpikeDataPoint(contrarian.spikeIncrease),
        anomalyScore: Math.max(
          Math.abs(contrarian.dropDecrease),
          advice.sentiment === "NEGATIVE" ? contrarian.spikeIncrease : 0
        ),
        asOfDate:
          useDrop && Math.abs(contrarian.dropDecrease) > 0
            ? contrarian.dropDate
            : contrarian.spikeDate,
        verdict: advice.verdict,
        bullets: advice.bullets,
        sentiment: advice.sentiment ?? "NEGATIVE",
        lastPrice: priceByTicker.get(contrarian.ticker) ?? null,
      });
    }

    const payload: StrategyRankerResponse = {
      strategies,
      breakingCatalyst: pickBreakingCatalyst(strategies),
      scannedBrands: brands.length,
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(payload);
  } catch (error) {
    console.error("[api/screener]", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: message,
        strategies: [],
        breakingCatalyst: null,
        scannedBrands: 0,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
