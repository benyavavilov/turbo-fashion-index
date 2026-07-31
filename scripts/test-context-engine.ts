/**
 * test-context-engine.ts
 *
 * Prototype "Contextual Intent Engine":
 *   1. Pull top rising related queries from Google Trends (google-trends-api)
 *   2. Ask Gemini (with Google Search grounding) whether the spike is a
 *      POSITIVE or NEGATIVE catalyst
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/test-context-engine.ts
 *   npx tsx --env-file=.env.local scripts/test-context-engine.ts "Abercrombie"
 *   npx tsx --env-file=.env.local scripts/test-context-engine.ts "Abercrombie" 30
 *
 * Args: [brand=Abercrombie] [lookbackDays=30]
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import googleTrends from "google-trends-api";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { cleanLlmJsonText } from "../lib/sentiment-parse";

const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;
const DEFAULT_BRAND = "Abercrombie";
const DEFAULT_LOOKBACK_DAYS = 30;
const TOP_RISING_COUNT = 5;
const TRENDS_MAX_ATTEMPTS = 3;
const TRENDS_COOLDOWN_MS = 20_000;

/** Strict JSON contract for the AI web-researcher verdict. */
export const CatalystVerdictSchema = z.object({
  verdict: z.enum(["POSITIVE", "NEGATIVE"]),
  analysis: z.string().min(1),
  catalyst_summary: z.string().min(1),
  confidence: z.number().min(1).max(10),
});

export type CatalystVerdict = z.infer<typeof CatalystVerdictSchema>;

export interface RisingQuery {
  query: string;
  /** Google Trends rising value (often "Breakout" or a % lift). */
  value: string | number;
}

