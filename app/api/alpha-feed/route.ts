import { NextResponse } from "next/server";

import {
  selectHighConvictionInsights,
  type AiInsightRow,
  type AlphaFeedCard,
} from "@/lib/ai-insights";
import { getParentByTicker, parentCompanies } from "@/lib/entities";
import { fetchTrendHistory } from "@/lib/market-data";
import {
  SNIPER_LEDGER_MIN_DATE,
  sniperAccuracyForTicker,
} from "@/lib/sniper-accuracy";
import { createBrowserSupabase } from "@/lib/supabase";
import historicalEstimates from "@/data/historical-estimates.json";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Lean Earnings Whisper columns only — no correlation. */
const FEED_SELECT = [
  "ticker",
  "parent_name",
  "brand",
  "earnings_mismatch",
  "expected_revenue_growth",
  "momentum_pct",
  "terminal_verdict",
  "next_earnings_date",
].join(",");

type EstimatesMap = Record<
  string,
  {
    date: string;
    estimatedRevenueGrowth: number;
    actualRevenueGrowth: number;
  }[]
>;

const ESTIMATES = historicalEstimates as EstimatesMap;

/**
 * Earnings Whisper Main Feed from cached ai_insights (curated parents only).
 * Enriches each card with post-2024 Historical Sniper Accuracy.
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

    const { data, error } = await supabase
      .from("ai_insights")
      .select(FEED_SELECT);

    if (error) {
      throw new Error(error.message);
    }

    const activeTickers = new Set(
      parentCompanies.map((p) => p.ticker.toUpperCase())
    );
    const rows = ((data ?? []) as unknown as AiInsightRow[]).filter((r) =>
      activeTickers.has(r.ticker.toUpperCase())
    );

    let cards: AlphaFeedCard[] = selectHighConvictionInsights(
      rows,
      Number.MAX_SAFE_INTEGER
    );

    // Live Sniper accuracy (same 15% / post-2024 ledger math as company page).
    const brandNames = [
      ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
    ];
    try {
      const trends = await fetchTrendHistory(brandNames, 5, "market_metrics");
      cards = cards.map((card) => {
        const parent = getParentByTicker(card.ticker);
        if (!parent) return card;
        const estimates = ESTIMATES[parent.ticker] ?? [];
        const summary = sniperAccuracyForTicker(
          estimates,
          trends,
          parent.childBrands,
          { minDate: SNIPER_LEDGER_MIN_DATE }
        );
        return {
          ...card,
          historicalAccuracyLabel: summary.label,
          historicalAccuracyPct: summary.winRatePct,
        };
      });
    } catch (enrichError) {
      console.warn("[api/alpha-feed] sniper accuracy enrich failed:", enrichError);
    }

    // Strict feed order: Historical Accuracy % desc → ticker A–Z;
    // N/A / — / 0-signal brands forced to the bottom.
    cards = [...cards].sort((a, b) => {
      const aBottom =
        a.historicalAccuracyPct == null ||
        !a.historicalAccuracyLabel ||
        a.historicalAccuracyLabel === "—";
      const bBottom =
        b.historicalAccuracyPct == null ||
        !b.historicalAccuracyLabel ||
        b.historicalAccuracyLabel === "—";
      if (aBottom !== bBottom) return aBottom ? 1 : -1;
      if (!aBottom && !bBottom) {
        const ap = a.historicalAccuracyPct ?? -1;
        const bp = b.historicalAccuracyPct ?? -1;
        if (bp !== ap) return bp - ap;
      }
      return a.ticker.localeCompare(b.ticker);
    });

    const parentTickers = new Set(rows.map((r) => r.ticker.toUpperCase()));

    return NextResponse.json({
      cards,
      scannedParents: parentTickers.size || parentCompanies.length,
      scannedBrands: parentCompanies.reduce(
        (n, p) => n + p.childBrands.length,
        0
      ),
      generatedAt: new Date().toISOString(),
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
