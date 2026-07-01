/**
 * Database-driven brand enrichment.
 *
 * Pipeline:
 *   1. Read every existing row from `tracked_brands` (name, homepage, slug).
 *   2. For each brand, verify the homepage resolves and enrich via Gemini.
 *   3. Upsert the enriched rows back into `tracked_brands`, deduping on `slug`.
 *
 * There are no hardcoded brand names in this file — the input set comes
 * entirely from the database.
 *
 * Run:  npm run scrape
 */

import { GoogleGenAI } from "@google/genai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BRANDS_TABLE = "tracked_brands";

interface ExistingBrand {
  name: string;
  homepage: string | null;
  slug: string | null;
}

interface ScrapedBrand {
  name: string;
  slug: string;
  homepage: string | null;
  ai_trend_score: number;
  hype_score: number;
  summary: string;
}

function loadLocalEnv(): void {
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const raw = readFileSync(envPath, "utf8");

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^export\s+/, "");
      if (!line || line.startsWith("#")) {
        continue;
      }

      const eq = line.indexOf("=");
      if (eq === -1) {
        continue;
      }

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();

      // Strip a single layer of matching surrounding quotes, if present.
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env.local present — rely on the ambient environment instead.
  }
}

// Load .env.local immediately, before any function reads process.env.
loadLocalEnv();

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function brandToSlug(value: string): string {
  return normalizeString(value)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function fetchHomepageHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "turbo-fashion-index-bot/0.1 (+https://github.com/turbo-fashion-index)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      console.warn(`  homepage fetch failed (${response.status}) for ${url}`);
      return null;
    }

    return await response.text();
  } catch (error) {
    console.warn(`  homepage fetch error for ${url}:`, error);
    return null;
  }
}

interface GeminiBrandData {
  ai_trend_score: number;
  summary: string;
}

function clampTrendScore(value: unknown): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    return 50;
  }
  return Math.min(100, Math.max(1, Math.round(num)));
}

/**
 * Uses Gemini to estimate a brand's cultural hype score and a one-line style
 * summary. Returns neutral fallbacks if the key is missing or the call fails.
 */
export async function generateGeminiBrandData(
  brandName: string,
): Promise<GeminiBrandData> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("  gemini skipped: GEMINI_API_KEY is not set.");
    return { ai_trend_score: 50, summary: "Description unavailable." };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = [
      "You are an expert fashion and streetwear industry analyst.",
      `Analyze the brand named "${brandName}".`,
      "Return a JSON object with exactly two keys:",
      '- "ai_trend_score": an integer between 1 and 100 representing the',
      "  brand's current cultural hype, relevance, and market presence.",
      '- "summary": a single, highly descriptive, punchy sentence capturing',
      "  the brand's unique style identity and aesthetic.",
    ].join("\n");

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });

    const text = response.text;
    if (!text) {
      throw new Error("Empty response from Gemini.");
    }

    const parsed = JSON.parse(text) as {
      ai_trend_score?: unknown;
      summary?: unknown;
    };

    return {
      ai_trend_score: clampTrendScore(parsed.ai_trend_score),
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : "Description currently unavailable.",
    };
  } catch (error) {
    console.error(`  gemini failed for "${brandName}":`, error);
    return { ai_trend_score: 50, summary: "Description currently unavailable." };
  }
}

async function enrichBrand(row: ExistingBrand): Promise<ScrapedBrand> {
  const name = row.name.trim();
  const slug = row.slug?.trim() || brandToSlug(name);
  const homepage = row.homepage?.trim() || null;

  console.log(`• ${name}${homepage ? ` → ${homepage}` : ""}`);

  let reachableHomepage: string | null = null;
  if (homepage) {
    const html = await fetchHomepageHtml(homepage);
    console.log(html ? "  homepage: ok" : "  homepage: unreachable");
    reachableHomepage = html ? homepage : null;
  }

  const { ai_trend_score, summary } = await generateGeminiBrandData(name);
  console.log(`  ai_trend_score: ${ai_trend_score}`);
  console.log(`  summary: ${summary}`);

  return {
    name,
    slug,
    homepage: reachableHomepage,
    ai_trend_score,
    hype_score: 0,
    summary,
  };
}

function getWritableClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  // Prefer a service-role key for server-side writes; fall back to the anon key
  // (which only works if RLS policies permit inserts/updates on tracked_brands).
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

async function fetchExistingBrands(
  client: SupabaseClient,
): Promise<ExistingBrand[]> {
  const { data, error } = await client
    .from(BRANDS_TABLE)
    .select("name, homepage, slug");

  if (error) {
    console.error("Supabase read error:", error);
    return [];
  }

  return (data ?? [])
    .map((row) => ({
      name: typeof row.name === "string" ? row.name : "",
      homepage: typeof row.homepage === "string" ? row.homepage : null,
      slug: typeof row.slug === "string" ? row.slug : null,
    }))
    .filter((row) => row.name.trim().length > 0);
}

async function upsertBrands(
  client: SupabaseClient,
  brands: ScrapedBrand[],
): Promise<void> {
  if (brands.length === 0) {
    return;
  }

  const { error } = await client
    .from(BRANDS_TABLE)
    .upsert(brands, { onConflict: "slug" });

  if (error) {
    console.error("Supabase upsert error:", error);
    return;
  }

  console.log(`\nUpserted ${brands.length} brand(s) into ${BRANDS_TABLE}.`);
}

export async function run(): Promise<ScrapedBrand[]> {
  const client = getWritableClient();
  if (!client) {
    console.error(
      "Aborting: NEXT_PUBLIC_SUPABASE_URL and a Supabase key are required.",
    );
    return [];
  }

  const existing = await fetchExistingBrands(client);
  if (existing.length === 0) {
    console.warn(`No brands found in ${BRANDS_TABLE}; nothing to enrich.`);
    return [];
  }

  console.log(`Enriching ${existing.length} brand(s) from ${BRANDS_TABLE}…\n`);

  const results: ScrapedBrand[] = [];
  for (const row of existing) {
    results.push(await enrichBrand(row));
  }

  await upsertBrands(client, results);
  return results;
}

const isDirectRun = process.argv[1]?.includes("scrape-brands");
if (isDirectRun) {
  run()
    .then((results) => {
      console.log("\nDone:", JSON.stringify(results, null, 2));
    })
    .catch((error) => {
      console.error("Scraper failed:", error);
      process.exitCode = 1;
    });
}
