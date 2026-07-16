import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

import {
  parseSentimentResponse,
  type SpikeSentiment,
} from "@/lib/sentiment-parse";
import type { SpikeSentimentLabel } from "@/lib/event-study";

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

/**
 * Server-side spike catalyst sentiment (same contract as /api/sentiment).
 * Used by alpha-feed / company-brief without an HTTP round-trip.
 */
export async function analyzeSpikeSentimentServer(
  entityName: string,
  date: string
): Promise<{ sentiment: SpikeSentimentLabel; reason: string }> {
  const googleKey = process.env[GOOGLE_API_KEY_ENV];
  if (!googleKey) {
    return {
      sentiment: "NEUTRAL",
      reason: "Sentiment API is not configured.",
    };
  }

  const prompt = `You are a financial historian with live web search. On ${date}, Google search interest for the brand ${entityName} spiked massively.

Use Google Search to look up contemporary news, earnings, product launches, controversies, and cultural moments around that date (including 2025–2026 if relevant). Based on grounded evidence, was the primary catalyst for this spike POSITIVE (e.g., viral product, strong earnings, celebrity endorsement) or NEGATIVE (e.g., scandal, boycott, poor earnings, lawsuit)? If you are unsure after searching, default to NEUTRAL.

Respond with a strict JSON object only — no markdown fences, no extra prose:
{"sentiment":"POSITIVE"|"NEGATIVE"|"NEUTRAL","reason":"1-sentence explanation"}`;

  const google = createGoogleGenerativeAI({ apiKey: googleKey });

  for (const modelId of GOOGLE_MODEL_IDS) {
    try {
      const { text } = await generateText({
        model: google(modelId),
        tools: {
          google_search: google.tools.googleSearch({}),
        },
        prompt,
      });
      const parsed: SpikeSentiment = parseSentimentResponse(text ?? "");
      return {
        sentiment: parsed.sentiment,
        reason: parsed.reason,
      };
    } catch (error) {
      console.warn(`[sentiment-server] ${modelId} failed:`, error);
      if (!isModelNotFoundError(error)) break;
    }
  }

  return {
    sentiment: "NEUTRAL",
    reason: "Sentiment analysis unavailable, defaulting to neutral.",
  };
}
