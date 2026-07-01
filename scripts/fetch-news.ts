/**
 * Source-driven, AI-curated notification engine.
 *
 * Flow:
 *   1. Connect to Supabase + Gemini via environment variables.
 *   2. Read tracked_brands (name, slug, feed_url); skip brands without a feed.
 *   3. Parse each brand's first-party feed (Shopify .atom etc.) with rss-parser.
 *   4. Keep items from the last 48h; fall back to the 3 most recent otherwise.
 *   5. Ask Gemini to dedupe + classify the items into notification events.
 *   6. Upsert the results into brand_news, keyed on the unique `url`.
 *
 * Run:  npx tsx scripts/fetch-news.ts
 */

import { GoogleGenAI } from "@google/genai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Parser from "rss-parser";

const BRANDS_TABLE = "tracked_brands";
const NEWS_TABLE = "brand_news";
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
const FALLBACK_ITEM_COUNT = 3;
const MAX_ITEMS_PER_BRAND = 20;

const VALID_CATEGORIES = [
  "New Product Drops & Collections",
  "Restock Alerts",
  "Deals & Promos",
  "General",
] as const;

type Category = (typeof VALID_CATEGORIES)[number];

interface BrandRow {
  name: string;
  slug: string;
  feed_url: string;
}

type FeedItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  "content:encoded"?: string;
  enclosure?: { url?: string };
  "media:content"?: { $?: { url?: string } };
  "media:thumbnail"?: { $?: { url?: string } };
};

interface NormalizedItem {
  title: string;
  url: string;
  image_url: string;
  published_at: string;
  content: string;
}

interface NotificationEvent {
  category: Category;
  notification_banner: string;
  url: string;
  image_url: string;
  title: string;
  published_at: string;
  source?: string;
}

interface NewsRow {
  brand_slug: string;
  category: Category;
  notification_banner: string;
  url: string;
  image_url: string;
  title: string;
  published_at: string;
  source: string;
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

// Load .env.local before any function reads process.env.
loadLocalEnv();

function getWritableClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchActiveBrands(client: SupabaseClient): Promise<BrandRow[]> {
  const { data, error } = await client
    .from(BRANDS_TABLE)
    .select("name, slug, feed_url");

  if (error) {
    console.error("Supabase read error:", error);
    return [];
  }

  const brands: BrandRow[] = [];
  for (const row of data ?? []) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";
    const feedUrl = typeof row.feed_url === "string" ? row.feed_url.trim() : "";

    if (!name || !slug) {
      continue;
    }

    if (!feedUrl) {
      console.log(`Skipping ${name} - No feed URL assigned`);
      continue;
    }

    brands.push({ name, slug, feed_url: feedUrl });
  }

  return brands;
}

function itemDate(item: NormalizedItem): number {
  const time = new Date(item.published_at).getTime();
  return Number.isFinite(time) ? time : 0;
}

function extractImageUrl(item: FeedItem): string {
  if (item.enclosure?.url) {
    return item.enclosure.url;
  }
  if (item["media:content"]?.$?.url) {
    return item["media:content"].$.url;
  }
  if (item["media:thumbnail"]?.$?.url) {
    return item["media:thumbnail"].$.url;
  }

  const html = item["content:encoded"] ?? item.content ?? "";
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1] ?? "";
}

function normalizeItem(item: FeedItem): NormalizedItem | null {
  const url = item.link?.trim();
  if (!url) {
    return null;
  }

  const published = item.isoDate ?? item.pubDate;
  const publishedAt = published
    ? new Date(published).toISOString()
    : new Date(0).toISOString();

  return {
    title: item.title?.trim() ?? "Untitled",
    url,
    image_url: extractImageUrl(item),
    published_at: publishedAt,
    content: (item.content ?? "").trim(),
  };
}

function selectRelevantItems(items: NormalizedItem[]): NormalizedItem[] {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = items.filter((item) => itemDate(item) >= cutoff);

  if (recent.length > 0) {
    return recent
      .sort((a, b) => itemDate(b) - itemDate(a))
      .slice(0, MAX_ITEMS_PER_BRAND);
  }

  return [...items]
    .sort((a, b) => itemDate(b) - itemDate(a))
    .slice(0, FALLBACK_ITEM_COUNT);
}

function toCategory(value: unknown): Category {
  return VALID_CATEGORIES.includes(value as Category)
    ? (value as Category)
    : "General";
}

