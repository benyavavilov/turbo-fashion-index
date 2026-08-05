"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Loader2,
  Scale,
} from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { getTrendData } from "@/app/actions";
import CompanyChat from "@/app/components/company-chat";
import { formatVerdictText } from "@/app/components/format-verdict-text";
import historicalEstimates from "@/data/historical-estimates.json";
import type { ParentCompany } from "@/lib/entities";
import {
  INSIGHT_GENERATING_FALLBACK,
  formatExpectedRevenueGrowth,
  formatSearchGrowthPct,
  formatWallStreetConsensus,
  mismatchToAlertBadge,
  type CompanyBrief,
  type EarningsMismatch,
} from "@/lib/ai-insights";
import {
  filterByTimeframe,
  groupAndAlignChartData,
  mergeStockPrices,
  normalizeDateString,
  type TrendDatum,
} from "@/lib/chart-data";
import type { ChartContext, Timeframe } from "@/lib/chart-context";
import {
  runEventStudy,
  type EventStudyResult,
} from "@/lib/event-study";
import { formatUsd } from "@/lib/paper-portfolio";
import { isSupabaseConfigured } from "@/lib/supabase";
import {
  SNIPER_LEDGER_MIN_DATE,
  buildSniperLedgerRows,
  calculateHistoricalSniperAccuracy,
  type SniperPrediction,
} from "@/lib/sniper-accuracy";

const STOCK_KEY = "__stock";
const YOY_LAG_DAYS = 365;
const BRAND_COLORS = [
  "#1d4ed8",
  "#7c3aed",
  "#059669",
  "#d97706",
  "#db2777",
  "#e11d48",
  "#0d9488",
  "#6d28d9",
];

const STOCK_STROKE = "#1d4ed8";
const STOCK_FILL = "#1d4ed8";
const GRID_STROKE = "#e2e8f0";
const AXIS_TICK = "#64748b";
const AXIS_LINE = "#cbd5e1";

type HistoricalEstimate = {
  date: string;
  estimatedRevenueGrowth: number;
  actualRevenueGrowth: number;
};

type HistoricalEstimatesMap = Record<string, HistoricalEstimate[]>;

const ESTIMATES = historicalEstimates as HistoricalEstimatesMap;

/** Catalyst metadata injected onto continuous weekly chart rows. */
interface InjectedCatalyst {
  brand: string;
  sentiment?: string;
  reason: string;
}

/** Dense weekly timeline row — same keys on every date (Recharts-safe). */
type ChartPoint = {
  date: string;
  catalyst?: InjectedCatalyst | null;
  catalysts?: InjectedCatalyst[];
  [key: string]:
    | string
    | number
    | null
    | undefined
    | InjectedCatalyst
    | InjectedCatalyst[];
};

type ChartTooltipProps = {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    dataKey?: string | number;
    name?: string;
    value?: number | string | null;
    color?: string;
    payload?: ChartPoint;
  }>;
};

type FundamentalsState = {
  trailingPE: string;
  forwardPE: string;
  nextEarnings: string;
  recommendationKey: string;
};

function sortByDateAsc<T extends { date: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      new Date(normalizeDateString(String(a.date))).getTime() -
      new Date(normalizeDateString(String(b.date))).getTime()
  );
}

function snapToChartDate(
  targetDate: string,
  chartDates: string[]
): string | null {
  const target = normalizeDateString(targetDate);
  if (chartDates.includes(target)) return target;

  const targetMs = new Date(`${target}T12:00:00`).getTime();
  let best: { date: string; diff: number } | null = null;
  const maxDiff = 14 * 24 * 60 * 60 * 1000;

  for (const d of chartDates) {
    const diff = Math.abs(new Date(`${d}T12:00:00`).getTime() - targetMs);
    if (diff <= maxDiff && (!best || diff < best.diff)) {
      best = { date: d, diff };
    }
  }
  return best?.date ?? null;
}

function formatGrowthPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function toIsoDateLocal(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseIsoDateLocal(iso: string): Date | null {
  const normalized = normalizeDateString(iso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const d = new Date(`${normalized}T12:00:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function CatalystTooltipCard({
  catalysts,
  date,
}: {
  catalysts: InjectedCatalyst[];
  date: string;
}) {
  return (
    <div className="max-w-[280px] rounded-lg border border-amber-400/50 bg-white px-3 py-2 shadow-xl">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-600">
        Catalyst Event
      </p>
      {catalysts.map((c) => (
        <div key={`${c.brand}-${c.reason.slice(0, 24)}`} className="mt-2 first:mt-1">
          <p className="font-mono text-[10px] text-slate-500">
            {date} · {c.brand}
            {c.sentiment ? ` · ${c.sentiment}` : ""}
          </p>
          <p className="mt-1 text-xs leading-snug text-slate-800">{c.reason}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Line `dot` renderer on the dense weekly series.
 * Only paints a glowing marker when this brand has a catalyst on that date.
 */
function CustomCatalystDot(props: {
  cx?: number;
  cy?: number;
  payload?: ChartPoint;
  dataKey?: string | number;
}) {
  const { cx, cy, payload, dataKey } = props;
  if (cx == null || cy == null || !payload || dataKey == null) return null;

  const brand = String(dataKey);
  const match =
    payload.catalysts?.find((c) => c.brand === brand) ??
    (payload.catalyst?.brand === brand ? payload.catalyst : null);

  if (!match) return null;

  const negative = match.sentiment === "NEGATIVE";
  const fill = negative ? "#dc2626" : "#16a34a";
  const glow = negative ? "rgba(220,38,38,0.35)" : "rgba(22,163,74,0.35)";

  return (
    <g style={{ pointerEvents: "none" }}>
      <circle cx={cx} cy={cy} r={10} fill={glow} opacity={0.45} />
      <circle
        cx={cx}
        cy={cy}
        r={5}
        fill={fill}
        stroke="#ffffff"
        strokeWidth={1.5}
      />
      <circle cx={cx} cy={cy} r={2} fill="#0f172a" />
    </g>
  );
}

/** Unified tooltip on the continuous weekly timeline. */
function CompanyChartTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload;
  const catalysts =
    row?.catalysts?.length
      ? row.catalysts
      : row?.catalyst
        ? [row.catalyst]
        : [];

  if (catalysts.length > 0) {
    return (
      <CatalystTooltipCard
        catalysts={catalysts}
        date={normalizeDateString(String(row?.date ?? label ?? ""))}
      />
    );
  }

  const seriesRows = payload.filter(
    (p) => p.dataKey !== "catalyst" && p.value != null
  );
  if (seriesRows.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-mono text-[10px] text-slate-500">{label}</p>
      {seriesRows.map((p) => (
        <p key={String(p.dataKey)} className="text-slate-700">
          <span style={{ color: String(p.color) }}>{p.name}</span>:{" "}
          <span className="font-mono">
            {typeof p.value === "number" ? p.value.toFixed(1) : p.value}
          </span>
        </p>
      ))}
    </div>
  );
}

function wallStreetBadgeClass(raw: string | null | undefined) {
  const key = (raw ?? "").toLowerCase();
  if (
    key.includes("buy") ||
    key.includes("outperform") ||
    key.includes("overweight") ||
    key.includes("strong_buy")
  ) {
    return "border-green-600/30 bg-green-50 text-green-700";
  }
  if (
    key.includes("sell") ||
    key.includes("underperform") ||
    key.includes("underweight") ||
    key.includes("strong_sell")
  ) {
    return "border-red-600/30 bg-red-50 text-red-700";
  }
  if (key.includes("hold") || key.includes("neutral")) {
    return "border-amber-500/40 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function directionPanelAccent(mismatch: EarningsMismatch | null | undefined) {
  if (mismatch === "BEAT_LIKELY") {
    return "border-green-600/25 bg-gradient-to-b from-green-50 via-white to-white";
  }
  if (mismatch === "MISS_LIKELY") {
    return "border-red-600/25 bg-gradient-to-b from-red-50 via-white to-white";
  }
  if (mismatch === "PRICED_IN") {
    return "border-amber-500/30 bg-gradient-to-b from-amber-50 via-white to-white";
  }
  return "border-slate-200 bg-white";
}

function directionBadgeClass(mismatch: EarningsMismatch | null | undefined) {
  if (mismatch === "MISS_LIKELY") {
    return "border-red-600/40 bg-red-50 text-red-700";
  }
  if (mismatch === "BEAT_LIKELY") {
    return "border-green-600/40 bg-green-50 text-green-700";
  }
  if (mismatch === "PRICED_IN") {
    return "border-amber-500/40 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function predictionResultClass(result: SniperPrediction) {
  if (result === "BEAT") return "text-green-600";
  if (result === "MISS") return "text-red-600";
  return "text-slate-400";
}

function predictionResultLabel(result: SniperPrediction) {
  if (result === "BEAT") return "BEAT LIKELY";
  if (result === "MISS") return "MISS LIKELY";
  return "NO SIGNAL";
}

function SearchStockMiniChart({
  data,
  brandKeys,
  stockName,
  brandColors,
  height = 200,
  showLegend = false,
}: {
  data: ChartPoint[];
  brandKeys: string[];
  stockName: string;
  brandColors: Record<string, string>;
  height?: number;
  showLegend?: boolean;
}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-slate-400"
        style={{ height }}
      >
        No data in this window.
      </div>
    );
  }

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          style={{ outline: "none" }}
        >
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            type="category"
            tick={{ fill: AXIS_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: AXIS_LINE }}
            minTickGap={28}
            allowDuplicatedCategory={false}
          />
          <YAxis
            yAxisId="left"
            orientation="left"
            domain={[0, "auto"]}
            tick={{ fill: AXIS_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={["auto", "auto"]}
            tick={{ fill: AXIS_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            shared
            cursor={{
              stroke: STOCK_STROKE,
              strokeWidth: 1,
              strokeDasharray: "3 3",
              opacity: 0.35,
            }}
            content={(props) => (
              <CompanyChartTooltip
                active={props.active}
                payload={
                  props.payload as unknown as ChartTooltipProps["payload"]
                }
                label={props.label as string | number | undefined}
              />
            )}
            wrapperStyle={{ outline: "none", zIndex: 20 }}
          />
          {showLegend && (
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
          )}
          <Area
            yAxisId="right"
            type="monotone"
            dataKey={STOCK_KEY}
            name={stockName}
            stroke={STOCK_STROKE}
            fill={STOCK_FILL}
            fillOpacity={0.12}
            strokeWidth={1.5}
            connectNulls
            dot={false}
            isAnimationActive={false}
          />
          {brandKeys.map((brand) => (
            <Line
              key={brand}
              yAxisId="left"
              type="monotone"
              dataKey={brand}
              name={brand}
              stroke={brandColors[brand] ?? BRAND_COLORS[0]}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
              dot={false}
              activeDot={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

const QTD_CURRENT_KEY = "currentQtd";
const QTD_PRIOR_KEY = "priorYearQtd";

type QtdYoYPoint = {
  label: string;
  dayOffset: number;
  [QTD_CURRENT_KEY]: number | null;
  [QTD_PRIOR_KEY]: number | null;
};

/** Sum search interest across brands for one trend row (null if none present). */
function sumBrandInterest(
  row: TrendDatum | ChartPoint,
  brands: string[]
): number | null {
  let sum = 0;
  let count = 0;
  for (const brand of brands) {
    const v = row[brand];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
  }
  if (count === 0) return null;
  return Math.round(sum * 10) / 10;
}

const QTD_LOOKBACK_DAYS = 90;

/**
 * Anchor QTD chart to the next earnings date (Yahoo Facts).
 * X-axis: (nextEarnings − 90d) → nextEarnings.
 * Current series: summed active (or all) child-brand search through today;
 * dates after today stay null (countdown blank).
 * Prior-year series: same sum, with LOCF so the dotted line runs to the
 * right edge of the chart.
 */
function buildQtdYoYOverlayData(
  trendRows: TrendDatum[],
  brands: string[],
  nextEarningsIso: string | null | undefined,
  asOf: Date = new Date()
): QtdYoYPoint[] {
  if (brands.length === 0) return [];

  const MS_DAY = 24 * 60 * 60 * 1000;
  const earningsDate =
    nextEarningsIso && nextEarningsIso !== "N/A"
      ? parseIsoDateLocal(nextEarningsIso)
      : null;

  // Fallback when earnings date is unknown: 90d window ending today.
  const windowEnd =
    earningsDate ??
    new Date(
      asOf.getFullYear(),
      asOf.getMonth(),
      asOf.getDate(),
      12,
      0,
      0,
      0
    );
  const windowStart = new Date(windowEnd.getTime() - QTD_LOOKBACK_DAYS * MS_DAY);
  windowStart.setHours(12, 0, 0, 0);

  const todayMs = new Date(
    asOf.getFullYear(),
    asOf.getMonth(),
    asOf.getDate(),
    23,
    59,
    59,
    999
  ).getTime();

  /** date → summed interest across selected brands */
  const interestByDate = new Map<string, number>();
  for (const row of trendRows) {
    const date = normalizeDateString(String(row.date));
    const interest = sumBrandInterest(row, brands);
    if (interest == null) continue;
    interestByDate.set(date, interest);
  }

  /** Exact date hit, else nearest weekly print on or before `iso` (≤10d). */
  const lookupOnOrBefore = (iso: string): number | null => {
    if (interestByDate.has(iso)) return interestByDate.get(iso)!;
    const target = new Date(`${iso}T12:00:00`).getTime();
    let best: { date: string; value: number } | null = null;
    for (const [date, value] of interestByDate) {
      const t = new Date(`${date}T12:00:00`).getTime();
      if (t > target) continue;
      if (target - t > 10 * MS_DAY) continue;
      if (!best || date > best.date) best = { date, value };
    }
    return best?.value ?? null;
  };

  const points: QtdYoYPoint[] = [];
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();
  let lastPriorSum: number | null = null;

  for (let t = startMs; t <= endMs; t += MS_DAY) {
    const noon = new Date(t);
    noon.setHours(12, 0, 0, 0);
    const label = toIsoDateLocal(noon.getTime());
    const dayOffset = Math.round((noon.getTime() - startMs) / MS_DAY);
    const isFuture = noon.getTime() > todayMs;

    const priorLabel = toIsoDateLocal(noon.getTime() - YOY_LAG_DAYS * MS_DAY);
    const priorRaw = lookupOnOrBefore(priorLabel);
    if (priorRaw != null) lastPriorSum = priorRaw;
    // LOCF: carry last known prior-year sum through gaps and to chart end.
    const priorValue = priorRaw ?? lastPriorSum;

    points.push({
      dayOffset,
      label,
      [QTD_CURRENT_KEY]: isFuture ? null : lookupOnOrBefore(label),
      [QTD_PRIOR_KEY]: priorValue,
    });
  }

  return points;
}

function QtdYoYOverlayChart({
  data,
  height = 220,
}: {
  data: QtdYoYPoint[];
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-slate-400"
        style={{ height }}
      >
        No QTD search data in this window.
      </div>
    );
  }

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          style={{ outline: "none" }}
        >
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            type="category"
            tick={{ fill: AXIS_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: AXIS_LINE }}
            minTickGap={28}
            allowDuplicatedCategory={false}
          />
          <YAxis
            domain={[0, "auto"]}
            tick={{ fill: AXIS_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          <Tooltip
            shared
            cursor={{
              stroke: STOCK_STROKE,
              strokeWidth: 1,
              strokeDasharray: "3 3",
              opacity: 0.35,
            }}
            contentStyle={{
              borderRadius: 8,
              border: "1px solid #e2e8f0",
              fontSize: 12,
            }}
            wrapperStyle={{ outline: "none", zIndex: 20 }}
          />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
          <Line
            type="monotone"
            dataKey={QTD_CURRENT_KEY}
            name="Current QTD Search"
            stroke="#1d4ed8"
            strokeWidth={2.5}
            connectNulls
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey={QTD_PRIOR_KEY}
            name="Prior Year QTD Search"
            stroke="#94a3b8"
            strokeWidth={2}
            strokeDasharray="6 4"
            connectNulls
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export type CompanyNewsArticle = {
  uuid: string;
  title: string;
  publisher: string;
  link: string;
  /** Unix seconds, ms, or ISO string from Yahoo. */
  providerPublishTime?: number | string | Date | null;
};

function formatNewsDate(
  value: CompanyNewsArticle["providerPublishTime"]
): string | null {
  if (value == null) return null;
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    // Yahoo may return seconds or ms
    date = new Date(value > 1e12 ? value : value * 1000);
  } else {
    date = new Date(value);
  }
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function RecentNewsPanel({ articles }: { articles: CompanyNewsArticle[] }) {
  return (
    <aside className="flex flex-col rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4">
        <h3 className="text-base font-semibold tracking-tight text-slate-900">
          Recent News
        </h3>
        <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">
          Live headlines · Yahoo Finance
        </p>
      </div>

      {articles.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
          No recent headlines available for this ticker.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {articles.map((article) => {
            const published = formatNewsDate(article.providerPublishTime);
            return (
              <li key={article.uuid || article.link} className="py-3 first:pt-0 last:pb-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {article.publisher}
                  {published ? (
                    <span className="font-normal normal-case tracking-normal text-slate-400">
                      {" · "}
                      {published}
                    </span>
                  ) : null}
                </p>
                <a
                  href={article.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block text-sm font-medium leading-snug text-slate-900 transition hover:text-blue-700"
                >
                  {article.title}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

export default function CompanyTerminal({
  parent,
  initialInsight = null,
  newsArticles = [],
}: {
  parent: ParentCompany;
  initialInsight?: CompanyBrief | null;
  newsArticles?: CompanyNewsArticle[];
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("5Y");
  /** Stock-only by default — user toggles child brands on deliberately. */
  const [activeBrands, setActiveBrands] = useState<string[]>([]);
  const [trendRows, setTrendRows] = useState<TrendDatum[]>([]);
  const [stockMap, setStockMap] = useState<Map<string, number>>(new Map());
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fundamentals, setFundamentals] = useState<FundamentalsState | null>(
    null
  );

  const [insight] = useState<CompanyBrief | null>(initialInsight);
  const [studies, setStudies] = useState<
    { brand: string; result: EventStudyResult }[]
  >([]);

  const tickerEstimates = useMemo(() => {
    const rows = ESTIMATES[parent.ticker] ?? [];
    return sortByDateAsc(rows).reverse(); // newest first for UI
  }, [parent.ticker]);

  useEffect(() => {
    setActiveBrands([]);
  }, [parent.ticker]);

  const loadMarket = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [trends, financeRes, fundamentalsRes] = await Promise.all([
        getTrendData(parent.childBrands),
        fetch(
          `/api/finance?ticker=${encodeURIComponent(parent.ticker)}&timeframe=5Y`
        ),
        fetch(
          `/api/fundamentals?ticker=${encodeURIComponent(parent.ticker)}`
        ),
      ]);

      setTrendRows(trends);

      const finance = (await financeRes.json()) as {
        quotes?: { date: string; close: number }[];
        error?: string;
      };
      if (!financeRes.ok) {
        throw new Error(finance.error ?? "Failed to load stock quotes");
      }

      const map = new Map<string, number>();
      for (const q of finance.quotes ?? []) {
        map.set(normalizeDateString(q.date), q.close);
      }
      setStockMap(map);
      const dates = [...map.keys()].sort();
      const latest = dates.at(-1);
      setLastPrice(latest ? (map.get(latest) ?? null) : null);

      if (fundamentalsRes.ok) {
        const f = (await fundamentalsRes.json()) as FundamentalsState & {
          error?: string;
          lastPrice?: number | null;
        };
        setFundamentals({
          trailingPE: f.trailingPE ?? "N/A",
          forwardPE: f.forwardPE ?? "N/A",
          nextEarnings: f.nextEarnings ?? "N/A",
          recommendationKey: f.recommendationKey ?? "N/A",
        });
        if (f.lastPrice != null && Number.isFinite(f.lastPrice)) {
          setLastPrice(f.lastPrice);
        }
      } else {
        setFundamentals(null);
      }

      // Local event-study markers only (no live Gemini).
      const merged = mergeStockPrices(trends, map, STOCK_KEY);
      const studyResults = parent.childBrands.map((brand) => ({
        brand,
        result: runEventStudy(merged, brand, STOCK_KEY),
      }));
      setStudies(studyResults.filter((s) => s.result.eventCount > 0));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load market data"
      );
    } finally {
      setLoading(false);
    }
  }, [parent.childBrands, parent.ticker]);

  useEffect(() => {
    void loadMarket();
  }, [loadMarket]);

  /**
   * Brands that actually exist as keys in trend data (exact dataKey match for <Line>).
   * Falls back to activeBrands so toggles still reserve series slots while loading.
   */
  const chartBrandKeys = useMemo(() => {
    if (trendRows.length === 0) return activeBrands;
    const available = new Set<string>();
    for (const row of trendRows) {
      for (const key of Object.keys(row)) {
        if (key !== "date" && key !== STOCK_KEY) available.add(key);
      }
    }
    const matched = activeBrands.filter((b) => available.has(b));
    return matched.length > 0 ? matched : activeBrands;
  }, [trendRows, activeBrands]);

  const brandColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    parent.childBrands.forEach((brand, i) => {
      map[brand] = BRAND_COLORS[i % BRAND_COLORS.length];
    });
    return map;
  }, [parent.childBrands]);

  /** Dense weekly base series (no catalyst scatter). */
  const baseChartData = useMemo(() => {
    const merged = mergeStockPrices(trendRows, stockMap, STOCK_KEY);
    const windowed = filterByTimeframe(merged, timeframe);
    // Keys passed here become the object keys on each chart row — must match Line dataKey.
    const aligned = groupAndAlignChartData(
      windowed,
      chartBrandKeys,
      [STOCK_KEY]
    );
    return sortByDateAsc(
      aligned.map(
        (row): TrendDatum => ({
          ...row,
          date: normalizeDateString(String(row.date)),
        })
      )
    );
  }, [trendRows, stockMap, timeframe, chartBrandKeys]);

  /**
   * Full 5Y-aligned series for quarter windows / this-quarter slice
   * (independent of the macro timeframe toggle).
   */
  const fullAlignedData = useMemo(() => {
    const merged = mergeStockPrices(trendRows, stockMap, STOCK_KEY);
    const windowed = filterByTimeframe(merged, "5Y");
    const aligned = groupAndAlignChartData(
      windowed,
      chartBrandKeys,
      [STOCK_KEY]
    );
    return sortByDateAsc(
      aligned.map(
        (row): ChartPoint => ({
          ...row,
          date: normalizeDateString(String(row.date)),
          catalyst: null,
          catalysts: [],
        })
      )
    );
  }, [trendRows, stockMap, chartBrandKeys]);

  /**
   * Single continuous timeline for Recharts: inject catalyst metadata onto
   * matching weekly rows (no separate Scatter / ReferenceDot array).
   */
  const chartData = useMemo((): ChartPoint[] => {
    if (studies.length === 0) {
      return baseChartData.map((row) => ({
        ...row,
        catalyst: null,
        catalysts: [],
      }));
    }

    const chartDates = baseChartData.map((r) =>
      normalizeDateString(String(r.date))
    );
    const byDate = new Map<string, InjectedCatalyst[]>();

    for (const { brand, result } of studies) {
      if (!activeBrands.includes(brand)) continue;
      for (const event of result.events) {
        const snapped = snapToChartDate(event.date, chartDates);
        if (!snapped) continue;
        const entry: InjectedCatalyst = {
          brand,
          sentiment: event.sentiment,
          reason:
            event.reason?.trim() ||
            `${brand} search spike (+${event.increase.toFixed(0)} pts).`,
        };
        const list = byDate.get(snapped) ?? [];
        list.push(entry);
        byDate.set(snapped, list);
      }
    }

    return baseChartData.map((row) => {
      const date = normalizeDateString(String(row.date));
      const catalysts = byDate.get(date) ?? [];
      return {
        ...row,
        date,
        catalysts,
        catalyst: catalysts[0] ?? null,
      };
    });
  }, [baseChartData, studies, activeBrands]);

  const qtdYoYOverlayData = useMemo(() => {
    // Toggle-aware: active brands only; if none toggled, sum ALL child brands.
    const brands =
      activeBrands.length > 0 ? activeBrands : parent.childBrands;
    const nextEarnings =
      fundamentals?.nextEarnings && fundamentals.nextEarnings !== "N/A"
        ? fundamentals.nextEarnings
        : null;
    return buildQtdYoYOverlayData(trendRows, brands, nextEarnings);
  }, [
    activeBrands,
    fundamentals?.nextEarnings,
    parent.childBrands,
    trendRows,
  ]);

  /** Historical ledger: post-2024 Sniper grades when |Δ| ≥ 15. */
  const predictionHistoryRows = useMemo(
    () =>
      buildSniperLedgerRows(tickerEstimates, trendRows, parent.childBrands, {
        minDate: SNIPER_LEDGER_MIN_DATE,
      }),
    [parent.childBrands, tickerEstimates, trendRows]
  );

  const sniperAccuracy = useMemo(
    () => calculateHistoricalSniperAccuracy(predictionHistoryRows),
    [predictionHistoryRows]
  );

  const catalystCount = useMemo(
    () => chartData.reduce((n, row) => n + (row.catalysts?.length ?? 0), 0),
    [chartData]
  );

  const streetConsensus =
    insight?.wallStreetConsensus?.trim() ||
    fundamentals?.recommendationKey ||
    null;

  const chartContext = useMemo((): ChartContext => {
    const briefingParts: string[] = [];

    if (insight?.found && insight.hasAssetProfile) {
      if (insight.terminalVerdict) {
        briefingParts.push(`Terminal verdict: ${insight.terminalVerdict}`);
      }
      if (insight.wallStreetConsensus) {
        briefingParts.push(
          `Wall Street consensus: ${formatWallStreetConsensus(insight.wallStreetConsensus)}`
        );
      }
      if (insight.strategyProfile) {
        briefingParts.push(`Strategy profile: ${insight.strategyProfile}`);
      }
      if (insight.theBuzz) {
        briefingParts.push(`The buzz: ${insight.theBuzz}`);
      }
      if (insight.theRisk) {
        briefingParts.push(`The risk: ${insight.theRisk}`);
      }
    } else if (insight?.found) {
      briefingParts.push(
        `Cached insight (${insight.earningsMismatch ?? insight.sentiment}): ${insight.heroText}`
      );
    }

    for (const { brand, result } of studies) {
      if (result.eventCount > 0) {
        briefingParts.push(
          `${brand}: ${result.eventCount} spikes, avg 90d return ${result.averageReturnPct.toFixed(1)}%`
        );
      }
    }

    return {
      timeframe,
      selectedEntities: activeBrands,
      showSMA: false,
      showStockOverlay: true,
      stockTicker: parent.ticker,
      stockEntities: activeBrands,
      visibleChartData: baseChartData,
      observationCount: chartData.length,
      isLive: isSupabaseConfigured(),
      companyPage: {
        parentName: parent.name,
        ticker: parent.ticker,
        childBrands: parent.childBrands,
        catalystBriefings: briefingParts.join("\n") || "",
      },
    };
  }, [
    activeBrands,
    baseChartData,
    insight,
    chartData.length,
    parent.childBrands,
    parent.name,
    parent.ticker,
    studies,
    timeframe,
  ]);

  const toggleBrand = (brand: string) => {
    setActiveBrands((prev) => {
      if (prev.includes(brand)) {
        return prev.filter((b) => b !== brand);
      }
      return [...prev, brand];
    });
  };

  const peLabel =
    fundamentals?.trailingPE && fundamentals.trailingPE !== "N/A"
      ? fundamentals.trailingPE
      : fundamentals?.forwardPE && fundamentals.forwardPE !== "N/A"
        ? fundamentals.forwardPE
        : "N/A";

  const today = new Date().toISOString().split("T")[0];
  const nextEarningsDate =
    fundamentals?.nextEarnings && fundamentals.nextEarnings !== "N/A"
      ? fundamentals.nextEarnings.slice(0, 10)
      : null;
  const showStaleEarningsBanner = Boolean(
    nextEarningsDate && nextEarningsDate < today
  );

  return (
    <div className="space-y-6 text-slate-900">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="mb-3 inline-flex items-center gap-1.5 text-xs text-slate-500 transition hover:text-blue-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Main Feed
          </Link>
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
              {parent.name}
            </h2>
            <span className="mb-1 rounded-md border border-blue-700/25 bg-blue-50 px-2.5 py-1 font-mono text-sm font-semibold text-blue-800">
              ${parent.ticker}
            </span>
            {lastPrice != null && (
              <span className="mb-1 font-mono text-lg text-slate-800">
                {formatUsd(lastPrice)}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {parent.childBrands.length} child brands — toggle below to overlay
            search interest
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {(["6M", "1Y", "5Y"] as Timeframe[]).map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                timeframe === tf
                  ? "bg-blue-800 text-white"
                  : "border border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {showStaleEarningsBanner && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800"
        >
          ⚠️ Pending Data Update: This company recently reported earnings. We
          are waiting on Yahoo Finance to update the consensus estimates for the
          upcoming quarter.
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-600/30 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {/* Top row: Macro Chart | Yahoo Facts */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
        <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-slate-900">
              Macro Chart
            </h3>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Search vs Stock · {timeframe}
            </p>
          </div>
          <div className="mb-4 h-[340px] w-full sm:h-[400px]">
            {loading && chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-700" />
                Loading chart…
              </div>
            ) : chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                No trend data for these child brands yet.
              </div>
            ) : (
              <div className="h-full w-full outline-none focus:outline-none [&_.recharts-wrapper]:outline-none [&_.recharts-surface]:outline-none [&_svg]:outline-none">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
                    className="outline-none focus:outline-none"
                    style={{ outline: "none" }}
                  >
                    <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      type="category"
                      tick={{ fill: AXIS_TICK, fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: AXIS_LINE }}
                      minTickGap={40}
                      allowDuplicatedCategory={false}
                    />
                    <YAxis
                      yAxisId="left"
                      orientation="left"
                      domain={[0, "auto"]}
                      allowDataOverflow={false}
                      tick={{ fill: AXIS_TICK, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                      label={{
                        value: "Search",
                        angle: -90,
                        position: "insideLeft",
                        fill: "#94a3b8",
                        fontSize: 10,
                      }}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      domain={["auto", "auto"]}
                      tick={{ fill: AXIS_TICK, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      label={{
                        value: "Price",
                        angle: 90,
                        position: "insideRight",
                        fill: "#94a3b8",
                        fontSize: 10,
                      }}
                    />
                    <Tooltip
                      shared
                      cursor={{
                        stroke: STOCK_STROKE,
                        strokeWidth: 1,
                        strokeDasharray: "3 3",
                        opacity: 0.35,
                      }}
                      content={(props) => (
                        <CompanyChartTooltip
                          active={props.active}
                          payload={
                            props.payload as unknown as ChartTooltipProps["payload"]
                          }
                          label={props.label as string | number | undefined}
                        />
                      )}
                      wrapperStyle={{ outline: "none", zIndex: 20 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                    <Area
                      yAxisId="right"
                      type="monotone"
                      dataKey={STOCK_KEY}
                      name={`${parent.ticker} price`}
                      stroke={STOCK_STROKE}
                      fill={STOCK_FILL}
                      fillOpacity={0.12}
                      strokeWidth={1.5}
                      connectNulls
                      dot={false}
                      isAnimationActive={false}
                    />
                    {chartBrandKeys.map((brand) => {
                      const colorIdx = Math.max(
                        0,
                        parent.childBrands.indexOf(brand)
                      );
                      return (
                        <Line
                          key={brand}
                          yAxisId="left"
                          type="monotone"
                          dataKey={brand}
                          name={brand}
                          stroke={
                            BRAND_COLORS[colorIdx % BRAND_COLORS.length]
                          }
                          strokeWidth={2}
                          connectNulls
                          isAnimationActive={false}
                          dot={(dotProps) => (
                            <CustomCatalystDot
                              cx={dotProps.cx}
                              cy={dotProps.cy}
                              payload={
                                dotProps.payload as ChartPoint | undefined
                              }
                              dataKey={brand}
                            />
                          )}
                          activeDot={false}
                        />
                      );
                    })}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {catalystCount > 0 && (
            <p className="mb-3 text-[10px] text-slate-400">
              Markers show event-study catalysts on the weekly timeline — hover
              any date for the explanation.
            </p>
          )}

          <div className="border-t border-slate-200 pt-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Child brand toggles
            </p>
            <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">
              {parent.childBrands.map((brand, i) => {
                const on = activeBrands.includes(brand);
                const color = BRAND_COLORS[i % BRAND_COLORS.length];
                return (
                  <button
                    key={brand}
                    type="button"
                    onClick={() => toggleBrand(brand)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                      on
                        ? "border-transparent text-white"
                        : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                    }`}
                    style={on ? { backgroundColor: color } : undefined}
                  >
                    {brand}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <div className="flex flex-col gap-6">
          <aside className="flex flex-col rounded-xl border border-slate-200 bg-white p-5">
            <div className="mb-4">
              <h3 className="text-base font-semibold tracking-tight text-slate-900">
                Yahoo Facts
              </h3>
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">
                Live fundamentals · ${parent.ticker}
              </p>
            </div>

            <div className="space-y-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  P/E (Trailing)
                </p>
                <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900">
                  {peLabel}
                </p>
                {fundamentals?.forwardPE &&
                  fundamentals.forwardPE !== "N/A" &&
                  fundamentals.forwardPE !== peLabel && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Forward {fundamentals.forwardPE}
                    </p>
                  )}
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Next Earnings
                </p>
                <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-900">
                  {fundamentals?.nextEarnings ?? "—"}
                </p>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Wall Street Consensus
                </p>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${wallStreetBadgeClass(streetConsensus)}`}
                >
                  <Scale className="h-3 w-3 opacity-80" />
                  {formatWallStreetConsensus(streetConsensus)}
                </span>
              </div>
            </div>
          </aside>

          <RecentNewsPanel articles={newsArticles} />
        </div>
      </div>

      {/* Middle row: QTD YoY overlay | Prediction / AI Explanation */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,1fr)]">
        <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-slate-900">
              Quarter-To-Date (QTD)
            </h3>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {fundamentals?.nextEarnings &&
              fundamentals.nextEarnings !== "N/A"
                ? `90d → earnings ${fundamentals.nextEarnings}`
                : "Current vs prior-year search"}
            </p>
          </div>
          <QtdYoYOverlayChart data={qtdYoYOverlayData} height={220} />
        </section>

        <aside
          className={`flex flex-col rounded-xl border p-5 ${directionPanelAccent(insight?.earningsMismatch)}`}
        >
          <div className="mb-4 flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 ring-1 ring-inset ring-blue-700/20">
              <Bot className="h-5 w-5 text-blue-800" />
            </div>
            <div>
              <h3 className="text-base font-semibold tracking-tight text-slate-900">
                Prediction / AI Explanation
              </h3>
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">
                Earnings Whisper · ${parent.ticker}
              </p>
            </div>
          </div>

          {insight?.found &&
          (insight.hasAssetProfile ||
            insight.terminalVerdict ||
            insight.earningsMismatch) ? (
            <div className="space-y-4">
              <section className="rounded-lg border border-slate-200 bg-white/80 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-800">
                    The Delta
                  </p>
                  {insight.earningsMismatch && (
                    <span
                      className={`inline-flex rounded-md border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${directionBadgeClass(insight.earningsMismatch)}`}
                    >
                      {mismatchToAlertBadge(insight.earningsMismatch)}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200">
                  <div className="bg-white px-3 py-4">
                    <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      Wall Street Rev Est
                    </p>
                    <p className="mt-2 font-mono text-xl font-semibold tabular-nums tracking-tight text-slate-900">
                      {formatExpectedRevenueGrowth(
                        insight.expectedRevenueGrowth
                      )}
                    </p>
                  </div>
                  <div className="bg-white px-3 py-4">
                    <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      YoY Search Growth
                    </p>
                    <p className="mt-2 font-mono text-xl font-semibold tabular-nums tracking-tight text-slate-900">
                      {formatSearchGrowthPct(insight.momentumPct)}
                    </p>
                  </div>
                </div>
              </section>

              <section className="rounded-lg border border-slate-200 bg-white/80 p-4">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-800">
                  Terminal Verdict
                </p>
                <p className="text-[15px] font-semibold leading-snug tracking-tight text-slate-900">
                  {formatVerdictText(
                    insight.terminalVerdict ?? insight.heroText
                  )}
                </p>
              </section>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Prediction
              </p>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">
                {INSIGHT_GENERATING_FALLBACK}
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* Historical Sniper — sits between AI Explanation and Prediction History */}
      <aside className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold tracking-tight text-slate-900">
          Historical Sniper
        </h3>
        <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900">
          {sniperAccuracy.label}
        </p>
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          Measures our algorithm&apos;s win rate on high-conviction historical
          setups.
        </p>
      </aside>

      {/* Bottom: Prediction History (Sniper ledger) */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <h3 className="mb-4 text-sm font-semibold tracking-tight text-slate-900">
          Prediction History
        </h3>
        {predictionHistoryRows.length === 0 ? (
          <p className="text-sm text-slate-400">
            No historical estimates for this ticker.
          </p>
        ) : (
          <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[620px] border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="border-b border-slate-200 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Wall St Est</th>
                  <th className="px-3 py-2 font-semibold">Actual Revenue</th>
                  <th className="px-3 py-2 font-semibold">Search YoY</th>
                  <th className="px-3 py-2 font-semibold">Our Prediction</th>
                  <th className="px-3 py-2 font-semibold">Result</th>
                </tr>
              </thead>
              <tbody>
                {predictionHistoryRows.map((row) => (
                  <tr
                    key={row.date}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-3 py-2 font-mono text-slate-700">
                      {row.date}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-slate-800">
                      {formatGrowthPct(row.estimated)}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-slate-800">
                      {formatGrowthPct(row.actual)}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-slate-800">
                      {row.searchYoY != null
                        ? formatGrowthPct(row.searchYoY)
                        : "—"}
                    </td>
                    <td
                      className={`px-3 py-2 font-semibold ${
                        row.prediction
                          ? predictionResultClass(row.prediction)
                          : "text-slate-400"
                      }`}
                    >
                      {row.prediction
                        ? predictionResultLabel(row.prediction)
                        : "—"}
                    </td>
                    <td
                      className={`px-3 py-2 font-semibold ${
                        row.accuracy.correct === true
                          ? "text-green-600"
                          : row.accuracy.correct === false
                            ? "text-red-600"
                            : "text-slate-400"
                      }`}
                    >
                      {row.accuracy.label || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Chat */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <CompanyChat chartContext={chartContext} ticker={parent.ticker} />
      </section>
    </div>
  );
}
