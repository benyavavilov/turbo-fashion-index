"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { EntityCategory, EntityMeta, TrendDatum } from "@/app/actions";
import { getTrendData } from "@/app/actions";
import EntitySelector from "@/app/components/entity-selector";
import EntityLogo from "@/app/components/entity-logo";
import { getBrandTicker } from "@/lib/brand-assets";
import type { ChartContext, Timeframe } from "@/lib/chart-context";
import {
  groupAndAlignChartData,
  mergeStockPrices,
  normalizeDateString,
} from "@/lib/chart-data";

const PALETTE = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#a855f7",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#3b82f6",
  "#14b8a6",
  "#e879f9",
  "#fb7185",
  "#a3e635",
  "#38bdf8",
];

const SMA_WINDOW_DAYS = 90;
const SMA_KEY_SUFFIX = "__sma";
const RATIO_KEY = "ratio";
const RATIO_COLOR = "#2dd4bf"; // neon teal
const STOCK_KEY = "__stock";
const STOCK_COLOR = "#fbbf24"; // neon gold

const TIMEFRAMES: { id: Timeframe; label: string }[] = [
  { id: "6M", label: "6 Months" },
  { id: "1Y", label: "1 Year" },
  { id: "5Y", label: "5 Years" },
];

const SAMPLE_ENTITIES: EntityMeta[] = [
  { name: "Nike", category: "brand" },
  { name: "Lululemon", category: "brand" },
  { name: "Adidas", category: "brand" },
  { name: "Zara", category: "brand" },
  { name: "Gorpcore", category: "trend" },
  { name: "Y2K Fashion", category: "trend" },
  { name: "Quiet Luxury", category: "trend" },
  { name: "Streetwear", category: "trend" },
];

const SAMPLE_DATA: TrendDatum[] = [
  { date: "2025-01", Nike: 78, Lululemon: 62, Adidas: 70, Zara: 66, Gorpcore: 24, "Y2K Fashion": 55, "Quiet Luxury": 30, Streetwear: 61 },
  { date: "2025-02", Nike: 74, Lululemon: 65, Adidas: 68, Zara: 63, Gorpcore: 29, "Y2K Fashion": 58, "Quiet Luxury": 38, Streetwear: 59 },
  { date: "2025-03", Nike: 80, Lululemon: 69, Adidas: 72, Zara: 70, Gorpcore: 35, "Y2K Fashion": 61, "Quiet Luxury": 44, Streetwear: 64 },
  { date: "2025-04", Nike: 83, Lululemon: 74, Adidas: 71, Zara: 72, Gorpcore: 41, "Y2K Fashion": 57, "Quiet Luxury": 52, Streetwear: 66 },
  { date: "2025-05", Nike: 79, Lululemon: 77, Adidas: 75, Zara: 69, Gorpcore: 46, "Y2K Fashion": 60, "Quiet Luxury": 63, Streetwear: 70 },
  { date: "2025-06", Nike: 86, Lululemon: 82, Adidas: 78, Zara: 74, Gorpcore: 52, "Y2K Fashion": 64, "Quiet Luxury": 71, Streetwear: 73 },
];

type TooltipEntry = {
  name: string;
  value: number;
  color: string;
  dataKey?: string;
  payload?: TrendDatum;
};

function smaKey(name: string): string {
  return `${name}${SMA_KEY_SUFFIX}`;
}

function isSmaKey(key: string): boolean {
  return key.endsWith(SMA_KEY_SUFFIX);
}

function displayName(key: string): string {
  return isSmaKey(key) ? `${key.replace(SMA_KEY_SUFFIX, "")} · 90d SMA` : key;
}

function cutoffDate(timeframe: Timeframe): Date {
  const d = new Date();
  if (timeframe === "6M") d.setMonth(d.getMonth() - 6);
  else if (timeframe === "1Y") d.setFullYear(d.getFullYear() - 1);
  else d.setFullYear(d.getFullYear() - 5);
  return d;
}

