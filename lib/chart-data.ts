import type { Timeframe } from "@/lib/chart-context";

/** One row per date; each tracked entity is a numeric column keyed by its name. */
export interface TrendDatum {
  date: string;
  [entityName: string]: string | number | null | undefined;
}

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

function sortTrendRows(rows: TrendDatum[]): TrendDatum[] {
  return [...rows].sort(
    (a, b) =>
      new Date(normalizeDateString(String(a.date))).getTime() -
      new Date(normalizeDateString(String(b.date))).getTime()
  );
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
      } else if (value === null) {
        if (!(key in bucket)) bucket[key] = null;
      } else if (typeof value === "string" && !(key in bucket)) {
        bucket[key] = value;
      }
    }
  }

  return sortTrendRows(Array.from(byDate.values()));
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
  const consolidated = consolidateRowsByDate(data);
  const latest = latestDateInData(consolidated);
  if (!latest) return consolidated;

  const cutoff = cutoffDateFrom(latest, timeframe);
  const cutoffTs = cutoff.getTime();

  const filtered = consolidated.filter((row) => {
    const ts = dateToTimestamp(String(row.date));
    return ts != null && ts >= cutoffTs;
  });

  return consolidateRowsByDate(filtered);
}

/**
 * LOCF (last observation carried forward) for brand/search series only.
 * After Google Trends lag behind live Yahoo quotes, trailing weekly rows stay
 * flat at the last known interest instead of dropping to null and breaking
 * tooltips / line continuity.
 */
export function forwardFillSeries(
  rows: TrendDatum[],
  seriesKeys: string[]
): TrendDatum[] {
  if (rows.length === 0 || seriesKeys.length === 0) return rows;

  const lastKnown: Record<string, number> = {};
  const filled: TrendDatum[] = [];

  for (const row of rows) {
    const next: TrendDatum = { ...row };
    for (const key of seriesKeys) {
      const val = next[key];
      if (typeof val === "number" && !Number.isNaN(val)) {
        lastKnown[key] = val;
      } else if (key in lastKnown) {
        next[key] = lastKnown[key];
      } else {
        next[key] = null;
      }
    }
    filled.push(next);
  }

  return filled;
}

/**
 * Force every series key to exist as `number | null` on every row.
 * Uniform objects keep Recharts hover/cursor aligned across the full X domain.
 * Brand/search columns are then LOCF-filled so they extend to the last stock date.
 */
export function groupAndAlignChartData(
  data: TrendDatum[],
  series: string[],
  extraKeys: string[] = []
): TrendDatum[] {
  const merged = consolidateRowsByDate(data);
  const keys = [...series, ...extraKeys];

  const aligned = sortTrendRows(
    merged.map((row) => {
      const next: TrendDatum = {
        date: normalizeDateString(String(row.date)),
      };
      for (const name of keys) {
        const val = row[name];
        next[name] =
          typeof val === "number" && !Number.isNaN(val) ? val : null;
      }
      return next;
    })
  );

  // Forward-fill child brands only — never invent stock prices.
  return forwardFillSeries(aligned, series);
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

function collectTrendBrandKeys(rows: TrendDatum[], stockKey: string): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key === "date" || key === stockKey) continue;
      keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * FULL OUTER JOIN of search-trend dates and stock quote dates.
 * Every date in either source appears once; missing brand interest and missing
 * stock closes are explicitly `null` (never omitted / undefined).
 */
export function mergeStockPrices(
  data: TrendDatum[] | null | undefined,
  pricesByDate: Map<string, number> | null | undefined,
  stockKey = "__stock"
): TrendDatum[] {
  const trendRows = Array.isArray(data) ? consolidateRowsByDate(data) : [];
  const brandKeys = collectTrendBrandKeys(trendRows, stockKey);

  const stockEntries =
    pricesByDate && pricesByDate instanceof Map
      ? Array.from(pricesByDate.entries())
          .map(([date, price]) => ({
            date: normalizeDateString(date),
            price,
          }))
          .filter((e) => typeof e.price === "number" && !Number.isNaN(e.price))
          .sort((a, b) => a.date.localeCompare(b.date))
      : [];

  if (trendRows.length === 0 && stockEntries.length === 0) return [];

  if (stockEntries.length === 0) {
    return forwardFillSeries(
      sortTrendRows(
        trendRows.map((row) => {
          const date = normalizeDateString(String(row.date));
          const next: TrendDatum = { date, [stockKey]: null };
          for (const brand of brandKeys) {
            const val = row[brand];
            next[brand] =
              typeof val === "number" && !Number.isNaN(val) ? val : null;
          }
          return next;
        })
      ),
      brandKeys
    );
  }

  try {
    const trendByDate = new Map<string, TrendDatum>();
    for (const row of trendRows) {
      const date = normalizeDateString(String(row.date));
      trendByDate.set(date, { ...row, date });
    }

    const allDates = new Set<string>();
    for (const date of trendByDate.keys()) allDates.add(date);
    for (const entry of stockEntries) allDates.add(entry.date);

    const masterDates = [...allDates].sort((a, b) => a.localeCompare(b));

    const merged: TrendDatum[] = masterDates.map((date) => {
      const trend = trendByDate.get(date);
      const row: TrendDatum = { date };

      for (const brand of brandKeys) {
        const val = trend?.[brand];
        row[brand] =
          typeof val === "number" && !Number.isNaN(val) ? val : null;
      }

      const price = findNearestStockPrice(date, stockEntries);
      row[stockKey] = price;

      return row;
    });

    // Carry last known brand interest through trailing stock-only dates.
    return forwardFillSeries(sortTrendRows(merged), brandKeys);
  } catch {
    return trendRows;
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

  const allDates = new Set(canonical.map((r) => normalizeDateString(String(r.date))));
  for (const { entries } of stockSeries) {
    for (const e of entries) allDates.add(e.date);
  }

  const brandKeys = collectTrendBrandKeys(canonical, "");
  const byDate = new Map(
    canonical.map((r) => [normalizeDateString(String(r.date)), r] as const)
  );

  const merged = [...allDates]
    .sort((a, b) => a.localeCompare(b))
    .map((date) => {
      const trend = byDate.get(date);
      const next: TrendDatum = { date };
      for (const brand of brandKeys) {
        const val = trend?.[brand];
        next[brand] =
          typeof val === "number" && !Number.isNaN(val) ? val : null;
      }
      for (const { key, entries } of stockSeries) {
        next[key] = findNearestStockPrice(date, entries);
      }
      return next;
    });

  return sortTrendRows(merged);
}
