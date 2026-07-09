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
  consolidateRowsByDate,
  filterByTimeframe,
  groupAndAlignChartData,
  mergeStockPricesForEntities,
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
const STOCK_COLOR = "#fbbf24"; // neon gold
/** Always fetch full stock history; UI timeframe is applied after merge. */
const STOCK_FETCH_TIMEFRAME = "5Y";

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

function stockKey(name: string): string {
  return `${name}__stock`;
}

function isSmaKey(key: string): boolean {
  return key.endsWith(SMA_KEY_SUFFIX);
}

function isStockKey(key: string): boolean {
  return key.endsWith("__stock");
}

function displayName(key: string): string {
  return isSmaKey(key) ? `${key.replace(SMA_KEY_SUFFIX, "")} · 90d SMA` : key;
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

  const raw = payload.filter(
    (e) =>
      !isSmaKey(String(e.dataKey ?? e.name)) &&
      !isStockKey(String(e.dataKey ?? e.name))
  );
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
  const [smaEnabled, setSmaEnabled] = useState<Set<string>>(() => new Set());
  const [stockEnabled, setStockEnabled] = useState<Set<string>>(() => new Set());
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

  const smaEntities = useMemo(
    () => selectedList.filter((name) => smaEnabled.has(name)),
    [selectedList, smaEnabled]
  );

  const stockEntities = useMemo(() => {
    if (ratioMode) return [];
    return selectedList.filter(
      (name) => stockEnabled.has(name) && Boolean(getBrandTicker(name))
    );
  }, [selectedList, stockEnabled, ratioMode]);

  const [stockByEntity, setStockByEntity] = useState<
    Record<string, Map<string, number>>
  >({});
  const [stockErrors, setStockErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (stockEntities.length === 0) {
      setStockByEntity({});
      setStockErrors({});
      return;
    }

    let cancelled = false;
    setStockErrors({});

    Promise.allSettled(
      stockEntities.map(async (name) => {
        const ticker = getBrandTicker(name)!;
        const res = await fetch(
          `/api/finance?ticker=${encodeURIComponent(ticker)}&timeframe=${STOCK_FETCH_TIMEFRAME}`
        );
        const data = (await res.json()) as {
          error?: string;
          quotes?: { date: string; close: number }[];
        };
        if (!res.ok) {
          throw new Error(data.error ?? `Finance API error (${res.status})`);
        }
        const map = new Map<string, number>();
        for (const q of data.quotes ?? []) map.set(q.date, q.close);
        return { name, ticker, map };
      })
    )
      .then((results) => {
        if (cancelled) return;
        const byEntity: Record<string, Map<string, number>> = {};
        const errors: Record<string, string> = {};
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const name = stockEntities[i];
          if (result.status === "fulfilled") {
            const { ticker, map } = result.value;
            byEntity[name] = map;
            if (map.size === 0) {
              errors[name] = `No price data returned for ${ticker}.`;
            }
          } else {
            errors[name] =
              result.reason instanceof Error
                ? result.reason.message
                : "Failed to load stock overlay";
          }
        }
        setStockByEntity(byEntity);
        setStockErrors(errors);
      });

    return () => {
      cancelled = true;
    };
  }, [stockEntities]);

  const normalizedAll = useMemo(
    () =>
      sourceData.map((row) => ({
        ...row,
        date: normalizeDateString(String(row.date)),
      })),
    [sourceData]
  );

  const alignedAll = useMemo(() => {
    const series = ratioMode
      ? [numerator, denominator].filter(Boolean)
      : selectedList;
    const extra = !ratioMode ? smaEntities.map(smaKey) : [];
    return groupAndAlignChartData(normalizedAll, series, extra);
  }, [
    normalizedAll,
    selectedList,
    ratioMode,
    numerator,
    denominator,
    smaEntities,
  ]);

  const normalizedFiltered = useMemo(
    () => filterByTimeframe(normalizedAll, timeframe),
    [normalizedAll, timeframe]
  );

  const alignedFiltered = useMemo(() => {
    const series = ratioMode
      ? [numerator, denominator].filter(Boolean)
      : selectedList;
    const extra = !ratioMode ? smaEntities.map(smaKey) : [];
    return groupAndAlignChartData(normalizedFiltered, series, extra);
  }, [
    normalizedFiltered,
    selectedList,
    ratioMode,
    numerator,
    denominator,
    smaEntities,
  ]);

  const ratioData = useMemo(() => {
    if (!ratioMode || !numerator || !denominator || numerator === denominator) {
      return [];
    }
    return computeRatioSeries(alignedFiltered, numerator, denominator);
  }, [alignedFiltered, ratioMode, numerator, denominator]);

  const chartDataRaw = useMemo(() => {
    if (ratioMode) return consolidateRowsByDate(ratioData);

    const withSma =
      smaEntities.length === 0
        ? alignedAll
        : applySMA(alignedAll, smaEntities);

    const stockMaps: Record<string, Map<string, number>> = {};
    for (const name of stockEntities) {
      const prices = stockByEntity[name];
      if (prices instanceof Map && prices.size > 0) {
        stockMaps[name] = prices;
      }
    }

    const merged =
      Object.keys(stockMaps).length > 0
        ? mergeStockPricesForEntities(withSma, stockMaps, stockKey)
        : consolidateRowsByDate(withSma);

    return filterByTimeframe(merged, timeframe);
  }, [
    ratioMode,
    ratioData,
    alignedAll,
    smaEntities,
    stockEntities,
    stockByEntity,
    timeframe,
  ]);

  const chartData = chartDataRaw;

  const activeStockEntities = useMemo(
    () =>
      stockEntities.filter((name) =>
        chartData.some((row) => {
          const value = row[stockKey(name)];
          return typeof value === "number" && !Number.isNaN(value);
        })
      ),
    [stockEntities, chartData]
  );

  const hasStockSeries = activeStockEntities.length > 0;

  const yDomain = useMemo((): [number, number] => {
    if (ratioMode) return ratioDomain(ratioData);
    return [0, 100];
  }, [ratioMode, ratioData]);

  const stockDomain = useMemo((): [number, number] => {
    if (!hasStockSeries) return [0, 100];
    const values: number[] = [];
    for (const name of activeStockEntities) {
      const key = stockKey(name);
      for (const row of chartData) {
        const value = row[key];
        if (typeof value === "number" && !Number.isNaN(value)) values.push(value);
      }
    }
    if (values.length === 0) return [0, 100];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || max * 0.1 || 10;
    const pad = span * 0.1;
    return [Math.max(0, min - pad), max + pad];
  }, [chartData, hasStockSeries, activeStockEntities]);

  const ratioValid =
    ratioMode &&
    numerator &&
    denominator &&
    numerator !== denominator;

  useEffect(() => {
    const primaryStock = activeStockEntities[0];
    onChartContextChange?.({
      timeframe,
      ratioMode,
      numerator: ratioMode ? numerator : undefined,
      denominator: ratioMode ? denominator : undefined,
      selectedEntities: selectedList,
      showSMA: smaEntities.length > 0,
      smaEntities,
      showStockOverlay: activeStockEntities.length > 0,
      stockOverlayEntity: primaryStock,
      stockTicker: primaryStock ? getBrandTicker(primaryStock) : undefined,
      stockEntities: activeStockEntities,
      visibleChartData: chartData,
      observationCount: chartData.length,
      isLive,
    });
  }, [
    timeframe,
    ratioMode,
    numerator,
    denominator,
    selectedList,
    smaEntities,
    activeStockEntities,
    chartData,
    isLive,
    onChartContextChange,
  ]);

  const toggleSma = (name: string) => {
    setSmaEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleStock = (name: string) => {
    setStockEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const addEntity = (name: string) => {
    setSelected((prev) => new Set(prev).add(name));
  };

  const removeEntity = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    setSmaEnabled((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    setStockEnabled((prev) => {
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

        <span className="text-[11px] text-neutral-600">
          {ratioMode
            ? `${ratioData.length} ratio observations`
            : `${chartData.length} observations · ${selectedList.length} series`}
          {activeStockEntities.length > 0 && !ratioMode
            ? ` · ${activeStockEntities.length} stock overlay${activeStockEntities.length > 1 ? "s" : ""}`
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
            if (enabled) {
              setSmaEnabled(new Set());
              setStockEnabled(new Set());
            }
          }}
        />
      </div>

      {/* Entity selector */}
      <EntitySelector
        entities={allEntities}
        selected={selected}
        smaEnabled={smaEnabled}
        stockEnabled={stockEnabled}
        onAdd={addEntity}
        onRemove={removeEntity}
        onToggleSma={toggleSma}
        onToggleStock={toggleStock}
        disabled={ratioMode}
      />

      {activeStockEntities.length > 0 && !ratioMode && (
        <div className="mb-3 space-y-2">
          {stockErrors._fetch && (
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-400">
              {stockErrors._fetch}
            </div>
          )}
          {activeStockEntities.map((name) => {
            const ticker = getBrandTicker(name);
            const error = stockErrors[name];
            return (
              <div
                key={name}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2"
              >
                <span
                  className="h-2 w-6 rounded-sm"
                  style={{ backgroundColor: colorByName.get(name) ?? STOCK_COLOR }}
                />
                <span className="text-xs font-medium text-amber-200">
                  Overlay: ${ticker} Stock Price · {name}
                </span>
                {error && (
                  <span className="text-xs text-rose-400">({error})</span>
                )}
              </div>
            );
          })}
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
              margin={{ top: 12, right: hasStockSeries && !ratioMode ? 56 : 16, left: ratioMode ? 4 : 0, bottom: 4 }}
            >
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
              {hasStockSeries && !ratioMode && (
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
              {activeStockEntities.map((name) => {
                const ticker = getBrandTicker(name);
                const key = stockKey(name);
                const stroke = colorByName.get(name) ?? STOCK_COLOR;
                return (
                  <Area
                    key={key}
                    yAxisId="right"
                    type="monotone"
                    dataKey={key}
                    name={`$${ticker} Stock · ${name}`}
                    stroke={stroke}
                    strokeWidth={2}
                    fill={stroke}
                    fillOpacity={0.12}
                    connectNulls
                    dot={false}
                    activeDot={{ r: 4, fill: stroke }}
                    isAnimationActive={false}
                  />
                );
              })}
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
                  {smaEntities.map((name) => (
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
                {smaEnabled.has(name) && (
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
