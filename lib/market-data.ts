import YahooFinance from "yahoo-finance2";

import type { TrendDatum } from "@/lib/chart-data";
import { normalizeDateString } from "@/lib/chart-data";
import { createBrowserSupabase } from "@/lib/supabase";

const yahooFinance = new YahooFinance();

interface MetricJoinRow {
  recorded_date: string;
  interest_value: number;
  tracked_entities: { name: string; category: string } | null;
}

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

  return Array.from(byDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}

/** Fetch Google Trends history for brand names from Supabase. */
export async function fetchTrendHistory(
  brandNames: string[],
  yearsBack = 2
): Promise<TrendDatum[]> {
  const supabase = createBrowserSupabase();
  if (!supabase || brandNames.length === 0) return [];

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - yearsBack);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const { data: entityRows, error: entityError } = await supabase
    .from("tracked_entities")
    .select("id, name")
    .in("name", brandNames);

  if (entityError) throw entityError;
  if (!entityRows?.length) return [];

  const entityIds = entityRows.map((row) => row.id as string);

  // Paginate past Supabase's default 1,000-row max_rows ceiling.
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
      .gte("recorded_date", cutoffIso)
      .order("recorded_date", { ascending: true })
      .range(from, to)
      .limit(10000);

    if (error) throw error;
    if (!page?.length) break;

    allRows.push(...(page as unknown as MetricJoinRow[]));
    if (page.length < PAGE_SIZE) break;
  }

  return reshapeForRecharts(allRows);
}

/** Weekly Yahoo Finance closes keyed by YYYY-MM-DD. */
export async function fetchStockQuotes(
  ticker: string,
  yearsBack = 2
): Promise<Map<string, number>> {
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - yearsBack);

  const chart = await yahooFinance.chart(ticker, {
    period1,
    period2: new Date(),
    interval: "1wk",
  });

  const rawQuotes =
    (chart as { quotes?: { date?: Date; close?: number | null }[] }).quotes ??
    [];

  const map = new Map<string, number>();
  for (const q of rawQuotes) {
    if (q.close == null || q.date == null) continue;
    const date = new Date(q.date).toISOString().slice(0, 10);
    map.set(date, Math.round(q.close * 100) / 100);
  }
  return map;
}

export function latestQuote(map: Map<string, number>): number | null {
  if (map.size === 0) return null;
  const lastDate = [...map.keys()].sort().at(-1);
  return lastDate ? (map.get(lastDate) ?? null) : null;
}
