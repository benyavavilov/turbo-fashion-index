import { getSupabase, getSupabasePublicEnv } from "@/app/lib/supabase";

export interface BrandRecord {
  id: string;
  name: string;
  slug: string;
}

const BRANDS_TABLE = "brands";

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

  return items.filter((item) => matchesWordBoundaryPrefix(item.name, normalizedQuery));
}

export async function fetchBrandsFromDatabase(): Promise<BrandRecord[]> {
  const config = getSupabasePublicEnv();
  console.log("Supabase URL:", config?.url);

  try {
    if (!config) {
      console.error(
        "Supabase fetch error: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty.",
      );
      return [];
    }

    const client = getSupabase();
    if (!client) {
      console.error("Supabase fetch error: Client failed to initialize.");
      return [];
    }

    const { data, error } = await client
      .from(BRANDS_TABLE)
      .select("id, name, slug")
      .order("name");

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
    }));
  } catch (error) {
    console.error("Supabase fetch error:", error);
    return [];
  }
}
