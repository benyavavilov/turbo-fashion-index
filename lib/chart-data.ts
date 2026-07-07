import type { TrendDatum } from "@/app/actions";

/** Normalize any date string to YYYY-MM-DD for aligned X-axis ticks. */
export function normalizeDateString(dateStr: string): string {
  const raw = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const d = new Date(raw.includes("T") ? raw : `${raw}T12:00:00`);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString().slice(0, 10);
}

/**
 * Merge rows by normalized date and ensure every series key exists on each row
 * (null when missing) so Recharts tooltips stay complete and connectNulls bridges gaps.
 */
export function groupAndAlignChartData(
  data: TrendDatum[],
  series: string[],
  extraKeys: string[] = []
): TrendDatum[] {
  const byDate = new Map<string, TrendDatum>();

  for (const row of data) {
    const date = normalizeDateString(String(row.date));
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = { date };
      byDate.set(date, bucket);
    }
    for (const [key, value] of Object.entries(row)) {
      if (key === "date") continue;
      if (typeof value === "number") bucket[key] = value;
    }
  }

  const sorted = Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const keysToPreserve = new Set([...series, ...extraKeys]);

  return sorted.map((row) => {
    const aligned: TrendDatum = { date: row.date };
    for (const name of series) {
      const val = row[name];
      aligned[name] = typeof val === "number" ? val : null;
    }
    for (const key of keysToPreserve) {
      if (series.includes(key)) continue;
      const val = row[key];
      if (typeof val === "number") aligned[key] = val;
    }
    for (const [key, value] of Object.entries(row)) {
      if (key === "date" || keysToPreserve.has(key)) continue;
      if (typeof value === "number" || typeof value === "string") {
        aligned[key] = value;
      }
    }
    return aligned;
  });
}

export function mergeStockPrices(
  data: TrendDatum[],
  pricesByDate: Map<string, number>,
  stockKey = "__stock"
): TrendDatum[] {
  if (pricesByDate.size === 0) return data;

  const stockEntries = Array.from(pricesByDate.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  const findNearestPrice = (date: string): number | null => {
    const exact = pricesByDate.get(date);
    if (exact != null) return exact;

    const targetTs = new Date(`${date}T12:00:00`).getTime();
    if (Number.isNaN(targetTs)) return null;

    let best: { diff: number; price: number } | null = null;
    const windowMs = 7 * 24 * 60 * 60 * 1000;

    for (const [stockDate, price] of stockEntries) {
      const stockTs = new Date(`${stockDate}T12:00:00`).getTime();
      if (Number.isNaN(stockTs)) continue;
      const diff = Math.abs(stockTs - targetTs);
      if (diff <= windowMs && (!best || diff < best.diff)) {
        best = { diff, price };
      }
    }

    return best?.price ?? null;
  };

  return data.map((row) => ({
    ...row,
    [stockKey]: findNearestPrice(row.date),
  }));
}
