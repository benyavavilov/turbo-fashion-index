"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Loader2,
  RefreshCw,
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
import type { ParentCompany } from "@/lib/entities";
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
  runEventStudyWithSentiment,
  type EventStudyEvent,
  type EventStudyResult,
} from "@/lib/event-study";
import { formatUsd } from "@/lib/paper-portfolio";
import { isSupabaseConfigured } from "@/lib/supabase";

const STOCK_KEY = "__stock";
const BRAND_COLORS = [
  "#38bdf8",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#fb7185",
  "#2dd4bf",
  "#c084fc",
];

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
  [key: string]: string | number | null | undefined | InjectedCatalyst | InjectedCatalyst[];
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

function sortByDateAsc<T extends { date: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      new Date(normalizeDateString(String(a.date))).getTime() -
      new Date(normalizeDateString(String(b.date))).getTime()
  );
}

function sentimentClass(s?: string) {
  if (s === "POSITIVE")
    return "border-emerald-500/35 bg-emerald-500/15 text-emerald-300";
  if (s === "NEGATIVE")
    return "border-rose-500/35 bg-rose-500/15 text-rose-300";
  return "border-neutral-600/50 bg-neutral-800/70 text-neutral-300";
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

function CatalystTooltipCard({
  catalysts,
  date,
}: {
  catalysts: InjectedCatalyst[];
  date: string;
}) {
  return (
    <div className="max-w-[280px] rounded-lg border border-amber-500/35 bg-neutral-950/95 px-3 py-2 shadow-xl">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">
        Catalyst Event
      </p>
      {catalysts.map((c) => (
        <div key={`${c.brand}-${c.reason.slice(0, 24)}`} className="mt-2 first:mt-1">
          <p className="font-mono text-[10px] text-neutral-500">
            {date} · {c.brand}
            {c.sentiment ? ` · ${c.sentiment}` : ""}
          </p>
          <p className="mt-1 text-xs leading-snug text-neutral-200">{c.reason}</p>
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
  const fill = negative ? "#fb7185" : "#34d399";
  const glow = negative ? "rgba(251,113,133,0.55)" : "rgba(52,211,153,0.55)";

  return (
    <g style={{ pointerEvents: "none" }}>
      <circle cx={cx} cy={cy} r={10} fill={glow} opacity={0.4} />
      <circle
        cx={cx}
        cy={cy}
        r={5}
        fill={fill}
        stroke="#0a0a0a"
        strokeWidth={1.5}
      />
      <circle cx={cx} cy={cy} r={2} fill="#fafafa" />
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
    <div className="rounded-lg border border-neutral-700 bg-neutral-950/95 px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-mono text-[10px] text-neutral-500">{label}</p>
      {seriesRows.map((p) => (
        <p key={String(p.dataKey)} className="text-neutral-300">
          <span style={{ color: String(p.color) }}>{p.name}</span>:{" "}
          <span className="font-mono">
            {typeof p.value === "number" ? p.value.toFixed(1) : p.value}
          </span>
        </p>
      ))}
    </div>
  );
}

export default function CompanyTerminal({
  parent,
}: {
  parent: ParentCompany;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1Y");
  const [activeBrands, setActiveBrands] = useState<string[]>(
    parent.childBrands.slice(0, Math.min(2, parent.childBrands.length))
  );
  const [trendRows, setTrendRows] = useState<TrendDatum[]>([]);
  const [stockMap, setStockMap] = useState<Map<string, number>>(new Map());
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [briefLoading, setBriefLoading] = useState(false);
  const [brief, setBrief] = useState<{
    headline: string;
    sentiment: string;
    bullets: string[];
  } | null>(null);
  const [studies, setStudies] = useState<
    { brand: string; result: EventStudyResult }[]
  >([]);
  const [studyLoading, setStudyLoading] = useState(false);

  const loadMarket = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [trends, financeRes] = await Promise.all([
        getTrendData(parent.childBrands),
        fetch(
          `/api/finance?ticker=${encodeURIComponent(parent.ticker)}&timeframe=5Y`
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

  /** Dense weekly base series (no catalyst scatter). */
  const baseChartData = useMemo(() => {
    const merged = mergeStockPrices(trendRows, stockMap, STOCK_KEY);
    const windowed = filterByTimeframe(merged, timeframe);
    const aligned = groupAndAlignChartData(windowed, activeBrands, [STOCK_KEY]);
    return sortByDateAsc(
      aligned.map(
        (row): TrendDatum => ({
          ...row,
          date: normalizeDateString(String(row.date)),
        })
      )
    );
  }, [trendRows, stockMap, timeframe, activeBrands]);

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

  const catalystCount = useMemo(
    () => chartData.reduce((n, row) => n + (row.catalysts?.length ?? 0), 0),
    [chartData]
  );

  const chartContext = useMemo((): ChartContext => {
    const briefingParts: string[] = [];

    if (brief) {
      briefingParts.push(
        `Analyst brief (${brief.sentiment}): ${brief.headline}`,
        ...brief.bullets.map((b) => `• ${b}`)
      );
    }

    for (const { brand, result } of studies) {
      const dated = result.events
        .filter((e: EventStudyEvent) => e.reason || e.sentiment)
        .map(
          (e) =>
            `${e.date} [${e.sentiment ?? "n/a"}] ${brand}: ${e.reason ?? "spike"} (90d return ${e.returnPct.toFixed(1)}%)`
        );
      if (dated.length) {
        briefingParts.push(`${brand} catalysts:`, ...dated);
      } else if (result.eventCount > 0) {
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
    brief,
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
        if (prev.length === 1) return prev;
        return prev.filter((b) => b !== brand);
      }
      return [...prev, brand];
    });
  };

  const runAnalyst = async () => {
    if (briefLoading || studyLoading) return;
    setBriefLoading(true);
    setStudyLoading(true);
    setBrief(null);

    try {
      const merged = mergeStockPrices(trendRows, stockMap, STOCK_KEY);
      const activeSet = new Set(activeBrands);

      const studyResults = await Promise.all(
        parent.childBrands.map(async (brand) => {
          if (activeSet.has(brand)) {
            const result = await runEventStudyWithSentiment(
              merged,
              brand,
              STOCK_KEY
            );
            return { brand, result };
          }
          return {
            brand,
            result: runEventStudy(merged, brand, STOCK_KEY),
          };
        })
      );

      const withEvents = studyResults.filter((s) => s.result.eventCount > 0);
      setStudies(withEvents);
      setStudyLoading(false);

      const summary = withEvents
        .map(({ brand, result }) => {
          const latest = [...result.events].sort((a, b) =>
            b.date.localeCompare(a.date)
          )[0];
          return (
            `${brand}: ${result.eventCount} spikes, avg ${result.averageReturnPct.toFixed(1)}% 90d` +
            (latest?.sentiment
              ? `, latest ${latest.sentiment} (${latest.reason ?? ""})`
              : "")
          );
        })
        .join("\n");

      const res = await fetch("/api/company-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: parent.ticker,
          eventStudySummary: summary,
        }),
      });
      const data = (await res.json()) as {
        headline?: string;
        sentiment?: string;
        bullets?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Brief failed");
      setBrief({
        headline: data.headline ?? `${parent.name} brief`,
        sentiment: data.sentiment ?? "NEUTRAL",
        bullets: data.bullets ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analyst failed");
      setStudyLoading(false);
    } finally {
      setBriefLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="mb-3 inline-flex items-center gap-1.5 text-xs text-neutral-500 transition hover:text-neutral-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Alpha Feed
          </Link>
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="text-2xl font-semibold tracking-tight text-neutral-50 sm:text-3xl">
              {parent.name}
            </h2>
            <span className="mb-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 font-mono text-sm font-semibold text-indigo-300">
              ${parent.ticker}
            </span>
            {lastPrice != null && (
              <span className="mb-1 font-mono text-lg text-neutral-200">
                {formatUsd(lastPrice)}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-neutral-500">
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
                  ? "bg-neutral-100 text-neutral-900"
                  : "border border-neutral-700 text-neutral-400 hover:bg-neutral-900"
              }`}
            >
              {tf}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void loadMarket()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900 disabled:opacity-40"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]">
        <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4 sm:p-5">
          <div className="mb-4 h-[380px] w-full sm:h-[440px]">
            {loading && chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin text-indigo-400" />
                Loading chart…
              </div>
            ) : chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-neutral-500">
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
                    <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      type="category"
                      tick={{ fill: "#737373", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "#404040" }}
                      minTickGap={40}
                      allowDuplicatedCategory={false}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fill: "#737373", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                      label={{
                        value: "Search",
                        angle: -90,
                        position: "insideLeft",
                        fill: "#525252",
                        fontSize: 10,
                      }}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fill: "#737373", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      label={{
                        value: "Price",
                        angle: 90,
                        position: "insideRight",
                        fill: "#525252",
                        fontSize: 10,
                      }}
                    />
                    <Tooltip
                      shared
                      cursor={{
                        stroke: "#ffffff",
                        strokeWidth: 1,
                        strokeDasharray: "3 3",
                        opacity: 0.3,
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
                      stroke="#6366f1"
                      fill="#6366f1"
                      fillOpacity={0.12}
                      strokeWidth={1.5}
                      connectNulls
                      dot={false}
                      isAnimationActive={false}
                    />
                    {activeBrands.map((brand, i) => (
                      <Line
                        key={brand}
                        yAxisId="left"
                        type="monotone"
                        dataKey={brand}
                        name={brand}
                        stroke={BRAND_COLORS[i % BRAND_COLORS.length]}
                        strokeWidth={2}
                        connectNulls
                        isAnimationActive={false}
                        dot={(dotProps) => (
                          <CustomCatalystDot
                            cx={dotProps.cx}
                            cy={dotProps.cy}
                            payload={dotProps.payload as ChartPoint | undefined}
                            dataKey={brand}
                          />
                        )}
                        activeDot={false}
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {catalystCount > 0 && (
            <p className="mb-3 text-[10px] text-neutral-600">
              Glowing dots mark event-study catalysts on the continuous weekly
              timeline — hover any date for the explanation.
            </p>
          )}

          <div className="border-t border-neutral-800/80 pt-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
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
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      on
                        ? "border-transparent text-neutral-950"
                        : "border-neutral-700 bg-transparent text-neutral-400 hover:border-neutral-500"
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

        <aside className="flex flex-col rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/15 ring-1 ring-inset ring-violet-500/30">
              <Bot className="h-5 w-5 text-violet-300" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-neutral-100">
                AI Analyst
              </h3>
              <p className="text-xs text-neutral-500">
                Gemini sentiment on {parent.name} + child brand momentum
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void runAnalyst()}
            disabled={briefLoading || loading || trendRows.length === 0}
            className="mb-4 inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {briefLoading || studyLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Bot className="h-3.5 w-3.5" />
            )}
            {briefLoading || studyLoading
              ? "Running event study + brief…"
              : "Analyze Parent & Brands"}
          </button>

          {brief ? (
            <div className="space-y-3">
              <span
                className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold ${sentimentClass(brief.sentiment)}`}
              >
                {brief.sentiment}
              </span>
              <h4 className="text-sm font-semibold text-neutral-100">
                {brief.headline}
              </h4>
              <ul className="space-y-2 text-xs leading-relaxed text-neutral-400">
                {brief.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-violet-400/80" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-neutral-500">
              Run analysis to plot catalyst markers on the chart and generate a
              Gemini company brief. Active toggles get full sentiment enrichment.
            </p>
          )}

          {studies.length > 0 && (
            <div className="mt-5 max-h-40 space-y-2 overflow-y-auto border-t border-neutral-800 pt-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
                Event study snapshot
              </p>
              {studies.map(({ brand, result }) => (
                <div
                  key={brand}
                  className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-neutral-200">
                      {brand}
                    </span>
                    <span
                      className={`font-mono text-[11px] ${
                        result.averageReturnPct >= 0
                          ? "text-emerald-400"
                          : "text-rose-400"
                      }`}
                    >
                      {result.averageReturnPct >= 0 ? "+" : ""}
                      {result.averageReturnPct.toFixed(1)}% avg
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-neutral-600">
                    {result.eventCount} spikes · {result.positiveEventCount} pos
                    / {result.negativeEventCount} neg
                  </p>
                </div>
              ))}
            </div>
          )}

          <CompanyChat chartContext={chartContext} ticker={parent.ticker} />
        </aside>
      </div>
    </div>
  );
}
