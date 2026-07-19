import { NextResponse } from "next/server";

import {
  INSIGHT_GENERATING_FALLBACK,
  selectBriefForTicker,
  type AiInsightRow,
} from "@/lib/ai-insights";
import { getParentByTicker } from "@/lib/entities";
import { createBrowserSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Lightning-fast company brief: read cached `ai_insights` for the ticker.
 * No live Gemini — run `npm run generate:insights` to refresh.
 */
export async function POST(req: Request) {
  try {
    let body: { ticker?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const ticker = body.ticker?.trim().toUpperCase();
    if (!ticker) {
      return NextResponse.json({ error: "ticker is required" }, { status: 400 });
    }

    const parent = getParentByTicker(ticker);
    if (!parent) {
      return NextResponse.json(
        { error: "Unknown parent ticker" },
        { status: 404 }
      );
    }

    const supabase = createBrowserSupabase();
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase is not configured" },
        { status: 500 }
      );
    }

    const { data, error } = await supabase
      .from("ai_insights")
      .select("*")
      .eq("ticker", ticker);

    if (error) {
      throw new Error(error.message);
    }

    const rows = (data ?? []) as AiInsightRow[];
    const brief = selectBriefForTicker(rows, ticker);

    if (!brief) {
      return NextResponse.json({
        found: false,
        headline: INSIGHT_GENERATING_FALLBACK,
        heroText: INSIGHT_GENERATING_FALLBACK,
        sentiment: "NEUTRAL" as const,
        direction: null,
        bullets: [],
      });
    }

    return NextResponse.json(brief);
  } catch (error) {
    console.error("[api/company-brief]", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ticker = url.searchParams.get("ticker") ?? "";
  return POST(
    new Request(req.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    })
  );
}