interface RelatedQueriesPayload {
  default?: {
    rankedList?: Array<{
      rankedKeyword?: Array<{
        query?: string;
        value?: string | number;
        formattedValue?: string;
      }>;
    }>;
  };
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
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

function lookbackWindow(lookbackDays: number): { startTime: Date; endTime: Date } {
  const endTime = new Date();
  const startTime = new Date();
  startTime.setUTCDate(startTime.getUTCDate() - lookbackDays);
  return { startTime, endTime };
}

/**
 * Fetch Google Trends related queries for a brand over a timeframe and return
 * the top N "rising" queries (rankedList[1] in the Trends API payload).
 */
export async function fetchRisingRelatedQueries(
  brand: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
  topN: number = TOP_RISING_COUNT
): Promise<RisingQuery[]> {
  const { startTime, endTime } = lookbackWindow(lookbackDays);
  let lastError: unknown;

  for (let attempt = 1; attempt <= TRENDS_MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await googleTrends.relatedQueries({
        keyword: brand,
        startTime,
        endTime,
      });

      let payload: RelatedQueriesPayload;
      try {
        payload = JSON.parse(raw) as RelatedQueriesPayload;
      } catch {
        throw new Error(
          `Non-JSON response from Google Trends (CAPTCHA / rate-limit wall) for "${brand}".`
        );
      }

      // rankedList[0] = top queries, rankedList[1] = rising queries
      const risingList = payload.default?.rankedList?.[1]?.rankedKeyword ?? [];
      const rising = risingList
        .map((row) => {
          const query = row.query?.trim();
          if (!query) return null;
          return {
            query,
            value: row.formattedValue ?? row.value ?? "n/a",
          } satisfies RisingQuery;
        })
        .filter((row): row is RisingQuery => row != null)
        .slice(0, topN);

      if (rising.length === 0) {
        // Fall back to top queries if rising is empty for the window.
        const topList = payload.default?.rankedList?.[0]?.rankedKeyword ?? [];
        return topList
          .map((row) => {
            const query = row.query?.trim();
            if (!query) return null;
            return {
              query,
              value: row.formattedValue ?? row.value ?? "n/a",
            } satisfies RisingQuery;
          })
          .filter((row): row is RisingQuery => row != null)
          .slice(0, topN);
      }

      return rising;
    } catch (error) {
      lastError = error;
      console.warn(
        `[trends] relatedQueries attempt ${attempt}/${TRENDS_MAX_ATTEMPTS} failed:`,
        error instanceof Error ? error.message : error
      );
      if (attempt < TRENDS_MAX_ATTEMPTS) {
        await sleep(TRENDS_COOLDOWN_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch related queries for "${brand}".`);
}

function buildResearchPrompt(brand: string, risingQueries: RisingQuery[]): string {
  const queryList =
    risingQueries.length > 0
      ? risingQueries.map((q, i) => `${i + 1}. "${q.query}" (${q.value})`).join("\n")
      : "(none found — research the brand spike generally)";

  return `The search volume for ${brand} recently spiked. The top related rising queries driving this spike are:
${queryList}

Use your Google Search tool to find recent news about these specific queries. Determine if this search spike represents a POSITIVE catalyst (buying intent, strong product launch) or a NEGATIVE catalyst (scandal, boycott, bankruptcy). Return a strict verdict.

Return STRICT JSON only with these keys:
- "verdict": "POSITIVE" or "NEGATIVE"
- "analysis": 2-4 sentences explaining what you found via search and why it drives the spike
- "catalyst_summary": one short phrase naming the dominant catalyst
- "confidence": integer 1-10 for how sure you are the spike is driven by that catalyst`;
}

/**
 * Gemini web-researcher with native Google Search grounding.
 */
export async function analyzeSpikeWithGemini(
  brand: string,
  risingQueries: RisingQuery[]
): Promise<CatalystVerdict> {
  const apiKey = process.env[GOOGLE_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `Missing ${GOOGLE_API_KEY_ENV}. Set it in .env.local to run the context engine.`
    );
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const prompt = buildResearchPrompt(brand, risingQueries);

  for (const modelId of GOOGLE_MODEL_IDS) {
    try {
      try {
        const { object } = await generateObject({
          model: google(modelId),
          schema: CatalystVerdictSchema,
          tools: {
            google_search: google.tools.googleSearch({}),
          },
          prompt,
        });
        return object;
      } catch (objectError) {
        console.warn(
          `[gemini] generateObject ${modelId} failed, trying generateText:`,
          objectError instanceof Error ? objectError.message : objectError
        );
      }

      const { text } = await generateText({
        model: google(modelId),
        tools: {
          google_search: google.tools.googleSearch({}),
        },
        prompt,
      });

      const parsed = CatalystVerdictSchema.safeParse(
        JSON.parse(cleanLlmJsonText(text ?? ""))
      );
      if (parsed.success) return parsed.data;

      console.warn(`[gemini] Zod parse failed for ${modelId}:`, text);
    } catch (error) {
      console.warn(
        `[gemini] ${modelId} failed:`,
        error instanceof Error ? error.message : error
      );
      if (!isModelNotFoundError(error)) continue;
    }
  }

  throw new Error("All Gemini models failed for contextual catalyst analysis.");
}

export async function runContextEngine(
  brand: string = DEFAULT_BRAND,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS
): Promise<void> {
  const { startTime, endTime } = lookbackWindow(lookbackDays);

  console.log("=== Contextual Intent Engine ===");
  console.log(`Brand     : ${brand}`);
  console.log(
    `Window    : ${startTime.toISOString().slice(0, 10)} → ${endTime.toISOString().slice(0, 10)} (last ${lookbackDays} days)\n`
  );

  console.log("1) Fetching Google Trends rising related queries…");
  const rising = await fetchRisingRelatedQueries(brand, lookbackDays);

  console.log("\nRelated rising queries:");
  if (rising.length === 0) {
    console.log("  (none returned)");
  } else {
    for (const [i, row] of rising.entries()) {
      console.log(`  ${i + 1}. ${row.query}  [${row.value}]`);
    }
  }

  console.log("\n2) Asking Gemini (Google Search grounding)…\n");
  const verdict = await analyzeSpikeWithGemini(brand, rising);

  console.log("Gemini contextual analysis:");
  console.log(`  Verdict           : ${verdict.verdict}`);
  console.log(`  Catalyst summary  : ${verdict.catalyst_summary}`);
  console.log(`  Confidence        : ${verdict.confidence}/10`);
  console.log(`  Analysis          : ${verdict.analysis}`);
  console.log("\nRaw JSON:");
  console.log(JSON.stringify(verdict, null, 2));
}

function parseCliArgs(): { brand: string; lookbackDays: number } {
  const brand = process.argv[2]?.trim() || DEFAULT_BRAND;
  const rawDays = process.argv[3]?.trim();
  const lookbackDays = rawDays
    ? Number.parseInt(rawDays, 10)
    : DEFAULT_LOOKBACK_DAYS;

  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    throw new Error(
      `Invalid lookback days "${rawDays}". Pass a positive integer (e.g. 30).`
    );
  }

  return { brand, lookbackDays };
}

function isExecutedDirectly(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === metaUrl;
  } catch {
    return entry.replace(/\\/g, "/").includes("/scripts/test-context-engine");
  }
}

if (isExecutedDirectly(import.meta.url)) {
  const { brand, lookbackDays } = parseCliArgs();
  runContextEngine(brand, lookbackDays)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\nFatal error in context engine:", err);
      process.exit(1);
    });
}
