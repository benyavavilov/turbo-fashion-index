import { z } from "zod";

export const SentimentSchema = z.object({
  sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL"]),
  reason: z.string().min(1),
});

export type SpikeSentiment = z.infer<typeof SentimentSchema>;

export const SENTIMENT_PARSE_FALLBACK: SpikeSentiment = {
  sentiment: "NEUTRAL",
  reason: "Data parsing failed, defaulting to neutral.",
};

/** Concise trading-desk briefing for strategy cards. */
export const StrategyAdviceSchema = z.object({
  verdict: z.string().min(1).max(40),
  bullets: z.tuple([z.string().min(1), z.string().min(1)]),
  sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL"]).optional(),
});

export type StrategyAdvice = z.infer<typeof StrategyAdviceSchema>;

export const STRATEGY_ADVICE_FALLBACK: StrategyAdvice = {
  verdict: "WATCH",
  bullets: [
    "Catalyst data incomplete for this scan.",
    "Risk: AI commentary unavailable — re-run market scan.",
  ],
  sentiment: "NEUTRAL",
};

export const PortfolioAdviceItemSchema = z.object({
  ticker: z.string().min(1),
  verdict: z.enum(["HOLD", "TAKE PROFITS", "SELL/CUT LOSSES"]),
  rationale: z.string().min(1),
});

export const PortfolioAdviceResponseSchema = z.object({
  advice: z.array(PortfolioAdviceItemSchema),
});

export type PortfolioAdviceItem = z.infer<typeof PortfolioAdviceItemSchema>;

/** Strip markdown fences / backticks and isolate the first JSON object. */
export function cleanLlmJsonText(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  cleaned = cleaned.replace(/`+/g, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];
  return cleaned.trim();
}

function softRepairJson(candidate: string): string {
  return candidate
    .replace(/,\s*}/g, "}")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function tryParseWithSchema<T>(
  candidate: string,
  schema: z.ZodType<T>
): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : null;
  } catch {
    try {
      const repaired = schema.safeParse(JSON.parse(softRepairJson(candidate)));
      return repaired.success ? repaired.data : null;
    } catch {
      return null;
    }
  }
}

/** Never throws — returns NEUTRAL fallback and logs raw text on failure. */
export function parseSentimentResponse(rawText: string): SpikeSentiment {
  const cleaned = cleanLlmJsonText(rawText);
  const parsed = tryParseWithSchema(cleaned, SentimentSchema);
  if (parsed) return parsed;

  console.error("[sentiment] JSON parse failed. Raw LLM text:", rawText);
  console.error("[sentiment] Cleaned candidate:", cleaned);
  return SENTIMENT_PARSE_FALLBACK;
}

export function parseStrategyAdvice(rawText: string): StrategyAdvice {
  const cleaned = cleanLlmJsonText(rawText);
  const parsed = tryParseWithSchema(cleaned, StrategyAdviceSchema);
  if (parsed) {
    return {
      ...parsed,
      verdict: parsed.verdict.trim().toUpperCase().slice(0, 24),
      bullets: [
        parsed.bullets[0].trim().slice(0, 140),
        parsed.bullets[1].trim().slice(0, 140),
      ],
    };
  }

  console.error("[strategy-advice] JSON parse failed. Raw:", rawText);
  return STRATEGY_ADVICE_FALLBACK;
}

export function parsePortfolioAdvice(rawText: string): PortfolioAdviceItem[] {
  const cleaned = cleanLlmJsonText(rawText);
  const parsed = tryParseWithSchema(cleaned, PortfolioAdviceResponseSchema);
  if (parsed) return parsed.advice;

  try {
    const asArray = z
      .array(PortfolioAdviceItemSchema)
      .safeParse(JSON.parse(cleaned));
    if (asArray.success) return asArray.data;
  } catch {
    /* fall through */
  }

  console.error("[portfolio-advice] JSON parse failed. Raw:", rawText);
  return [];
}
