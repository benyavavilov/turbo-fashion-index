import { NextResponse } from "next/server";

import { runFetchTrends } from "@/scripts/fetch-trends";
import { runGenerateInsights } from "@/scripts/generate-insights";

export const runtime = "nodejs";
/** Weekly ETL can run long (Trends jitter + Gemini). Requires Pro / Fluid. */
export const maxDuration = 800;
export const dynamic = "force-dynamic";

function authorizeCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

/**
 * Weekly autonomous ETL: Google Trends → V4 YoY insights (Gemini) → Supabase.
 * Secured via CRON_SECRET (Vercel Cron sends Authorization: Bearer <secret>).
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("[cron] Starting weekly ETL pipeline…");

    const trends = await runFetchTrends({ forceRefresh: true });
    console.log(
      `[cron] Trends done — ok=${trends.succeeded} fail=${trends.failed} rows=${trends.totalRows}`
    );

    const insights = await runGenerateInsights();
    console.log(
      `[cron] Insights done — parents=${insights.parents} geminiOk=${insights.ok}`
    );

    return NextResponse.json({
      success: true,
      message: "Pipeline updated successfully",
      trends,
      insights,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron] Pipeline failed:", error);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
