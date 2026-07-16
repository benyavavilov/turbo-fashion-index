import { NextResponse } from "next/server";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

import { getParentByTicker } from "@/lib/entities";
import {
  extractBrandSeries,
  sliceSeriesByDays,
} from "@/lib/screener";
import { fetchTrendHistory } from "@/lib/market-data";
import { cleanLlmJsonText } from "@/lib/sentiment-parse";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;

const BriefSchema = z.object({
  headline: z.string().min(1),
  sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL"]),
  bullets: z.array(z.string().min(1)).min(2).max(4),
});

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

export async function POST(req: Request) {
  try {
    const googleKey = process.env[GOOGLE_API_KEY_ENV];
    if (!googleKey) {
      return NextResponse.json(
        { error: `Set ${GOOGLE_API_KEY_ENV} in .env.local` },
        { status: 500 }
      );
    }

    let body: {
      ticker?: string;
      eventStudySummary?: string;
    };
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
      return NextResponse.json({ error: "Unknown parent ticker" }, { status: 404 });
    }

    const trendData = await fetchTrendHistory(parent.childBrands, 1);
    const brandMomentum = parent.childBrands.map((brand) => {
      const series = sliceSeriesByDays(extractBrandSeries(trendData, brand), 30);
      const first = series[0]?.value;
      const last = series[series.length - 1]?.value;
      const net =
        typeof first === "number" && typeof last === "number"
          ? Math.round((last - first) * 10) / 10
          : null;
      return {
        brand,
        netChange30d: net,
        latest: last ?? null,
        points: series.slice(-8).map((p) => ({ date: p.date, interest: p.value })),
      };
    });

    const prompt = `You are a fashion equity analyst with Google Search covering parent companies and child brands.

Parent: ${parent.name} (${parent.ticker})
Child brands: ${parent.childBrands.join(", ")}

Recent 30-day Google search momentum by child brand:
${JSON.stringify(brandMomentum, null, 2)}

${body.eventStudySummary ? `Event-study summary:\n${body.eventStudySummary}\n` : ""}

Assess catalyst sentiment for this parent based on child-brand search momentum and any grounded news. Be concise.

Respond with STRICT JSON only:
{"headline":"≤12 word headline","sentiment":"POSITIVE"|"NEGATIVE"|"NEUTRAL","bullets":["insight 1","insight 2","insight 3"]}`;

    const google = createGoogleGenerativeAI({ apiKey: googleKey });
    let raw = "";

    for (const modelId of GOOGLE_MODEL_IDS) {
      try {
        const { text } = await generateText({
          model: google(modelId),
          tools: {
            google_search: google.tools.googleSearch({}),
          },
          prompt,
        });
        raw = text ?? "";
        break;
      } catch (error) {
        console.warn(`[api/company-brief] ${modelId} failed:`, error);
        if (!isModelNotFoundError(error)) break;
      }
    }

    const cleaned = cleanLlmJsonText(raw);
    let data: z.infer<typeof BriefSchema> | null = null;

    try {
      const first = BriefSchema.safeParse(JSON.parse(cleaned));
      if (first.success) data = first.data;
      else {
        const repaired = BriefSchema.safeParse(
          JSON.parse(cleaned.replace(/,\s*}/g, "}"))
        );
        if (repaired.success) data = repaired.data;
      }
    } catch {
      data = null;
    }

    if (!data) {
      return NextResponse.json({
        headline: `${parent.name} momentum check`,
        sentiment: "NEUTRAL" as const,
        bullets: [
          "Gemini brief unavailable — try again shortly.",
          "Review child-brand toggles on the chart for live search interest.",
        ],
      });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[api/company-brief]", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
