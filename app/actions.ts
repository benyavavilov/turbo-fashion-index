"use server";

import { connection } from "next/server";

import { normalizeDateString } from "@/lib/chart-data";
import type { TrendDatum } from "@/lib/chart-data";
import { entities, type EntityMeta } from "@/lib/entities";
import { createBrowserSupabase } from "@/lib/supabase";

/** Shape of a joined row returned by the Supabase query. */
interface MetricJoinRow {
  recorded_date: string;
  interest_value: number;
  tracked_entities: { name: string; category: import("@/lib/entities").EntityCategory } | null;
}

/**
 * Canonical entity catalog for the dashboard (code-defined for backtesting).
 */
export async function getTrackedEntities(): Promise<EntityMeta[]> {
  return entities;
}

export interface EntityRequestInput {
  name: string;
  category: import("@/lib/entities").EntityCategory;
  notes?: string;
}

export async function submitEntityRequest(
  input: EntityRequestInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  await connection(); // opt out of Next.js static/request caching

  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: "Entity name is required." };
  }

  const supabase = createBrowserSupabase();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured." };
  }

  try {
    const { error } = await supabase.from("entity_requests").insert({
      name,
      category: input.category,
      notes: input.notes?.trim() || null,
    });

    if (error) throw error;
    return { ok: true };
  } catch (err) {
    console.error("[submitEntityRequest] Failed:", err);
    const message =
      err instanceof Error ? err.message : "Failed to submit request.";
    return { ok: false, error: message };
  }
}

/**
 * Fetch market_metrics for the selected brand names.
 * Always bypasses Next.js fetch/data cache so post-ingestion refreshes show up.
 *
 * Supabase/PostgREST defaults to a hard max of 1,000 rows per response even when
 * `.limit(N)` is larger — so we page with `.range()` until we have the full
 * multi-year timeline (up to 10,000 rows).
 */
export async function getTrendData(
  selectedEntityNames: string[]
): Promise<TrendDatum[]> {
  // Next.js 16: prefer `connection()` over deprecated `unstable_noStore()`.
  await connection();

  if (selectedEntityNames.length === 0) return [];

  const supabase = createBrowserSupabase();
  if (!supabase) return [];

  try {
    const { data: entityRows, error: entityError } = await supabase
      .from("tracked_entities")
      .select("id, name")
      .in("name", selectedEntityNames);

    if (entityError) throw entityError;
    if (!entityRows?.length) return [];

    const entityIds = entityRows.map((row) => row.id as string);

    // PostgREST max_rows is typically 1000 — page past that ceiling.
    const PAGE_SIZE = 1000;
    const MAX_ROWS = 10000;
    const allRows: MetricJoinRow[] = [];

    for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE - 1, MAX_ROWS - 1);
      const { data: page, error } = await supabase
        .from("market_metrics")
        .select(
          "recorded_date, interest_value, tracked_entities!inner(name, category)"
        )
        .in("entity_id", entityIds)
        .order("recorded_date", { ascending: true })
        .range(from, to)
        .limit(10000);

      if (error) throw error;
      if (!page?.length) break;

      allRows.push(...(page as unknown as MetricJoinRow[]));
      if (page.length < PAGE_SIZE) break;
    }

    return reshapeForRecharts(allRows);
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

    const date = normalizeDateString(row.recorded_date);

    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = { date };
      byDate.set(date, bucket);
    }
    bucket[entity.name] = row.interest_value;
  }

  return Array.from(byDate.values()).sort(
    (a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}