function filterByTimeframe(data: TrendDatum[], timeframe: Timeframe): TrendDatum[] {
  const cutoff = cutoffDate(timeframe);
  const cutoffTs = cutoff.getTime();

  return data.filter((row) => {
    const ts = new Date(row.date).getTime();
    return !Number.isNaN(ts) && ts >= cutoffTs;
  });
}

/**
 * Calendar-based 90-day simple moving average (~13 weeks on weekly data).
 * Writes smoothed values under `${entityName}__sma` keys.
 */
function applySMA(data: TrendDatum[], series: string[]): TrendDatum[] {
  const parsed = data.map((row) => ({
    row,
    ts: new Date(row.date).getTime(),
  }));

  const windowMs = SMA_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  return parsed.map(({ row, ts }, idx) => {
    const enriched: TrendDatum = { ...row };
    const windowStart = ts - windowMs;

    for (const name of series) {
      const values: number[] = [];
      for (let j = 0; j <= idx; j++) {
        const { row: prior, ts: priorTs } = parsed[j];
        if (priorTs >= windowStart && typeof prior[name] === "number") {
          values.push(prior[name] as number);
        }
      }
      if (values.length > 0) {
        const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
        enriched[smaKey(name)] = Math.round(avg * 10) / 10;
      }
    }

    return enriched;
  });
}

