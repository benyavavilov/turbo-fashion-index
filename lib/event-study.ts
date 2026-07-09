import type { TrendDatum } from "@/lib/chart-data";
import { normalizeDateString } from "@/lib/chart-data";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SPIKE_INCREASE_THRESHOLD = 20;
const TRAILING_WINDOW_DAYS = 30;
const DEDUP_WINDOW_DAYS = 90;
const HOLD_DAYS = 90;
/** Max calendar drift when matching weekly stock quotes to a target date. */
const STOCK_MATCH_DRIFT_DAYS = 21;

export interface EventStudyEvent {
  date: string;
  trendValue: number;
  increase: number;
  priceAtEvent: number;
  exitDate: string;
  priceAfterHold: number;
  returnPct: number;
}

export interface EventStudyResult {
  events: EventStudyEvent[];
  eventCount: number;
  averageReturnPct: number;
}

function dateToMs(dateStr: string): number {
  return new Date(`${normalizeDateString(dateStr)}T12:00:00`).getTime();
}

function daysBetween(a: string, b: string): number {
  return Math.abs(dateToMs(b) - dateToMs(a)) / MS_PER_DAY;
}

function trendValue(row: TrendDatum, brand: string): number | null {
  const v = row[brand];
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return v;
}

function stockValue(row: TrendDatum, stockKey: string): number | null {
  const v = row[stockKey];
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return v;
}

function findClosestStockPrice(
  rows: TrendDatum[],
  targetDate: string,
  stockKey: string
): number | null {
  const targetMs = dateToMs(targetDate);
  let best: { diff: number; price: number } | null = null;

  for (const row of rows) {
    const price = stockValue(row, stockKey);
    if (price == null) continue;
    const diff = Math.abs(dateToMs(String(row.date)) - targetMs);
    if (diff <= STOCK_MATCH_DRIFT_DAYS * MS_PER_DAY && (!best || diff < best.diff)) {
      best = { diff, price };
    }
  }

  return best?.price ?? null;
}

function findPriceAfterHold(
  rows: TrendDatum[],
  eventDate: string,
  stockKey: string
): { price: number; date: string } | null {
  const targetMs = dateToMs(eventDate) + HOLD_DAYS * MS_PER_DAY;
  let best: { diff: number; price: number; date: string } | null = null;

  for (const row of rows) {
    const price = stockValue(row, stockKey);
    if (price == null) continue;
    const diff = Math.abs(dateToMs(String(row.date)) - targetMs);
    if (diff <= STOCK_MATCH_DRIFT_DAYS * MS_PER_DAY && (!best || diff < best.diff)) {
      best = { diff, price, date: String(row.date) };
    }
  }

  return best ? { price: best.price, date: best.date } : null;
}

function detectSpikeCandidates(
  rows: TrendDatum[],
  brand: string
): { date: string; trendValue: number; increase: number }[] {
  const candidates: { date: string; trendValue: number; increase: number }[] =
    [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const current = trendValue(row, brand);
    if (current == null) continue;

    const currentMs = dateToMs(String(row.date));
    let trailingMin = current;

    for (let j = 0; j < rows.length; j++) {
      const prior = rows[j];
      const priorMs = dateToMs(String(prior.date));
      const daysBack = (currentMs - priorMs) / MS_PER_DAY;
      if (daysBack < 0 || daysBack > TRAILING_WINDOW_DAYS) continue;

      const priorTrend = trendValue(prior, brand);
      if (priorTrend != null) trailingMin = Math.min(trailingMin, priorTrend);
    }

    const increase = current - trailingMin;
    if (increase >= SPIKE_INCREASE_THRESHOLD) {
      candidates.push({
        date: String(row.date),
        trendValue: current,
        increase,
      });
    }
  }

  return candidates;
}

/** Keep one major spike per 90-day period (strongest increase wins). */
function dedupeSpikes(
  candidates: { date: string; trendValue: number; increase: number }[]
): { date: string; trendValue: number; increase: number }[] {
  const sorted = [...candidates].sort((a, b) => a.date.localeCompare(b.date));
  const deduped: { date: string; trendValue: number; increase: number }[] = [];

  for (const candidate of sorted) {
    if (deduped.length === 0) {
      deduped.push(candidate);
      continue;
    }

    const last = deduped[deduped.length - 1];
    if (daysBetween(last.date, candidate.date) < DEDUP_WINDOW_DAYS) {
      if (candidate.increase > last.increase) {
        deduped[deduped.length - 1] = candidate;
      }
    } else {
      deduped.push(candidate);
    }
  }

  return deduped;
}

/**
 * Event study: identify hype spikes (+20 pts in 30d) and measure 90-day stock returns.
 */
export function runEventStudy(
  data: TrendDatum[],
  brand: string,
  stockKey: string
): EventStudyResult {
  const rows = [...data].sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  );

  const spikes = dedupeSpikes(detectSpikeCandidates(rows, brand));
  const events: EventStudyEvent[] = [];

  for (const spike of spikes) {
    const priceAtEvent = findClosestStockPrice(rows, spike.date, stockKey);
    const exit = findPriceAfterHold(rows, spike.date, stockKey);
    if (priceAtEvent == null || exit == null || priceAtEvent === 0) continue;

    events.push({
      date: spike.date,
      trendValue: spike.trendValue,
      increase: spike.increase,
      priceAtEvent,
      exitDate: exit.date,
      priceAfterHold: exit.price,
      returnPct: ((exit.price - priceAtEvent) / priceAtEvent) * 100,
    });
  }

  const averageReturnPct =
    events.length > 0
      ? events.reduce((sum, e) => sum + e.returnPct, 0) / events.length
      : 0;

  return {
    events,
    eventCount: events.length,
    averageReturnPct,
  };
}
