import { NextResponse } from "next/server";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

import {
  parseSentimentResponse,
  SENTIMENT_PARSE_FALLBACK,
  type SpikeSentiment,
} from "@/lib/sentiment-parse";

export const runtime = "nodejs";
export const maxDuration = 30;

/** @ai-sdk/google reads GOOGLE_GENERATIVE_AI_API_KEY (not GEMINI_API_KEY). */
const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;

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
      console.error(`[api/sentiment] Missing ${GOOGLE_API_KEY_ENV}`);
      return NextResponse.json({
        sentiment: "NEUTRAL",
        reason: "Sentiment API is not configured.",
      } satisfies SpikeSentiment);
    }

    let body: { entityName?: string; date?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const entityName = body.entityName?.trim();
    const date = body.date?.trim();

    if (!entityName || !date) {
      return NextResponse.json(
        { error: "entityName and date are required" },
        { status: 400 }
      );
    }

    const prompt = `You are a financial historian with live web search. On ${date}, Google search interest for the brand ${entityName} spiked massively.

Use Google Search to look up contemporary news, earnings, product launches, controversies, and cultural moments around that date (including 2025–2026 if relevant). Based on grounded evidence, was the primary catalyst for this spike POSITIVE (e.g., viral product, strong earnings, celebrity endorsement) or NEGATIVE (e.g., scandal, boycott, poor earnings, lawsuit)? If you are unsure after searching, default to NEUTRAL.

Respond with a strict JSON object only — no markdown fences, no extra prose:
{"sentiment":"POSITIVE"|"NEGATIVE"|"NEUTRAL","reason":"1-sentence explanation"}`;

    const google = createGoogleGenerativeAI({ apiKey: googleKey });
    let lastError: unknown;

    for (const modelId of GOOGLE_MODEL_IDS) {
      try {
        const { text } = await generateText({
          model: google(modelId),
          tools: {
            google_search: google.tools.googleSearch({}),
          },
          prompt,
        });

        return NextResponse.json(parseSentimentResponse(text ?? ""));
      } catch (error) {
        lastError = error;
        console.warn(`[api/sentiment] Model ${modelId} failed:`, error);
        if (!isModelNotFoundError(error)) break;
      }
    }

    console.error(
      "[api/sentiment] All models failed; returning NEUTRAL fallback.",
      lastError
    );
    return NextResponse.json({
      sentiment: "NEUTRAL",
      reason: "Sentiment analysis unavailable, defaulting to neutral.",
    } satisfies SpikeSentiment);
  } catch (error) {
    console.error("[api/sentiment] Unhandled error:", error);
    return NextResponse.json(SENTIMENT_PARSE_FALLBACK);
  }
}
