import { NextResponse } from "next/server";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

import type { ChartContext, Timeframe } from "@/lib/chart-context";
import { getBrandTicker } from "@/lib/brand-assets";

export const runtime = "nodejs";
export const maxDuration = 60;

/** @ai-sdk/google reads GOOGLE_GENERATIVE_AI_API_KEY (not GEMINI_API_KEY). */
const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";

const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;

const MASTER_SYSTEM_PROMPT = `You are the **TurboFashion Index Lead Analyst** — the senior research voice embedded in a live fashion search-interest terminal.

## Identity & tone
- Sound like a senior portfolio manager mentoring a top-tier analyst: conversational, highly competent, sharp, and empathetic.
- Avoid robotic phrasing, filler, and generic disclaimers unless risk truly warrants them.
- Use **markdown** for scannability: short headers, bullets, and **bold** for key metrics and takeaways.
- Be direct. Lead with the insight, then support it with evidence from the dashboard context.

## What you analyze
- **Google Trends search interest** (0–100 index) as a proxy for cultural attention and consumer demand.
- **Yahoo Finance equity overlays** (when active) as financial reality checks against search momentum.
- **Substitution ratios** (numerator ÷ denominator) when ratio mode is on — values above 1.0 mean numerator outperformance.
- **90-day SMA lines** when enabled — use them to separate signal from noise.

## How you reason
- Draw explicit correlations between cultural search trends and plausible equity moves.
- Distinguish **brands** from **cultural trend entities** — they behave differently.
- Reference specific entities, dates, and numbers from the context payload; cite peaks, troughs, and inflection points across the **full** visible history.
- Flag when search interest appears to **lead or lag** stock price moves (intuition only — not formal causality unless the data is overwhelming).
- Maintain perfect **multi-turn memory**: treat the conversation history as continuous context; reference prior user questions naturally.

## Constraints
- Do not dump the raw JSON context back at the user unless they ask for data export.
- If context is missing or sparse, say so plainly and ask one focused clarifying question.`;

function formatStreamError(error: unknown): string {
  if (error == null) return "Unknown AI stream error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

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

function formatTimeframeLabel(timeframe: Timeframe): string {
  if (timeframe === "6M") return "6 Months (6M)";
  if (timeframe === "1Y") return "1 Year (1Y)";
  return "5 Years (5Y)";
}

function buildContextPayload(ctx: ChartContext): string {
  const entityList = ctx.ratioMode
    ? [ctx.numerator, ctx.denominator].filter(Boolean).join(", ")
    : ctx.selectedEntities.join(", ") || "none";

  const lines: string[] = [
    "## Dashboard cheat sheet (silent context — do not repeat verbatim)",
    "",
    `Currently analyzing the following entities: ${entityList}.`,
    `The current timeframe is ${formatTimeframeLabel(ctx.timeframe)}.`,
    `Data source: ${ctx.isLive ? "live Supabase feed" : "sample/demo data"}.`,
    `Total observations in view: ${ctx.observationCount}.`,
  ];

  if (ctx.ratioMode && ctx.numerator && ctx.denominator) {
    lines.push(
      `Ratio mode: **ON** — tracking ${ctx.numerator} ÷ ${ctx.denominator}.`
    );
  } else {
    lines.push("Ratio mode: off.");
  }

  if (ctx.smaEntities?.length) {
    lines.push(
      `90-day SMA enabled for: ${ctx.smaEntities.join(", ")}.`
    );
  }

  if (ctx.stockEntities?.length) {
    const tickers = ctx.stockEntities
      .map((name) => {
        const ticker = getBrandTicker(name);
        return ticker ? `${name} (${ticker})` : name;
      })
      .join(", ");
    lines.push(`Stock overlays active for: ${tickers}.`);
  } else {
    lines.push("Stock overlays: none.");
  }

  lines.push(
    "",
    "## Full visible chart dataset",
    "Each row is one date. Keys are entity names, optional `__sma` / `__stock` suffixes for overlays.",
    "",
    JSON.stringify(ctx.visibleChartData, null, 2)
  );

  return lines.join("\n");
}

function buildSystemPrompt(ctx: ChartContext | undefined): string {
  if (!ctx) {
    return `${MASTER_SYSTEM_PROMPT}

---
No live chart context is available. Ask the user what they are viewing on the terminal.`;
  }

  return `${MASTER_SYSTEM_PROMPT}

---
${buildContextPayload(ctx)}`;
}

export async function POST(req: Request) {
  try {
    const googleKey = process.env[GOOGLE_API_KEY_ENV];
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!googleKey && !openaiKey) {
      return NextResponse.json(
        { error: `Set ${GOOGLE_API_KEY_ENV} or OPENAI_API_KEY in .env.local` },
        { status: 500 }
      );
    }

    let body: { messages?: UIMessage[]; chartContext?: ChartContext };
    try {
      body = await req.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        { error: `Invalid request body: ${message}` },
        { status: 400 }
      );
    }

    const messages = body.messages ?? [];
    const chartContext = body.chartContext;

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "At least one message is required." },
        { status: 400 }
      );
    }

    // Full conversation history from the client — powers multi-turn follow-ups.
    const modelMessages = await convertToModelMessages(messages);
    const system = buildSystemPrompt(chartContext);

    let result;

    if (googleKey) {
      const google = createGoogleGenerativeAI({ apiKey: googleKey });
      let lastError: unknown;

      for (const modelId of GOOGLE_MODEL_IDS) {
        try {
          result = streamText({
            model: google(modelId),
            system,
            messages: modelMessages,
          });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          console.warn(`[api/chat] Model ${modelId} unavailable:`, error);
          if (!isModelNotFoundError(error)) throw error;
        }
      }

      if (!result) {
        throw lastError ?? new Error("No Google model available");
      }
    } else {
      result = streamText({
        model: openai("gpt-4o-mini"),
        system,
        messages: modelMessages,
      });
    }

    return result.toUIMessageStreamResponse({
      onError: (error) => {
        console.error("🔥 AI STREAM ERROR:", error);
        return formatStreamError(error);
      },
    });
  } catch (error) {
    console.error("🔥 AI ROUTE CRASH:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
