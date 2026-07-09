import type { TrendDatum } from "@/app/actions";
import type { Timeframe } from "@/lib/chart-context";

/** Max calendar drift when snapping a stock quote onto a search-interest date. */
const STOCK_SNAP_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

function dateToTimestamp(dateStr: string): number | null {
  const normalized = normalizeDateString(dateStr);
  const ts = new Date(`${normalized}T12:00:00`).getTime();
  return Number.isNaN(ts) ? null : ts;
}

/** Normalize any date string to YYYY-MM-DD for aligned X-axis ticks. */
export function normalizeDateString(dateStr: string): string {
  const raw = String(dateStr).trim();

  const isoDay = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDay) return `${isoDay[1]}-${isoDay[2]}-${isoDay[3]}`;

  const yearMonth = raw.match(/^(\d{4})-(\d{2})$/);
  if (yearMonth) return `${yearMonth[1]}-${yearMonth[2]}-01`;

  const d = new Date(raw.includes("T") ? raw : `${raw}T12:00:00`);
  if (Number.isNaN(d.getTime())) return raw;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Collapse rows that share the same normalized date into one merged object. */
export function consolidateRowsByDate(data: TrendDatum[]): TrendDatum[] {
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
      if (typeof value === "number" && !Number.isNaN(value)) {
        bucket[key] = value;
      } else if (typeof value === "string" && !(key in bucket)) {
        bucket[key] = value;
      }
    }
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** Latest observation date present in a series (anchors timeframe windows). */
export function latestDateInData(data: TrendDatum[]): Date | null {
  if (data.length === 0) return null;

  const timestamps = data
    .map((row) => dateToTimestamp(String(row.date)))
    .filter((ts): ts is number => ts != null);

  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps));
}

export function cutoffDateFrom(latest: Date, timeframe: Timeframe): Date {
  const d = new Date(latest.getTime());
  if (timeframe === "6M") d.setMonth(d.getMonth() - 6);
  else if (timeframe === "1Y") d.setFullYear(d.getFullYear() - 1);
  else d.setFullYear(d.getFullYear() - 5);
  return d;
}

/** Slice chart rows to a timeframe window ending at the dataset's latest date. */
export function filterByTimeframe(
  data: TrendDatum[],
  timeframe: Timeframe
): TrendDatum[] {
  const latest = latestDateInData(data);
  if (!latest) return consolidateRowsByDate(data);

  const cutoff = cutoffDateFrom(latest, timeframe);
  const cutoffTs = cutoff.getTime();

  const filtered = data.filter((row) => {
    const ts = dateToTimestamp(String(row.date));
    return ts != null && ts >= cutoffTs;
  });

  return consolidateRowsByDate(filtered);
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
  const merged = consolidateRowsByDate(data);
  const keysToPreserve = new Set([...series, ...extraKeys]);

  return merged.map((row) => {
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

function findNearestStockPrice(
  targetDate: string,
  stockEntries: { date: string; price: number }[]
): number | null {
  const exact = stockEntries.find((entry) => entry.date === targetDate);
  if (exact != null && !Number.isNaN(exact.price)) return exact.price;

  const targetTs = dateToTimestamp(targetDate);
  if (targetTs == null) return null;

  let best: { diff: number; price: number } | null = null;

  for (const entry of stockEntries) {
    if (entry.price == null || Number.isNaN(entry.price)) continue;
    const stockTs = dateToTimestamp(entry.date);
    if (stockTs == null) continue;
    const diff = Math.abs(stockTs - targetTs);
    if (diff <= STOCK_SNAP_WINDOW_MS && (!best || diff < best.diff)) {
      best = { diff, price: entry.price };
    }
  }

  return best?.price ?? null;
}

export function mergeStockPrices(
  data: TrendDatum[] | null | undefined,
  pricesByDate: Map<string, number> | null | undefined,
  stockKey = "__stock"
): TrendDatum[] {
  if (!Array.isArray(data) || data.length === 0) return data ?? [];
  if (!pricesByDate || !(pricesByDate instanceof Map) || pricesByDate.size === 0) {
    return consolidateRowsByDate(data);
  }

  try {
    const stockEntries = Array.from(pricesByDate.entries())
      .map(([date, price]) => ({
        date: normalizeDateString(date),
        price,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const enriched = data.map((row) => {
      const date = normalizeDateString(String(row.date));
      const price = findNearestStockPrice(date, stockEntries);
      return price != null ? { ...row, date, [stockKey]: price } : { ...row, date };
    });

    return consolidateRowsByDate(enriched);
  } catch {
    return consolidateRowsByDate(data);
  }
}

/**
 * Snap each entity's stock quotes onto existing search-trend dates (±4 days),
 * then consolidate so every row is unique by date.
 */
export function mergeStockPricesForEntities(
  data: TrendDatum[],
  pricesByEntity: Record<string, Map<string, number>>,
  keyForEntity: (entityName: string) => string
): TrendDatum[] {
  if (!Array.isArray(data) || data.length === 0) return [];

  const canonical = consolidateRowsByDate(data);
  const stockSeries = Object.entries(pricesByEntity).map(([entityName, prices]) => ({
    entityName,
    key: keyForEntity(entityName),
    entries: Array.from(prices.entries())
      .map(([date, price]) => ({
        date: normalizeDateString(date),
        price,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }));

  if (stockSeries.length === 0) return canonical;

  const enriched = canonical.map((row) => {
    const date = normalizeDateString(String(row.date));
    const next: TrendDatum = { ...row, date };

    for (const { key, entries } of stockSeries) {
      const price = findNearestStockPrice(date, entries);
      if (price != null) next[key] = price;
    }

    return next;
  });

  return consolidateRowsByDate(enriched);
}
