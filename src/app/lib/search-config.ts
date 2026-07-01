import { getSupabase, getSupabasePublicEnv } from "@/app/lib/supabase";

export interface BrandRecord {
  id: string;
  name: string;
  slug: string;
  ai_trend_score: number;
  logo_url: string | null;
}

export interface BrandDetail {
  id: string;
  name: string;
  slug: string;
  summary: string;
  ai_trend_score: number;
  homepage: string | null;
  logo_url: string | null;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export interface BrandNewsItem {
  id: string;
  brand_slug: string;
  category: string;
  notification_banner: string;
  url: string;
  image_url: string;
  title: string;
  published_at: string;
  source: string;
}

const BRANDS_TABLE = "tracked_brands";
const NEWS_TABLE = "brand_news";

const NEWS_COLUMNS =
  "id, brand_slug, category, notification_banner, url, image_url, title, published_at, source";

function mapNewsRow(row: Record<string, unknown>): BrandNewsItem {
  return {
    id: row.id != null ? String(row.id) : String(row.url ?? ""),
    brand_slug: typeof row.brand_slug === "string" ? row.brand_slug : "",
    category: typeof row.category === "string" ? row.category : "General",
    notification_banner:
      typeof row.notification_banner === "string" ? row.notification_banner : "",
    url: typeof row.url === "string" ? row.url : "",
    image_url: typeof row.image_url === "string" ? row.image_url : "",
    title: typeof row.title === "string" ? row.title : "",
    published_at:
      typeof row.published_at === "string" ? row.published_at : "",
    source: typeof row.source === "string" ? row.source : "",
  };
}

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
      .select("*")
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
      logo_url: toOptionalString(row.logo_url),
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
      .select("*")
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
      logo_url: toOptionalString(data.logo_url),
    };
  } catch (error) {
    console.error("Vercel DB Error:", error);
    return null;
  }
}

export async function fetchBrandNewsBySlug(
  slug: string,
): Promise<BrandNewsItem[]> {
  try {
    const client = getSupabasePublicEnv() ? getSupabase() : null;
    if (!client) {
      return [];
    }

    const { data, error } = await client
      .from(NEWS_TABLE)
      .select(NEWS_COLUMNS)
      .eq("brand_slug", slug)
      .order("published_at", { ascending: false });

    if (error) {
      throw error;
    }

    return (data ?? []).map(mapNewsRow);
  } catch (error) {
    console.error("Vercel DB Error:", error);
    return [];
  }
}

export async function fetchNewsForSlugs(
  slugs: string[],
): Promise<BrandNewsItem[]> {
  if (slugs.length === 0) {
    return [];
  }

  try {
    const client = getSupabasePublicEnv() ? getSupabase() : null;
    if (!client) {
      return [];
    }

    const { data, error } = await client
      .from(NEWS_TABLE)
      .select(NEWS_COLUMNS)
      .in("brand_slug", slugs)
      .order("published_at", { ascending: false });

    if (error) {
      throw error;
    }

    return (data ?? []).map(mapNewsRow);
  } catch (error) {
    console.error("Vercel DB Error:", error);
    return [];
  }
}
