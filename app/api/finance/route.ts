import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";

export const runtime = "nodejs";

const yahooFinance = new YahooFinance();
const STOCK_KEY = "__stock";

function periodStart(timeframe: string): Date {
  const d = new Date();
  if (timeframe === "6M") d.setMonth(d.getMonth() - 6);
  else if (timeframe === "1Y") d.setFullYear(d.getFullYear() - 1);
  else d.setFullYear(d.getFullYear() - 5);
  return d;
}

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker");
  const timeframe = request.nextUrl.searchParams.get("timeframe") ?? "1Y";

  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  try {
    const period1 = periodStart(timeframe);
    const chart = await yahooFinance.chart(ticker, {
      period1,
      period2: new Date(),
      interval: "1wk",
    });

    const rawQuotes =
      (chart as { quotes?: { date?: Date; close?: number | null }[] }).quotes ??
      [];

    const quotes = rawQuotes
      .filter((q) => q.close != null && q.date != null)
      .map((q) => ({
        date: new Date(q.date as Date).toISOString().slice(0, 10),
        close: Math.round((q.close as number) * 100) / 100,
      }));

    if (quotes.length === 0) {
      console.error(
        `[api/finance] No quote data returned for ticker "${ticker}" (timeframe=${timeframe}). Raw response:`,
        JSON.stringify({ quoteCount: rawQuotes.length, chartKeys: Object.keys(chart ?? {}) })
      );
      return NextResponse.json(
        {
          error: `No stock data available for ${ticker}`,
          ticker,
          quotes: [],
          stockKey: STOCK_KEY,
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ ticker, quotes, stockKey: STOCK_KEY });
  } catch (err) {
    console.error(`[api/finance] Fetch failed for ticker "${ticker}":`, err);
    const message =
      err instanceof Error ? err.message : "Failed to fetch stock data";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
