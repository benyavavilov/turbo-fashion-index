"use server";

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

/** Shape of a joined row returned by the Supabase query. */
interface MetricJoinRow {
  recorded_date: string;
  interest_value: number;
  tracked_entities: { name: string; category: EntityCategory } | null;
}

function createSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey || url.includes("your-project-id")) {
    return null;
  }

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Lightweight catalog fetch — all tracked entities for the picker UI.
 * (Only ~30 rows; no metrics payload.)
 */
export async function getTrackedEntities(): Promise<EntityMeta[]> {
  const supabase = createSupabase();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from("tracked_entities")
      .select("name, category")
      .order("name", { ascending: true });

    if (error) throw error;
    return (data ?? []) as EntityMeta[];
  } catch (err) {
    console.error("[getTrackedEntities] Failed:", err);
    return [];
  }
}

/**
 * Fetch market_metrics only for the entities the user has selected.
 * Scoped by entity_id and lifted to 10 000 rows so a full 5-year weekly
 * history fits even when comparing many series at once.
 */
export async function getTrendData(
  selectedEntityNames: string[]
): Promise<TrendDatum[]> {
  if (selectedEntityNames.length === 0) return [];

  const supabase = createSupabase();
  if (!supabase) return [];

  try {
    const { data: entityRows, error: entityError } = await supabase
      .from("tracked_entities")
      .select("id, name")
      .in("name", selectedEntityNames);

    if (entityError) throw entityError;
    if (!entityRows?.length) return [];

    const entityIds = entityRows.map((row) => row.id as string);

    const { data: rows, error } = await supabase
      .from("market_metrics")
      .select(
        "recorded_date, interest_value, tracked_entities!inner(name, category)"
      )
      .in("entity_id", entityIds)
      .order("recorded_date", { ascending: true })
      .limit(10000);

    if (error) throw error;

    return reshapeForRecharts((rows ?? []) as unknown as MetricJoinRow[]);
  } catch (err) {
    console.error("[getTrendData] Failed to load market metrics:", err);
    return [];
  }
}

/** Pivot long-format join rows into wide, date-grouped Recharts rows. */
function reshapeForRecharts(rows: MetricJoinRow[]): TrendDatum[] {
  const byDate = new Map<string, TrendDatum>();

  for (const row of rows) {
    const entity = row.tracked_entities;
    if (!entity?.name) continue;

    let bucket = byDate.get(row.recorded_date);
    if (!bucket) {
      bucket = { date: row.recorded_date };
      byDate.set(row.recorded_date, bucket);
    }
    bucket[entity.name] = row.interest_value;
  }

  return Array.from(byDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}
