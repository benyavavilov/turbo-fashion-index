import { getSupabase, getSupabasePublicEnv } from "@/app/lib/supabase";

export interface BrandRecord {
  id: string;
  name: string;
  slug: string;
  ai_trend_score: number;
}

export interface BrandDetail {
  id: string;
  name: string;
  slug: string;
  summary: string;
  ai_trend_score: number;
  homepage: string | null;
}

const BRANDS_TABLE = "tracked_brands";

function toScore(value: unknown): number {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : 0;
}

export function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

export function brandToSlug(value: string): string {
  return normalizeString(value).replace(/\s+/g, "-");
}

export function splitWordTokens(value: string): string[] {
  return normalizeString(value).split(/\s+/).filter(Boolean);
}

export function matchesWordBoundaryPrefix(label: string, query: string): boolean {
  const normalizedQuery = normalizeString(query);
  if (!normalizedQuery) {
    return false;
  }

  return splitWordTokens(label).some((word) => word.startsWith(normalizedQuery));
}

export function filterByWordBoundaryPrefix(
  items: BrandRecord[],
  query: string,
): BrandRecord[] {
  const normalizedQuery = normalizeString(query);
  if (!normalizedQuery) {
    return [];
  }

  return items
    .filter((item) => matchesWordBoundaryPrefix(item.name, normalizedQuery))
    .sort(
      (a, b) =>
        b.ai_trend_score - a.ai_trend_score || a.name.localeCompare(b.name),
    );
}

export async function fetchBrandsFromDatabase(): Promise<BrandRecord[]> {
  try {
    const config = getSupabasePublicEnv();
    if (!config) {
      return [];
    }

    const client = getSupabase();
    if (!client) {
      return [];
    }

    const { data, error } = await client
      .from(BRANDS_TABLE)
      .select("id, name, slug, ai_trend_score")
      .order("ai_trend_score", { ascending: false })
      .order("name", { ascending: true });

    if (error) {
      throw error;
    }

    if (!data) {
      return [];
    }

    return data.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      ai_trend_score: toScore(row.ai_trend_score),
    }));
  } catch (error) {
    console.error("Vercel DB Error:", error);
    return [];
  }
}

export async function fetchBrandBySlug(
  slug: string,
): Promise<BrandDetail | null> {
  try {
    const config = getSupabasePublicEnv();
    if (!config) {
      return null;
    }

    const client = getSupabase();
    if (!client) {
      return null;
    }

    const { data, error } = await client
      .from(BRANDS_TABLE)
      .select("id, name, slug, summary, ai_trend_score, homepage")
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return null;
    }

    return {
      id: String(data.id),
      name: String(data.name),
      slug: String(data.slug),
      summary: typeof data.summary === "string" ? data.summary : "",
      ai_trend_score: toScore(data.ai_trend_score),
      homepage: typeof data.homepage === "string" ? data.homepage : null,
    };
  } catch (error) {
    console.error("Vercel DB Error:", error);
    return null;
  }
}
