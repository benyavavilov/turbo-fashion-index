import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import YahooFinance from "yahoo-finance2";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const yahooFinance = new YahooFinance();
const YAHOO_PAUSE_MS = 250;

function authorizeCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function formatNextEarningsDate(raw: unknown): string | null {
  if (raw == null) return null;
  try {
    const d = new Date(raw as string | number | Date);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().split("T")[0];
  } catch {
    return null;
  }
}

/**
 * Daily lightweight cron: refresh next_earnings_date only.
 * Secured via CRON_SECRET (Vercel Cron sends Authorization: Bearer <secret>).
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getServiceSupabase();

    const { data: rows, error: selectError } = await supabase
      .from("ai_insights")
      .select("ticker");

    if (selectError) {
      throw new Error(selectError.message);
    }

    const tickers = [
      ...new Set(
        (rows ?? [])
          .map((r) => String(r.ticker ?? "").trim().toUpperCase())
          .filter(Boolean)
      ),
    ].sort();

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];
      try {
        const quoteSummary = (await yahooFinance.quoteSummary(ticker, {
          modules: ["calendarEvents"],
        })) as {
          calendarEvents?: {
            earnings?: {
              earningsDate?: Array<Date | number | string | null> | null;
            } | null;
          } | null;
        };

        const nextEarningsDate = formatNextEarningsDate(
          quoteSummary.calendarEvents?.earnings?.earningsDate?.[0]
        );

        if (!nextEarningsDate) {
          skipped += 1;
          console.log(`[cron-daily] ${ticker}: no calendar earnings date`);
        } else {
          const { error: updateError } = await supabase
            .from("ai_insights")
            .update({ next_earnings_date: nextEarningsDate })
            .eq("ticker", ticker);

          if (updateError) {
            failed += 1;
            console.warn(
              `[cron-daily] ${ticker}: update failed — ${updateError.message}`
            );
          } else {
            updated += 1;
            console.log(
              `[cron-daily] ${ticker}: next_earnings_date=${nextEarningsDate}`
            );
          }
        }
      } catch (error) {
        failed += 1;
        console.warn(
          `[cron-daily] ${ticker}: Yahoo fetch failed —`,
          error instanceof Error ? error.message : error
        );
      }

      if (i < tickers.length - 1) await sleep(YAHOO_PAUSE_MS);
    }

    return NextResponse.json({
      success: true,
      message: "Daily earnings dates updated",
      scanned: tickers.length,
      updated,
      skipped,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron-daily] failed:", error);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