function buildPrompt(brandName: string, items: NormalizedItem[]): string {
  const payload = items.map((item) => ({
    title: item.title,
    url: item.url,
    image_url: item.image_url,
    published_at: item.published_at,
    content: item.content.slice(0, 500),
  }));

  return [
    "You are an expert fashion e-commerce editor.",
    `Review these recent catalog/store updates for ${brandName}.`,
    "IGNORE administrative or backend store products entirely — do NOT create",
    "notifications for items such as 'Package Protection', 'Shipping', 'Navidium',",
    "shipping insurance, tips, donations, gift cards, or any similar non-merchandise",
    "checkout add-ons. Only surface genuine product, collection, or promotional news.",
    "Deduplicate them if multiple items are part of the exact same collection drop or event.",
    "Return a JSON array of unique notification events. Each object must strictly contain:",
    "* 'category': string, must be exactly 'New Product Drops & Collections', 'Restock Alerts', 'Deals & Promos', or 'General'.",
    "* 'notification_banner': string, a sharp, 1-sentence alert detailing the event for a mobile push style notification.",
    "* 'url': string, the direct link to the product or page.",
    "* 'image_url': string, the best image link extracted from the feed item data.",
    "* 'title': string, the original title.",
    "* 'published_at': string, the ISO timestamp of the event.",
    "",
    "Feed items:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function parseEvents(text: string): NotificationEvent[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  const array = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { events?: unknown[] })?.events)
      ? (parsed as { events: unknown[] }).events
      : [];

  const events: NotificationEvent[] = [];
  for (const entry of array) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url) {
      continue;
    }

    events.push({
      category: toCategory(record.category),
      notification_banner:
        typeof record.notification_banner === "string"
          ? record.notification_banner.trim()
          : "",
      url,
      image_url: typeof record.image_url === "string" ? record.image_url : "",
      title: typeof record.title === "string" ? record.title : "",
      published_at:
        typeof record.published_at === "string" && record.published_at
          ? record.published_at
          : new Date().toISOString(),
      source:
        typeof record.source === "string" && record.source.trim()
          ? record.source.trim()
          : undefined,
    });
  }

  return events;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isTransientError(error: unknown): boolean {
  const status = (error as { status?: number; code?: number })?.status;
  const code = (error as { status?: number; code?: number })?.code;
  if (status === 503 || status === 429 || code === 503 || code === 429) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\b(503|429)\b|unavailable|overloaded|rate.?limit|timeout|temporarily/i.test(
    message,
  );
}

async function synthesizeEvents(
  ai: GoogleGenAI,
  brandName: string,
  items: NormalizedItem[],
): Promise<NotificationEvent[]> {
  const prompt = buildPrompt(brandName, items);
  const maxAttempts = 3;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" },
      });

      const text = response.text;
      if (!text) {
        return [];
      }

      return parseEvents(text);
    } catch (error) {
      const canRetry = attempt < maxAttempts && isTransientError(error);
      if (!canRetry) {
        console.error(
          `  gemini failed for "${brandName}" after ${attempt} attempt(s):`,
          error,
        );
        return [];
      }

      console.warn(
        `  gemini transient error for "${brandName}" (attempt ${attempt}/${maxAttempts}); retrying in ${retryDelayMs}ms…`,
      );
      await sleep(retryDelayMs);
    }
  }

  return [];
}

async function upsertNews(
  client: SupabaseClient,
  rows: NewsRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const { error } = await client
    .from(NEWS_TABLE)
    .upsert(rows, { onConflict: "url" });

  if (error) {
    console.error("Supabase upsert error:", error);
  }
}

export async function run(): Promise<void> {
  const client = getWritableClient();
  if (!client) {
    console.error(
      "Aborting: NEXT_PUBLIC_SUPABASE_URL and a Supabase key are required.",
    );
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.error("Aborting: GEMINI_API_KEY is not set.");
    return;
  }

  const ai = new GoogleGenAI({ apiKey });

  const parser = new Parser<Record<string, never>, FeedItem>({
    customFields: {
      item: [
        ["media:content", "media:content"],
        ["media:thumbnail", "media:thumbnail"],
        ["content:encoded", "content:encoded"],
      ],
    },
  });

  const brands = await fetchActiveBrands(client);
  console.log(`Found ${brands.length} brand(s) with feeds.\n`);

  for (const brand of brands) {
    try {
      const feed = await parser.parseURL(brand.feed_url);
      const normalized = feed.items
        .map(normalizeItem)
        .filter((item): item is NormalizedItem => item !== null);

      const relevant = selectRelevantItems(normalized);
      console.log(`Processing ${brand.name} - Found ${relevant.length} items`);

      if (relevant.length === 0) {
        continue;
      }

      // Map the image extracted from each feed item's HTML by URL, so we save
      // the real feed image (falling back to whatever the model returned).
      const imageByUrl = new Map<string, string>();
      for (const item of relevant) {
        if (item.image_url) {
          imageByUrl.set(item.url, item.image_url);
        }
      }

      const events = await synthesizeEvents(ai, brand.name, relevant);
      const rows: NewsRow[] = events.map((event) => ({
        brand_slug: brand.slug,
        category: event.category,
        notification_banner: event.notification_banner,
        url: event.url,
        image_url: imageByUrl.get(event.url) || event.image_url || "",
        title: event.title,
        published_at: event.published_at,
        source: event.source || brand.name || "Official Store Feed",
      }));

      await upsertNews(client, rows);
      console.log(
        `Successfully synced ${rows.length} notifications for ${brand.name}`,
      );
    } catch (error) {
      console.warn(`Feed error for ${brand.name} - skipping:`, error);
    }
  }
}

const isDirectRun = process.argv[1]?.includes("fetch-news");
if (isDirectRun) {
  run()
    .then(() => console.log("\nDone."))
    .catch((error) => {
      console.error("News fetch failed:", error);
      process.exitCode = 1;
    });
}
