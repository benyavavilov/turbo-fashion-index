import { NextResponse } from "next/server";

import {
  selectHighConvictionInsights,
  type AiInsightRow,
} from "@/lib/ai-insights";
import { parentCompanies } from "@/lib/entities";
import { createBrowserSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 30;

const FEED_LIMIT = 6;

/**
 * High-conviction Alpha Feed: top insights by confidence, then |momentum|.
 * No live Gemini — run `npm run generate:insights` to refresh.
 */
export async function POST() {
  try {
    const supabase = createBrowserSupabase();
    if (!supabase) {
      return NextResponse.json(
        {
          error: "Supabase is not configured",
          cards: [],
          scannedParents: 0,
          scannedBrands: 0,
        },
        { status: 500 }
      );
    }

    const { data, error } = await supabase.from("ai_insights").select("*");

    if (error) {
      throw new Error(error.message);
    }

    const rows = (data ?? []) as AiInsightRow[];
    // confidence_score DESC, then ABS(momentum_pct) DESC (client-side;
    // PostgREST has no ABS order without an RPC).
    const cards = selectHighConvictionInsights(rows, FEED_LIMIT);
    const parentTickers = new Set(rows.map((r) => r.ticker.toUpperCase()));
    const generatedAt =
      [...rows].sort((a, b) =>
        (b.generated_at ?? "").localeCompare(a.generated_at ?? "")
      )[0]?.generated_at ?? new Date().toISOString();

    return NextResponse.json({
      cards,
      scannedParents: parentTickers.size || parentCompanies.length,
      scannedBrands: parentCompanies.reduce(
        (n, p) => n + p.childBrands.length,
        0
      ),
      generatedAt,
    });
  } catch (error) {
    console.error("[api/alpha-feed]", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message, cards: [], scannedParents: 0, scannedBrands: 0 },
      { status: 500 }
    );
  }
}

/** Allow GET for simple cache reads / health checks. */
export async function GET() {
  return POST();
}