function formatAxisDate(date: string, timeframe: Timeframe): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  if (timeframe === "6M") {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (timeframe === "1Y") {
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function defaultSelection(entities: EntityMeta[]): Set<string> {
  const brands = entities.filter((e) => e.category === "brand").slice(0, 4);
  const trends = entities.filter((e) => e.category === "trend").slice(0, 2);
  return new Set([...brands, ...trends].map((e) => e.name));
}

function defaultRatioPair(entities: EntityMeta[]): {
  numerator: string;
  denominator: string;
} {
  const brands = entities.filter((e) => e.category === "brand");
  return {
    numerator: brands[0]?.name ?? entities[0]?.name ?? "",
    denominator: brands[1]?.name ?? entities[1]?.name ?? "",
  };
}

/** Per-date substitution ratio: numerator interest ÷ denominator interest. */
function computeRatioSeries(
  data: TrendDatum[],
  numerator: string,
  denominator: string
): TrendDatum[] {
  return data
    .map((row) => {
      const num = row[numerator];
      const den = row[denominator];
      if (typeof num !== "number" || typeof den !== "number" || den === 0) {
        return { date: row.date };
      }
      return {
        date: row.date,
        [RATIO_KEY]: Math.round((num / den) * 1000) / 1000,
        __numerator: num,
        __denominator: den,
      };
    })
    .filter((row) => typeof row[RATIO_KEY] === "number");
}

function ratioDomain(data: TrendDatum[]): [number, number] {
  const values = data
    .map((row) => row[RATIO_KEY])
    .filter((v): v is number => typeof v === "number");
  if (values.length === 0) return [0, 2];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 0.5;
  const pad = span * 0.12;
  return [Math.max(0, min - pad), max + pad];
}

function RatioTooltip({
  active,
  payload,
  label,
  numerator,
  denominator,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  numerator: string;
  denominator: string;
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const row = entry?.payload as TrendDatum | undefined;
  const numVal = row?.__numerator;
  const denVal = row?.__denominator;

  return (
    <div className="rounded-lg border border-teal-500/20 bg-neutral-950/95 px-3 py-2.5 shadow-2xl backdrop-blur">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {label}
      </p>
      <div className="flex items-center justify-between gap-8">
        <span className="flex items-center gap-2 text-sm text-teal-300">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: RATIO_COLOR }}
          />
          {numerator} ÷ {denominator}
        </span>
        <span className="font-mono text-sm font-semibold text-teal-100">
          {typeof entry.value === "number" ? entry.value.toFixed(3) : entry.value}
        </span>
      </div>
      {typeof numVal === "number" && typeof denVal === "number" && (
        <p className="mt-2 border-t border-neutral-800 pt-2 text-[11px] text-neutral-500">
          {numerator}: <span className="font-mono text-neutral-400">{numVal}</span>
          {" · "}
          {denominator}: <span className="font-mono text-neutral-400">{denVal}</span>
        </p>
      )}
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  categoryByName,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  categoryByName: Map<string, EntityCategory>;
}) {
  if (!active || !payload?.length) return null;

  const raw = payload.filter((e) => !isSmaKey(String(e.dataKey ?? e.name)));
  const smoothed = payload.filter((e) => isSmaKey(String(e.dataKey ?? e.name)));

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/95 px-3 py-2.5 shadow-2xl backdrop-blur">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {normalizeDateString(String(label ?? ""))}
      </p>
      <div className="space-y-1">
        {[...raw]
          .sort((a, b) => b.value - a.value)
          .map((entry) => {
            const name = displayName(entry.name);
            return (
              <div
                key={entry.name}
                className="flex items-center justify-between gap-8 text-sm"
              >
                <span className="flex items-center gap-2 text-neutral-300">
                  <EntityLogo
                    name={name}
                    category={categoryByName.get(name)}
                    size={14}
                  />
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: entry.color }}
                  />
                  {name}
                </span>
                <span className="font-mono text-xs font-medium text-neutral-100">
                  {entry.value}
                </span>
              </div>
            );
          })}
      </div>
      {smoothed.length > 0 && (
        <div className="mt-2 border-t border-neutral-800 pt-2 space-y-1">
          {smoothed.map((entry) => (
            <div
              key={entry.name}
              className="flex items-center justify-between gap-8 text-xs text-neutral-400"
            >
              <span className="flex items-center gap-2">
                <span
                  className="h-0 w-3 border-t border-dashed"
                  style={{ borderColor: entry.color }}
                />
                {displayName(String(entry.dataKey ?? entry.name))}
              </span>
              <span className="font-mono">{entry.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RatioAnalysisPanel({
  entities,
  numerator,
  denominator,
  ratioMode,
  onNumeratorChange,
  onDenominatorChange,
  onRatioModeChange,
}: {
  entities: EntityMeta[];
  numerator: string;
  denominator: string;
  ratioMode: boolean;
  onNumeratorChange: (name: string) => void;
  onDenominatorChange: (name: string) => void;
  onRatioModeChange: (enabled: boolean) => void;
}) {
  const sorted = useMemo(
    () => [...entities].sort((a, b) => a.name.localeCompare(b.name)),
    [entities]
  );

  const selectClass =
    "w-full rounded-md border border-neutral-800 bg-neutral-900/80 px-3 py-2 text-sm text-neutral-200 outline-none transition-colors focus:border-teal-500/50 focus:ring-1 focus:ring-teal-500/30";

  return (
    <div className="rounded-lg border border-neutral-800/80 bg-neutral-950/50">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800/80 px-4 py-3">
        <div>
          <p className="text-xs font-medium text-neutral-300">
            Substitution Analysis (Ratio)
          </p>
          <p className="text-[11px] text-neutral-500">
            Track premium-to-value sentiment shifts in real time
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2.5">
          <span className="text-xs text-neutral-400">Enable Ratio Mode</span>
          <button
            type="button"
            role="switch"
            aria-checked={ratioMode}
            onClick={() => onRatioModeChange(!ratioMode)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              ratioMode ? "bg-teal-500/80" : "bg-neutral-700"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                ratioMode ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </label>
      </div>

      <div
        className={`grid gap-4 px-4 py-3 transition-opacity md:grid-cols-2 ${
          ratioMode ? "opacity-100" : "opacity-50"
        }`}
      >
        <label className="block space-y-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
            Numerator Entity
          </span>
          <select
            value={numerator}
            onChange={(e) => onNumeratorChange(e.target.value)}
            disabled={!ratioMode}
            className={selectClass}
          >
            {sorted.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
            Denominator Entity
          </span>
          <select
            value={denominator}
            onChange={(e) => onDenominatorChange(e.target.value)}
            disabled={!ratioMode}
            className={selectClass}
          >
            {sorted.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {ratioMode && numerator && denominator && (
        <p className="border-t border-neutral-800/80 px-4 py-2 text-[11px] text-teal-400/80">
          Plotting{" "}
          <span className="font-mono text-teal-300">
            {numerator} ÷ {denominator}
          </span>{" "}
          — values &gt; 1.0 indicate stronger relative search interest in the numerator.
        </p>
      )}
    </div>
  );
}

export default function TrendExplorer({
  entities,
  onChartContextChange,
}: {
  entities: EntityMeta[];
  onChartContextChange?: (ctx: ChartContext) => void;
}) {
  const isLive = entities.length > 0;
  const allEntities = isLive ? entities : SAMPLE_ENTITIES;
  const ratioDefaults = useMemo(() => defaultRatioPair(allEntities), [allEntities]);

  const [timeframe, setTimeframe] = useState<Timeframe>("1Y");
  const [showSMA, setShowSMA] = useState(false);
  const [showStockOverlay, setShowStockOverlay] = useState(false);
  const [ratioMode, setRatioMode] = useState(false);
  const [numerator, setNumerator] = useState(ratioDefaults.numerator);
  const [denominator, setDenominator] = useState(ratioDefaults.denominator);
  const [selected, setSelected] = useState<Set<string>>(() =>
    defaultSelection(allEntities)
  );
  const [sourceData, setSourceData] = useState<TrendDatum[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!numerator && ratioDefaults.numerator) setNumerator(ratioDefaults.numerator);
    if (!denominator && ratioDefaults.denominator) setDenominator(ratioDefaults.denominator);
  }, [ratioDefaults, numerator, denominator]);

  useEffect(() => {
    if (isLive && selected.size === 0) {
      setSelected(defaultSelection(allEntities));
    }
  }, [isLive, allEntities, selected.size]);

  const selectedList = useMemo(
    () => allEntities.map((e) => e.name).filter((name) => selected.has(name)),
    [allEntities, selected]
  );

  const fetchNames = useMemo(() => {
    const names = new Set(selectedList);
    if (ratioMode) {
      if (numerator) names.add(numerator);
      if (denominator) names.add(denominator);
    }
    return [...names].sort();
  }, [selectedList, ratioMode, numerator, denominator]);

  const fetchKey = fetchNames.join("|");

  // Fetch metrics for selected entities (+ ratio pair when ratio mode is on).
  useEffect(() => {
    if (!isLive) {
      setSourceData(SAMPLE_DATA);
      return;
    }

    if (fetchNames.length === 0) {
      setSourceData([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    getTrendData(fetchNames)
      .then((data) => {
        if (!cancelled) setSourceData(data);
      })
      .catch(() => {
        if (!cancelled) setSourceData([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isLive, fetchKey, fetchNames]);

  const colorByName = useMemo(() => {
    const map = new Map<string, string>();
    allEntities.forEach((e, i) => map.set(e.name, PALETTE[i % PALETTE.length]));
    return map;
  }, [allEntities]);

  const categoryByName = useMemo(() => {
    const map = new Map<string, EntityCategory>();
    allEntities.forEach((e) => map.set(e.name, e.category));
    return map;
  }, [allEntities]);

  const stockOverlayEntity = useMemo(() => {
    if (ratioMode) return getBrandTicker(numerator) ? numerator : undefined;
    return selectedList.find((name) => getBrandTicker(name));
  }, [ratioMode, numerator, selectedList]);

  const stockTicker = stockOverlayEntity
    ? getBrandTicker(stockOverlayEntity)
    : undefined;

  const [stockByDate, setStockByDate] = useState<Map<string, number>>(
    () => new Map()
  );
  const [stockError, setStockError] = useState<string | null>(null);

  useEffect(() => {
    if (!showStockOverlay || !stockTicker || ratioMode) {
      setStockByDate(new Map());
      setStockError(null);
      return;
    }

    let cancelled = false;
    setStockError(null);

    fetch(
      `/api/finance?ticker=${encodeURIComponent(stockTicker)}&timeframe=${timeframe}`
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ?? `Finance API error (${res.status})`);
        }
        return data as { quotes?: { date: string; close: number }[] };
      })
      .then((data) => {
        if (cancelled) return;
        const map = new Map<string, number>();
        for (const q of data.quotes ?? []) map.set(q.date, q.close);
        setStockByDate(map);
        if (map.size === 0) {
          setStockError(`No price data returned for ${stockTicker}.`);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setStockByDate(new Map());
          setStockError(
            err instanceof Error ? err.message : "Failed to load stock overlay"
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [showStockOverlay, stockTicker, timeframe, ratioMode]);

  const normalizedFiltered = useMemo(
    () =>
      filterByTimeframe(sourceData, timeframe).map((row) => ({
        ...row,
        date: normalizeDateString(String(row.date)),
      })),
    [sourceData, timeframe]
  );

  const alignedFiltered = useMemo(() => {
    const series = ratioMode
      ? [numerator, denominator].filter(Boolean)
      : selectedList;
    const extra = !ratioMode && showSMA ? selectedList.map(smaKey) : [];
    return groupAndAlignChartData(normalizedFiltered, series, extra);
  }, [
    normalizedFiltered,
    selectedList,
    ratioMode,
    numerator,
    denominator,
    showSMA,
  ]);

  const ratioData = useMemo(() => {
    if (!ratioMode || !numerator || !denominator || numerator === denominator) {
      return [];
    }
    return computeRatioSeries(alignedFiltered, numerator, denominator);
  }, [alignedFiltered, ratioMode, numerator, denominator]);

  const chartDataRaw = useMemo(() => {
    if (ratioMode) return ratioData;
    if (!showSMA || selectedList.length === 0) return alignedFiltered;
    return applySMA(alignedFiltered, selectedList);
  }, [ratioMode, ratioData, alignedFiltered, showSMA, selectedList]);

  const chartData = useMemo(() => {
    if (!showStockOverlay || ratioMode || stockByDate.size === 0) {
      return chartDataRaw;
    }
    return mergeStockPrices(chartDataRaw, stockByDate, STOCK_KEY);
  }, [chartDataRaw, showStockOverlay, stockByDate, ratioMode]);

  const yDomain = useMemo((): [number, number] => {
    if (ratioMode) return ratioDomain(ratioData);
    return [0, 100];
  }, [ratioMode, ratioData]);

  const stockDomain = useMemo((): [number, number] => {
    const values = chartData
      .map((row) => row[STOCK_KEY])
      .filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
    if (values.length === 0) return [0, 100];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || max * 0.1 || 10;
    const pad = span * 0.1;
    return [Math.max(0, min - pad), max + pad];
  }, [chartData]);

  const ratioValid =
    ratioMode &&
    numerator &&
    denominator &&
    numerator !== denominator;

  useEffect(() => {
    onChartContextChange?.({
      timeframe,
      ratioMode,
      numerator: ratioMode ? numerator : undefined,
      denominator: ratioMode ? denominator : undefined,
      selectedEntities: selectedList,
      showSMA,
      showStockOverlay,
      stockOverlayEntity,
      stockTicker,
      recentDataPoints: chartData.slice(-12),
      observationCount: chartData.length,
      isLive,
    });
  }, [
    timeframe,
    ratioMode,
    numerator,
    denominator,
    selectedList,
    showSMA,
    showStockOverlay,
    stockOverlayEntity,
    stockTicker,
    chartData,
    isLive,
    onChartContextChange,
  ]);

  const addEntity = (name: string) => {
    setSelected((prev) => new Set(prev).add(name));
  };

  const removeEntity = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight text-neutral-100">
              Search Interest Index
            </h2>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                isLive
                  ? "bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/30"
                  : "bg-neutral-700/40 text-neutral-400 ring-1 ring-inset ring-neutral-600/40"
              }`}
            >
              {isLive ? "Live" : "Sample"}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-neutral-500">
            Normalized Google Trends index (0–100) · comparative macro analysis
          </p>
        </div>

        <button
          type="button"
          className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-800"
        >
          <Download className="h-4 w-4" />
          Export
        </button>
      </div>

      {/* Research controls */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-neutral-800 bg-neutral-950/60 p-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.id}
              type="button"
              onClick={() => setTimeframe(tf.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                timeframe === tf.id
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <label
          className={`flex cursor-pointer items-center gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-1.5 ${
            ratioMode ? "opacity-40" : ""
          }`}
        >
          <span className="text-xs text-neutral-400">Show Stock Overlay</span>
          <button
            type="button"
            role="switch"
            aria-checked={showStockOverlay}
            disabled={ratioMode || !stockTicker}
            onClick={() => setShowStockOverlay((v) => !v)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              showStockOverlay && !ratioMode ? "bg-amber-500/80" : "bg-neutral-700"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                showStockOverlay && !ratioMode ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </label>

        <label
          className={`flex cursor-pointer items-center gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-1.5 ${
            ratioMode ? "opacity-40" : ""
          }`}
        >
          <span className="text-xs text-neutral-400">90-Day Moving Average</span>
          <button
            type="button"
            role="switch"
            aria-checked={showSMA}
            disabled={ratioMode}
            onClick={() => setShowSMA((v) => !v)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              showSMA && !ratioMode ? "bg-indigo-500/80" : "bg-neutral-700"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                showSMA && !ratioMode ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </label>

        <span className="text-[11px] text-neutral-600">
          {ratioMode
            ? `${ratioData.length} ratio observations`
            : `${chartData.length} observations · ${selectedList.length} series`}
          {showStockOverlay && stockTicker && !ratioMode
            ? ` · ${stockTicker} overlay`
            : ""}
        </span>
      </div>

      {/* Ratio engine */}
      <div className="mb-4">
        <RatioAnalysisPanel
          entities={allEntities}
          numerator={numerator}
          denominator={denominator}
          ratioMode={ratioMode}
          onNumeratorChange={setNumerator}
          onDenominatorChange={setDenominator}
          onRatioModeChange={(enabled) => {
            setRatioMode(enabled);
            if (enabled) setShowSMA(false);
          }}
        />
      </div>

      {/* Entity selector */}
      <EntitySelector
        entities={allEntities}
        selected={selected}
        onAdd={addEntity}
        onRemove={removeEntity}
        disabled={ratioMode}
      />

      {showStockOverlay && !ratioMode && stockTicker && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <span
            className="h-2 w-6 rounded-sm"
            style={{ backgroundColor: STOCK_COLOR }}
          />
          <span className="text-xs font-medium text-amber-200">
            Overlay: ${stockTicker} Stock Price
            {stockOverlayEntity ? ` · ${stockOverlayEntity}` : ""}
          </span>
          {stockError && (
            <span className="text-xs text-rose-400">({stockError})</span>
          )}
        </div>
      )}

      {/* Chart */}
      <div className="h-96 w-full rounded-lg border border-neutral-800/60 bg-neutral-950/30 p-2">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Loading series…
          </div>
        ) : ratioMode && !ratioValid ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            Select distinct numerator and denominator entities.
          </div>
        ) : !ratioMode && selectedList.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            Select at least one entity to plot.
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            No data in this timeframe.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 12, right: showStockOverlay && !ratioMode ? 56 : 16, left: ratioMode ? 4 : 0, bottom: 4 }}
            >
              <defs>
                <linearGradient id="stockGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={STOCK_COLOR} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={STOCK_COLOR} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#262626"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                stroke="#525252"
                fontSize={11}
                tickLine={false}
                axisLine={{ stroke: "#262626" }}
                tickFormatter={(value) => formatAxisDate(String(value), timeframe)}
                minTickGap={32}
              />
              <YAxis
                yAxisId="left"
                domain={yDomain}
                stroke="#525252"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={ratioMode ? 44 : 36}
                tickFormatter={(v) =>
                  ratioMode ? Number(v).toFixed(1) : String(v)
                }
              />
              {showStockOverlay && !ratioMode && stockTicker && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={stockDomain}
                  stroke={STOCK_COLOR}
                  fontSize={10}
                  tickLine={false}
                  axisLine={{ stroke: STOCK_COLOR, strokeOpacity: 0.35 }}
                  width={52}
                  tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                />
              )}
              {ratioMode ? (
                <Tooltip
                  content={
                    <RatioTooltip
                      numerator={numerator}
                      denominator={denominator}
                    />
                  }
                  cursor={{ stroke: RATIO_COLOR, strokeWidth: 1, strokeOpacity: 0.4 }}
                />
              ) : (
                <Tooltip
                  content={<ChartTooltip categoryByName={categoryByName} />}
                  cursor={{ stroke: "#404040", strokeWidth: 1 }}
                />
              )}
              {showStockOverlay && !ratioMode && stockTicker && (
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey={STOCK_KEY}
                  name={`$${stockTicker} Stock Price`}
                  stroke={STOCK_COLOR}
                  strokeWidth={2}
                  fill="url(#stockGradient)"
                  fillOpacity={1}
                  connectNulls
                  dot={false}
                  activeDot={{ r: 4, fill: STOCK_COLOR }}
                  isAnimationActive={false}
                />
              )}
              {ratioMode ? (
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey={RATIO_KEY}
                  name={`${numerator} ÷ ${denominator}`}
                  stroke={RATIO_COLOR}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, fill: RATIO_COLOR }}
                  connectNulls
                />
              ) : (
                <>
                  {selectedList.map((name) => (
                    <Line
                      key={name}
                      yAxisId="left"
                      type="monotone"
                      dataKey={name}
                      name={name}
                      stroke={colorByName.get(name)}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls
                    />
                  ))}
                  {showSMA &&
                    selectedList.map((name) => (
                      <Line
                        key={smaKey(name)}
                        yAxisId="left"
                        type="monotone"
                        dataKey={smaKey(name)}
                        name={smaKey(name)}
                        stroke={colorByName.get(name)}
                        strokeWidth={1.5}
                        strokeDasharray="6 4"
                        strokeOpacity={0.75}
                        dot={false}
                        activeDot={{ r: 3 }}
                        connectNulls
                      />
                    ))}
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Active series legend */}
      {ratioMode && ratioValid && ratioData.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-neutral-800/80 pt-4">
          <span className="flex items-center gap-2 text-[11px] text-neutral-400">
            <span
              className="h-2 w-6 rounded-sm"
              style={{ backgroundColor: RATIO_COLOR }}
            />
            <span className="font-mono text-teal-300">
              {numerator} ÷ {denominator}
            </span>
            <span className="text-neutral-600">substitution ratio</span>
          </span>
        </div>
      ) : (
        selectedList.length > 0 &&
        !ratioMode && (
          <div className="mt-4 flex flex-wrap gap-3 border-t border-neutral-800/80 pt-4">
            {selectedList.map((name) => (
              <span
                key={name}
                className="flex items-center gap-2 text-[11px] text-neutral-400"
              >
                <span
                  className="h-2 w-4 rounded-sm"
                  style={{ backgroundColor: colorByName.get(name) }}
                />
                <span className="font-mono text-neutral-300">{name}</span>
                {showSMA && (
                  <span className="text-neutral-600">
                    +{" "}
                    <span
                      className="inline-block w-3 border-t border-dashed align-middle"
                      style={{ borderColor: colorByName.get(name) }}
                    />{" "}
                    SMA
                  </span>
                )}
              </span>
            ))}
          </div>
        )
      )}
    </section>
  );
}
