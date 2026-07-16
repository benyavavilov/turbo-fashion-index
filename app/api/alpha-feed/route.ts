import { NextResponse } from "next/server";

import { mergeStockPrices } from "@/lib/chart-data";
import { parentCompanies } from "@/lib/entities";
import {
  buildResult,
  runEventStudy,
  type EventStudyEvent,
  type EventStudyResult,
} from "@/lib/event-study";
import {
  fetchStockQuotes,
  fetchTrendHistory,
  latestQuote,
} from "@/lib/market-data";
import { analyzeSpikeSentimentServer } from "@/lib/sentiment-server";
import type { AlphaCardKind, AlphaFeedCard } from "@/lib/alpha-feed";

export const runtime = "nodejs";
export const maxDuration = 120;

const STOCK_KEY = "__stock";
const YEARS_BACK = 2;

interface BrandStudy {
  parentName: string;
  ticker: string;
  brand: string;
  study: EventStudyResult;
  lastPrice: number | null;
  latestEvent: EventStudyEvent | null;
}

/**
 * Enrich the latest event with Gemini sentiment — mirrors
 * runEventStudyWithSentiment for the most recent catalyst.
 */
async function enrichLatestWithSentiment(
  brand: string,
  study: EventStudyResult
): Promise<EventStudyResult> {
  if (study.events.length === 0) return study;
  const latest = [...study.events].sort((a, b) =>
    b.date.localeCompare(a.date)
  )[0];
  const { sentiment, reason } = await analyzeSpikeSentimentServer(
    brand,
    latest.date
  );
  const enriched = study.events.map((e) =>
    e.date === latest.date && e.increase === latest.increase
      ? { ...e, sentiment, reason }
      : e
  );
  return buildResult(enriched);
}

export async function POST() {
  try {
    const brandNames = [
      ...new Set(parentCompanies.flatMap((p) => p.childBrands)),
    ];
    const trendData = await fetchTrendHistory(brandNames, YEARS_BACK);

    const tickerCache = new Map<string, Map<string, number>>();
    const studies: BrandStudy[] = [];

    for (const parent of parentCompanies) {
      let stockMap = tickerCache.get(parent.ticker);
      if (!stockMap) {
        try {
          stockMap = await fetchStockQuotes(parent.ticker, YEARS_BACK);
        } catch (error) {
          console.warn(
            `[api/alpha-feed] Stock failed for ${parent.ticker}:`,
            error
          );
          stockMap = new Map();
        }
        tickerCache.set(parent.ticker, stockMap);
      }

      const lastPrice = latestQuote(stockMap);
      const merged = mergeStockPrices(trendData, stockMap, STOCK_KEY);

      for (const brand of parent.childBrands) {
        const study = runEventStudy(merged, brand, STOCK_KEY);
        if (study.eventCount === 0) continue;
        const latestEvent =
          [...study.events].sort((a, b) => b.date.localeCompare(a.date))[0] ??
          null;
        studies.push({
          parentName: parent.name,
          ticker: parent.ticker,
          brand,
          study,
          lastPrice,
          latestEvent,
        });
      }
    }

    // Quantitative event study has no sentiment yet — rank by mean 90d return.
    const byAvgReturn = [...studies].sort(
      (a, b) => b.study.averageReturnPct - a.study.averageReturnPct
    );

    const topBuy = byAvgReturn[0] ?? null;
    const topShort =
      [...byAvgReturn].reverse().find((s) => s.brand !== topBuy?.brand) ?? null;

    const watch =
      byAvgReturn.find(
        (s) =>
          s.brand !== topBuy?.brand &&
          s.brand !== topShort?.brand &&
          Math.abs(s.study.averageReturnPct) <
            Math.max(
              Math.abs(topBuy?.study.averageReturnPct ?? 0),
              Math.abs(topShort?.study.averageReturnPct ?? 0)
            )
      ) ??
      byAvgReturn.find(
        (s) => s.brand !== topBuy?.brand && s.brand !== topShort?.brand
      ) ??
      null;

    const cards: AlphaFeedCard[] = [];

    async function toCard(
      row: BrandStudy,
      kind: AlphaCardKind
    ): Promise<AlphaFeedCard> {
      const enriched = await enrichLatestWithSentiment(row.brand, row.study);
      const latest =
        [...enriched.events].sort((a, b) => b.date.localeCompare(a.date))[0] ??
        null;

      const edge = enriched.averageReturnPct;

      const verdict =
        kind === "TOP BUY"
          ? "STRONG BUY"
          : kind === "TOP SHORT"
            ? "SHORT"
            : "WATCH";

      const catalyst =
        latest?.reason?.trim() ||
        (latest
          ? `Latest ${latest.increase.toFixed(0)}pt search spike on ${latest.date}.`
          : "Event-study catalysts available for this parent.");

      const risk =
        kind === "TOP SHORT"
          ? `Short edge: avg ${edge.toFixed(1)}% after hype spikes (${enriched.eventCount} events).`
          : `Long edge: avg ${edge.toFixed(1)}% after hype spikes (${enriched.eventCount} events).`;

      return {
        kind,
        parentName: row.parentName,
        ticker: row.ticker,
        brand: row.brand,
        dataPoint: `${edge >= 0 ? "+" : ""}${edge.toFixed(1)}% avg 90d`,
        averageReturnPct: edge,
        eventCount: enriched.eventCount,
        verdict,
        bullets: [catalyst.slice(0, 140), risk.slice(0, 140)],
        lastPrice: row.lastPrice,
        sentiment: latest?.sentiment,
        reason: latest?.reason,
      };
    }

    if (topBuy) cards.push(await toCard(topBuy, "TOP BUY"));
    if (topShort) cards.push(await toCard(topShort, "TOP SHORT"));
    if (watch) cards.push(await toCard(watch, "WATCH"));

    return NextResponse.json({
      cards,
      scannedParents: parentCompanies.length,
      scannedBrands: brandNames.length,
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
