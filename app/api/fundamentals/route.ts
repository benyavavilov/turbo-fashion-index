import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";

export const runtime = "nodejs";
export const maxDuration = 30;

const yahooFinance = new YahooFinance();

function formatEarningsTimestamp(value: unknown): string {
  if (value == null) return "N/A";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return "N/A";
  // Yahoo may return seconds or ms
  const ms = n > 1e12 ? n : n * 1000;
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "N/A";
  }
}

export interface FundamentalsPayload {
  ticker: string;
  lastPrice: number | null;
  trailingPE: string;
  forwardPE: string;
  nextEarnings: string;
  recommendationKey: string;
}

async function fetchOne(ticker: string): Promise<FundamentalsPayload> {
  let lastPrice: number | null = null;
  let trailingPE = "N/A";
  let forwardPE = "N/A";
  let nextEarnings = "N/A";
  let recommendationKey = "N/A";

  try {
    const summary = (await yahooFinance.quoteSummary(ticker, {
      modules: ["financialData"],
    })) as {
      financialData?: {
        currentPrice?: number;
        recommendationKey?: string;
      };
    };
    const fd = summary.financialData;
    if (typeof fd?.currentPrice === "number") lastPrice = fd.currentPrice;
    if (fd?.recommendationKey) recommendationKey = String(fd.recommendationKey);
  } catch {
    // continue with quote()
  }

  try {
    const q = (await yahooFinance.quote(ticker)) as Record<string, unknown>;
    if (lastPrice == null && typeof q.regularMarketPrice === "number") {
      lastPrice = q.regularMarketPrice;
    }
    if (typeof q.trailingPE === "number") {
      trailingPE = q.trailingPE.toFixed(1);
    }
    if (typeof q.forwardPE === "number") {
      forwardPE = q.forwardPE.toFixed(1);
    }
    nextEarnings = formatEarningsTimestamp(
      q.earningsTimestampStart ?? q.earningsTimestamp ?? q.earningsTimestampEnd
    );
  } catch {
    // leave N/A
  }

  return {
    ticker,
    lastPrice,
    trailingPE,
    forwardPE,
    nextEarnings,
    recommendationKey,
  };
}

/** GET ?ticker=ANF or ?tickers=ANF,GPS */
export async function GET(request: NextRequest) {
  const single = request.nextUrl.searchParams.get("ticker");
  const multi = request.nextUrl.searchParams.get("tickers");
  const tickers = [
    ...(single ? [single] : []),
    ...(multi ? multi.split(",").map((t) => t.trim()).filter(Boolean) : []),
  ].map((t) => t.toUpperCase());

  if (tickers.length === 0) {
    return NextResponse.json(
      { error: "ticker or tickers is required" },
      { status: 400 }
    );
  }

  try {
    const unique = [...new Set(tickers)].slice(0, 12);
    const results: Record<string, FundamentalsPayload> = {};
    for (const t of unique) {
      results[t] = await fetchOne(t);
    }
    if (unique.length === 1) {
      return NextResponse.json(results[unique[0]]);
    }
    return NextResponse.json({ fundamentals: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fundamentals failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
