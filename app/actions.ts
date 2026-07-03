import { createClient } from "@supabase/supabase-js";

export type EntityCategory = "brand" | "trend";

export interface EntityMeta {
  name: string;
  category: EntityCategory;
}

/** One row per date; each tracked entity is a numeric column keyed by its name. */
export interface TrendDatum {
  date: string;
  [entityName: string]: string | number;
}

export interface TrendData {
  data: TrendDatum[];
  entities: EntityMeta[];
}

/** Shape of a joined row returned by the Supabase query. */
interface MetricJoinRow {
  recorded_date: string;
  interest_value: number;
  tracked_entities: { name: string; category: EntityCategory } | null;
}

/**
 * Fetch every recorded metric joined to its entity, then reshape the rows into
 * a flat, date-grouped array that Recharts can consume directly:
 *
 *   [{ date: '2026-01-01', Abercrombie: 45, Lululemon: 72, Gorpcore: 30 }, ...]
 *
 * Uses the public anon key (read-only, RLS-protected). On any failure or when
 * credentials are absent, returns empty arrays so the dashboard can degrade
 * gracefully instead of throwing during render.
 */
export async function getTrendData(): Promise<TrendData> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey || url.includes("your-project-id")) {
    return { data: [], entities: [] };
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: rows, error } = await supabase
      .from("market_metrics")
      .select(
        "recorded_date, interest_value, tracked_entities!inner(name, category)"
      )
      .order("recorded_date", { ascending: true });

    if (error) throw error;

    return reshapeForRecharts((rows ?? []) as unknown as MetricJoinRow[]);
  } catch (err) {
    console.error("[getTrendData] Failed to load market metrics:", err);
    return { data: [], entities: [] };
  }
}

/** Pivot the long-format join rows into wide, date-grouped Recharts rows. */
function reshapeForRecharts(rows: MetricJoinRow[]): TrendData {
  const byDate = new Map<string, TrendDatum>();
  const categoryByName = new Map<string, EntityCategory>();

  for (const row of rows) {
    const entity = row.tracked_entities;
    if (!entity?.name) continue;

    categoryByName.set(entity.name, entity.category);

    let bucket = byDate.get(row.recorded_date);
    if (!bucket) {
      bucket = { date: row.recorded_date };
      byDate.set(row.recorded_date, bucket);
    }
    bucket[entity.name] = row.interest_value;
  }

  const data = Array.from(byDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );

  const entities: EntityMeta[] = Array.from(categoryByName, ([name, category]) => ({
    name,
    category,
  })).sort((a, b) => a.name.localeCompare(b.name));

  return { data, entities };
}
