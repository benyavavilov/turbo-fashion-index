import { NextResponse } from "next/server";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

import type { TrendDatum } from "@/lib/chart-data";
import { normalizeDateString } from "@/lib/chart-data";
import { extractBrandSeries, sliceSeriesByDays } from "@/lib/screener";
import { parsePortfolioAdvice } from "@/lib/sentiment-parse";
import { createBrowserSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;

interface MetricJoinRow {
  recorded_date: string;
  interest_value: number;
  tracked_entities: { name: string; category: string } | null;
}

interface HoldingInput {
  brand: string;
  ticker: string;
  strategy?: string;
  side?: "LONG" | "SHORT";
  buyPrice?: number;
  buyDate?: string;
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

async function fetchRecentTrends(brandNames: string[]): Promise<TrendDatum[]> {
  const supabase = createBrowserSupabase();
  if (!supabase || brandNames.length === 0) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 45);
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
    .limit(5000);

  if (error) throw error;
  return reshapeForRecharts((rows ?? []) as unknown as MetricJoinRow[]);
}

export async function POST(req: Request) {
  try {
    const googleKey = process.env[GOOGLE_API_KEY_ENV];
    if (!googleKey) {
      return NextResponse.json(
        { error: `Set ${GOOGLE_API_KEY_ENV} in .env.local`, advice: [] },
        { status: 500 }
      );
    }

    let body: { holdings?: HoldingInput[] };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", advice: [] },
        { status: 400 }
      );
    }

    const holdings = (body.holdings ?? []).filter(
      (h) => h.brand?.trim() && h.ticker?.trim()
    );

    if (holdings.length === 0) {
      return NextResponse.json({ advice: [] });
    }

    const brandNames = [...new Set(holdings.map((h) => h.brand.trim()))];
    const trendData = await fetchRecentTrends(brandNames);

    const trendSummaries = holdings.map((h) => {
      const series = sliceSeriesByDays(
        extractBrandSeries(trendData, h.brand),
        30
      );
      const values = series.map((p) => ({ date: p.date, interest: p.value }));
      const first = values[0]?.interest;
      const last = values[values.length - 1]?.interest;
      const net =
        typeof first === "number" && typeof last === "number"
          ? Math.round((last - first) * 10) / 10
          : null;

      return {
        brand: h.brand,
        ticker: h.ticker,
        strategy: h.strategy ?? "unknown",
        side: h.side ?? "LONG",
        buyPrice: h.buyPrice ?? null,
        buyDate: h.buyDate ?? null,
        netChange30d: net,
        recentTrend: values,
      };
    });

    const prompt = `The user is currently holding these stocks based on previous hype spikes. Based on the recent 30-day search trend data provided, has the momentum died? Give a strict verdict of 'HOLD', 'TAKE PROFITS', or 'SELL/CUT LOSSES' for each position, with a 1-sentence rationale.

Holdings + trend context:
${JSON.stringify(trendSummaries, null, 2)}

Respond with STRICT JSON only — no markdown:
{"advice":[{"ticker":"NKE","verdict":"HOLD"|"TAKE PROFITS"|"SELL/CUT LOSSES","rationale":"1 sentence"}]}

Include exactly one advice object per ticker in the holdings list.`;

    const google = createGoogleGenerativeAI({ apiKey: googleKey });
    let raw = "";

    for (const modelId of GOOGLE_MODEL_IDS) {
      try {
        const { text } = await generateText({
          model: google(modelId),
          prompt,
        });
        raw = text ?? "";
        break;
      } catch (error) {
        console.warn(`[api/portfolio-advice] ${modelId} failed:`, error);
        if (!isModelNotFoundError(error)) break;
      }
    }

    let advice = parsePortfolioAdvice(raw);

    // Ensure every holding has a row
    const byTicker = new Map(
      advice.map((a) => [a.ticker.toUpperCase(), a] as const)
    );
    advice = holdings.map((h) => {
      const existing = byTicker.get(h.ticker.toUpperCase());
      if (existing) return { ...existing, ticker: h.ticker };
      return {
        ticker: h.ticker,
        verdict: "HOLD" as const,
        rationale: "Insufficient trend context — defaulting to HOLD.",
      };
    });

    return NextResponse.json({ advice });
  } catch (error) {
    console.error("[api/portfolio-advice]", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, advice: [] }, { status: 500 });
  }
}
