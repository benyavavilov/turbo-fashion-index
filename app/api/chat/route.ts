import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

import type { ChartContext } from "@/lib/chart-context";

export const runtime = "nodejs";
export const maxDuration = 60;

function errorResponse(message: string, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildSystemPrompt(ctx: ChartContext | undefined): string {
  const contextJson = ctx
    ? JSON.stringify(ctx, null, 2)
    : "No live chart context available.";

  return `You are the TurboFashion Index AI Economic Analyst — a premium, institutional-grade research assistant embedded in a fashion search-interest terminal.

Your role:
- Interpret Google Trends search-interest indices (0–100) as proxies for consumer attention and demand.
- Relate brand vs. trend dynamics, substitution ratios, and optional equity overlays to macro consumer sentiment.
- Be concise, analytical, and data-grounded. Use precise language suitable for a financial terminal.

Current dashboard state (silent context — do not repeat verbatim unless relevant):
${contextJson}

When analyzing:
- Reference specific entities, timeframes, and recent data points from the context.
- Flag when search interest leads or lags plausible equity moves (Granger-style intuition, not formal causality claims unless data supports it).
- Distinguish brands from cultural trend entities.
- If ratio mode is active, interpret values above 1.0 as numerator outperformance vs denominator.

Keep responses under 250 words unless the user asks for depth.`;
}

export async function POST(req: Request) {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!googleKey && !openaiKey) {
    return errorResponse(
      "Set GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY in .env.local"
    );
  }

  let body: { messages?: UIMessage[]; chartContext?: ChartContext };
  try {
    body = await req.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(`Invalid request body: ${message}`, 400);
  }

  const messages = body.messages ?? [];
  const chartContext = body.chartContext;

  if (!Array.isArray(messages) || messages.length === 0) {
    return errorResponse("At least one message is required.", 400);
  }

  try {
    const model = googleKey
      ? google("gemini-2.0-flash")
      : openai("gpt-4o-mini");

    const modelMessages = await convertToModelMessages(messages);

    const result = streamText({
      model,
      system: buildSystemPrompt(chartContext),
      messages: modelMessages,
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    console.error("[api/chat]", err);
    const message =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    return errorResponse(message);
  }
}
