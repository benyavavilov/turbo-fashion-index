"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { EntityCategory, EntityMeta } from "@/lib/entities";
import type { TrendDatum } from "@/lib/chart-data";
import { getTrendData } from "@/app/actions";
import EntitySelector from "@/app/components/entity-selector";
import EntityLogo from "@/app/components/entity-logo";
import QuantitativeTools from "@/app/components/quantitative-tools";
import AlphaStrategiesDashboard from "@/app/components/alpha-strategies-dashboard";
import PaperPortfolioPanel from "@/app/components/paper-portfolio-panel";
import { getBrandTicker } from "@/lib/brand-assets";
import type { ChartContext, PinnedDataPoint, Timeframe } from "@/lib/chart-context";
import { getEntityByName } from "@/lib/entities";
import {
  consolidateRowsByDate,
  filterByTimeframe,
  groupAndAlignChartData,
  mergeStockPricesForEntities,
  normalizeDateString,
} from "@/lib/chart-data";
import { calculatePearson } from "@/lib/math";
import { runEventStudyWithSentiment } from "@/lib/event-study";

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
const STOCK_COLOR = "#fbbf24"; // neon gold
/** Always fetch full stock history; UI timeframe is applied after merge. */
const STOCK_FETCH_TIMEFRAME = "5Y";

const TIMEFRAMES: { id: Timeframe; label: string }[] = [
  { id: "6M", label: "6 Months" },
  { id: "1Y", label: "1 Year" },
  { id: "5Y", label: "5 Years" },
];

const SAMPLE_DATA: TrendDatum[] = [
  { date: "2025-01", Nike: 78, Lululemon: 62, Adidas: 70, Gorpcore: 24, "Y2K Fashion": 55 },
  { date: "2025-02", Nike: 74, Lululemon: 65, Adidas: 68, Gorpcore: 29, "Y2K Fashion": 58 },
  { date: "2025-03", Nike: 80, Lululemon: 69, Adidas: 72, Gorpcore: 35, "Y2K Fashion": 61 },
  { date: "2025-04", Nike: 83, Lululemon: 74, Adidas: 71, Gorpcore: 41, "Y2K Fashion": 57 },
  { date: "2025-05", Nike: 79, Lululemon: 77, Adidas: 75, Gorpcore: 46, "Y2K Fashion": 60 },
  { date: "2025-06", Nike: 86, Lululemon: 82, Adidas: 78, Gorpcore: 52, "Y2K Fashion": 64 },
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


function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatLabelWithTicker(entityName: string): string {
  const ticker = getBrandTicker(entityName);
  if (!ticker) return displayName(entityName);
  return `${displayName(entityName)} ($${ticker})`;
}

function buildPinnedFromRow(
  row: TrendDatum,
  selectedList: string[],
  smaEnabled: Set<string>,
  stockEnabled: Set<string>
): PinnedDataPoint {
  const values: Record<string, number> = {};

  for (const name of selectedList) {
    const trend = row[name];
    if (typeof trend === "number" && !Number.isNaN(trend)) {
      values[name] = trend;
    }
    if (smaEnabled.has(name)) {
      const sma = row[smaKey(name)];
      if (typeof sma === "number" && !Number.isNaN(sma)) {
        values[smaKey(name)] = sma;
      }
    }
    if (stockEnabled.has(name) && getBrandTicker(name)) {
      const stock = row[stockKey(name)];
      if (typeof stock === "number" && !Number.isNaN(stock)) {
        values[stockKey(name)] = stock;
      }
    }
  }

  return { date: String(row.date), values };
}

function extractPairedTrendStock(
  data: TrendDatum[],
  brand: string
): { trends: number[]; stocks: number[] } {
  const trends: number[] = [];
  const stocks: number[] = [];
  const sk = stockKey(brand);

  for (const row of data) {
    const trend = row[brand];
    const stock = row[sk];
    if (
      typeof trend === "number" &&
      typeof stock === "number" &&
      !Number.isNaN(trend) &&
      !Number.isNaN(stock)
    ) {
      trends.push(trend);
      stocks.push(stock);
    }
  }

  return { trends, stocks };
}

function ChartTooltip({
  active,
  payload,
  label,
  selectedList,
  smaEntities,
  categoryByName,
  stockEntities,
  colorByName,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  selectedList: string[];
  smaEntities: string[];
  categoryByName: Map<string, EntityCategory>;
  stockEntities: string[];
  colorByName: Map<string, string>;
}) {
  if (!active || !label) return null;

  const row =
    (payload?.[0]?.payload as TrendDatum | undefined) ??
    ({ date: String(label) } as TrendDatum);
  const stockSet = new Set(stockEntities);

  const trendEntries = selectedList.map((entityName) => ({
    entityName,
    value: row[entityName],
    color: colorByName.get(entityName) ?? "#6366f1",
  }));

  const smaEntries = smaEntities.map((entityName) => ({
    entityName,
    key: smaKey(entityName),
    value: row[smaKey(entityName)],
    color: colorByName.get(entityName) ?? "#6366f1",
  }));

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/95 px-3 py-2.5 shadow-2xl backdrop-blur">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {normalizeDateString(String(label ?? ""))}
      </p>
      <div className="space-y-1">
        {[...trendEntries]
          .sort((a, b) => {
            const av = typeof a.value === "number" ? a.value : -1;
            const bv = typeof b.value === "number" ? b.value : -1;
            return bv - av;
          })
          .map(({ entityName, value, color }) => {
            const name = formatLabelWithTicker(entityName);
            const stockPrice = row[stockKey(entityName)];
            const showStock =
              stockSet.has(entityName) &&
              typeof stockPrice === "number" &&
              !Number.isNaN(stockPrice);
            const hasTrend =
              typeof value === "number" && !Number.isNaN(value);

            return (
              <div
                key={entityName}
                className="flex items-center justify-between gap-6 text-sm"
              >
                <span className="flex items-center gap-2 text-neutral-300">
                  <EntityLogo
                    name={entityName}
                    category={categoryByName.get(entityName)}
                    size={14}
                  />
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  {name}
                </span>
                <span className="flex items-center gap-2 font-mono text-xs font-medium text-neutral-100">
                  <span className={hasTrend ? "" : "text-neutral-600"}>
                    {hasTrend ? value : "—"}
                  </span>
                  {showStock && (
                    <span className="text-amber-300">
                      {formatUsd(stockPrice)}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
      </div>
      {smaEntries.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-neutral-800 pt-2">
          {smaEntries.map(({ entityName, key, value, color }) => {
            const hasSma = typeof value === "number" && !Number.isNaN(value);
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-8 text-xs text-neutral-400"
              >
                <span className="flex items-center gap-2">
                  <span
                    className="h-0 w-3 border-t border-dashed"
                    style={{ borderColor: color }}
                  />
                  {displayName(key)}
                </span>
                <span className={`font-mono ${hasSma ? "" : "text-neutral-600"}`}>
                  {hasSma ? value : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function TrendExplorer({
  entities,
  isLive,
  onChartContextChange,
}: {
  entities: EntityMeta[];
  isLive: boolean;
  onChartContextChange?: (ctx: ChartContext) => void;
}) {
  const allEntities = entities;

  const [timeframe, setTimeframe] = useState<Timeframe>("1Y");
  const [smaEnabled, setSmaEnabled] = useState<Set<string>>(() => new Set());
  const [stockEnabled, setStockEnabled] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pinnedData, setPinnedData] = useState<PinnedDataPoint | null>(null);
  const [sourceData, setSourceData] = useState<TrendDatum[]>([]);
  const [loading, setLoading] = useState(false);

  const selectedList = useMemo(
    () => allEntities.map((e) => e.name).filter((name) => selected.has(name)),
    [allEntities, selected]
  );

  const fetchNames = useMemo(() => [...selectedList].sort(), [selectedList]);
  const fetchKey = fetchNames.join("|");

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

  const stockEntities = useMemo(
    () =>
      selectedList.filter(
        (name) => stockEnabled.has(name) && Boolean(getBrandTicker(name))
      ),
    [selectedList, stockEnabled]
  );

  const stockMappings = useMemo(() => {
    const mappings: { brand: string; parent: string; ticker: string }[] = [];
    for (const name of selectedList) {
      if (!stockEnabled.has(name)) continue;
      const meta = getEntityByName(name);
      if (!meta?.parent_description || !meta.ticker) continue;
      mappings.push({
        brand: name,
        parent: meta.parent_description,
        ticker: meta.ticker,
      });
    }
    return mappings;
  }, [selectedList, stockEnabled]);

  const [stockByEntity, setStockByEntity] = useState<
    Record<string, Map<string, number>>
  >({});
  const [stockFetchStatus, setStockFetchStatus] = useState<
    Record<string, "loading" | "ok" | "error">
  >({});

  useEffect(() => {
    if (stockEntities.length === 0) {
      setStockByEntity({});
      setStockFetchStatus({});
      return;
    }

    let cancelled = false;
    setStockFetchStatus(
      Object.fromEntries(stockEntities.map((name) => [name, "loading"]))
    );

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
          console.error(
            `[stock fetch] ${name} (${ticker}) failed:`,
            data.error ?? res.status
          );
          throw new Error(data.error ?? `Finance API error (${res.status})`);
        }
        const map = new Map<string, number>();
        for (const q of data.quotes ?? []) map.set(q.date, q.close);
        if (map.size === 0) {
          console.error(
            `[stock fetch] ${name} (${ticker}) returned empty quotes:`,
            data
          );
          throw new Error(`No stock data available for ${ticker}`);
        }
        return { name, ticker, map };
      })
    ).then((results) => {
      if (cancelled) return;
      const byEntity: Record<string, Map<string, number>> = {};
      const status: Record<string, "loading" | "ok" | "error"> = {};
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const name = stockEntities[i];
        if (result.status === "fulfilled") {
          byEntity[name] = result.value.map;
          status[name] = "ok";
        } else {
          status[name] = "error";
          const ticker = getBrandTicker(name)!;
          console.error(
            `[stock fetch] Unavailable overlay for ${name} (${ticker}):`,
            result.reason
          );
        }
      }
      setStockByEntity(byEntity);
      setStockFetchStatus(status);
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
    const extra = smaEntities.map(smaKey);
    return groupAndAlignChartData(normalizedAll, selectedList, extra);
  }, [normalizedAll, selectedList, smaEntities]);

  const mergedForAnalysis = useMemo(() => {
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

    const alignExtra = [
      ...smaEntities.map(smaKey),
      ...stockEntities.map((name) => stockKey(name)),
    ];

    return groupAndAlignChartData(merged, selectedList, alignExtra);
  }, [alignedAll, smaEntities, stockEntities, stockByEntity, selectedList]);

  const chartData = useMemo(() => {
    const sliced = filterByTimeframe(mergedForAnalysis, timeframe);
    const alignExtra = [
      ...smaEntities.map(smaKey),
      ...stockEntities.map((name) => stockKey(name)),
    ];
    return groupAndAlignChartData(sliced, selectedList, alignExtra);
  }, [
    mergedForAnalysis,
    timeframe,
    selectedList,
    smaEntities,
    stockEntities,
  ]);

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

  const correlationByBrand = useMemo(() => {
    const scores: Record<string, number> = {};

    for (const name of selectedList) {
      if (
        !stockEnabled.has(name) ||
        !getBrandTicker(name) ||
        getEntityByName(name)?.category !== "brand"
      ) {
        continue;
      }

      const { trends, stocks } = extractPairedTrendStock(chartData, name);
      if (trends.length >= 2) {
        scores[name] = calculatePearson(trends, stocks);
      }
    }

    return scores;
  }, [selectedList, stockEnabled, chartData]);

  const stockUnavailableTickers = useMemo(() => {
    const warnings: { brand: string; ticker: string }[] = [];

    for (const name of stockEntities) {
      const ticker = getBrandTicker(name);
      if (!ticker) continue;

      const status = stockFetchStatus[name];
      if (status === "error") {
        warnings.push({ brand: name, ticker });
        continue;
      }
      if (
        status === "ok" &&
        !activeStockEntities.includes(name)
      ) {
        warnings.push({ brand: name, ticker });
      }
    }

    return warnings;
  }, [stockEntities, stockFetchStatus, activeStockEntities]);

  const eventStudyBrand = useMemo(() => {
    const brands = selectedList.filter(
      (name) =>
        stockEnabled.has(name) &&
        Boolean(getBrandTicker(name)) &&
        getEntityByName(name)?.category === "brand"
    );
    return brands.length === 1 ? brands[0] : null;
  }, [selectedList, stockEnabled]);

  const eventStudyEnabled =
    eventStudyBrand != null &&
    activeStockEntities.includes(eventStudyBrand);

  const yDomain = useMemo((): [number, number] => [0, 100], []);

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

  useEffect(() => {
    const primaryStock = activeStockEntities[0];
    onChartContextChange?.({
      timeframe,
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
      pinnedData,
    });
  }, [
    timeframe,
    selectedList,
    smaEntities,
    activeStockEntities,
    chartData,
    isLive,
    pinnedData,
    onChartContextChange,
  ]);

  const pinChartRow = (row: TrendDatum) => {
    const next = buildPinnedFromRow(row, selectedList, smaEnabled, stockEnabled);
    if (Object.keys(next.values).length === 0) return;

    setPinnedData((prev) => (prev?.date === next.date ? null : next));
  };

  const handleChartClick = (
    state: {
      activeLabel?: string | number;
      activePayload?: ReadonlyArray<{ payload?: TrendDatum }>;
    } | null
  ) => {
    const row =
      state?.activePayload?.[0]?.payload ??
      chartData.find((d) => String(d.date) === String(state?.activeLabel));

    if (row) pinChartRow(row);
  };

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
    setPinnedData(null);
  };

  useEffect(() => {
    setPinnedData(null);
  }, [timeframe]);

  return (
    <>
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
          {chartData.length} observations · {selectedList.length} series
          {activeStockEntities.length > 0
            ? ` · ${activeStockEntities.length} stock overlay${activeStockEntities.length > 1 ? "s" : ""}`
            : ""}
        </span>
      </div>

      <EntitySelector
        entities={allEntities}
        selected={selected}
        smaEnabled={smaEnabled}
        stockEnabled={stockEnabled}
        onAdd={addEntity}
        onRemove={removeEntity}
        onToggleSma={toggleSma}
        onToggleStock={toggleStock}
        stockMappings={stockMappings}
        correlationByBrand={correlationByBrand}
        stockUnavailable={stockUnavailableTickers}
      />

      <QuantitativeTools
        eventStudyEnabled={eventStudyEnabled}
        eventStudyBrand={eventStudyBrand}
        onRunEventStudy={(spikeThreshold) =>
          runEventStudyWithSentiment(
            mergedForAnalysis,
            eventStudyBrand!,
            stockKey(eventStudyBrand!),
            spikeThreshold
          )
        }
      />

      <div className="relative h-96 w-full rounded-lg border border-neutral-800/60 bg-neutral-950/30 p-2">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Loading series…
          </div>
        ) : selectedList.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-sm text-neutral-600">
              Add a brand or trend to begin analysis
            </p>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            No data in this timeframe.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 12, right: hasStockSeries ? 56 : 16, left: 0, bottom: 4 }}
              style={{ cursor: "crosshair" }}
              onClick={handleChartClick}
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
                width={36}
              />
              {hasStockSeries && (
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
              <Tooltip
                content={
                  <ChartTooltip
                    selectedList={selectedList}
                    smaEntities={smaEntities}
                    categoryByName={categoryByName}
                    stockEntities={activeStockEntities}
                    colorByName={colorByName}
                  />
                }
                cursor={{ stroke: "#404040", strokeWidth: 1 }}
              />
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
                  activeDot={{ r: 5 }}
                  connectNulls
                />
              ))}
              {pinnedData && (
                <ReferenceLine
                  x={pinnedData.date}
                  yAxisId="left"
                  stroke="#e5e5e5"
                  strokeDasharray="4 4"
                  strokeOpacity={0.85}
                />
              )}
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
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {pinnedData && (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[min(100%,28rem)] rounded-md border border-neutral-800/80 bg-neutral-950/90 px-2.5 py-1.5 text-[11px] text-neutral-400 backdrop-blur">
            <span className="text-neutral-500">Pinned · </span>
            <span className="font-mono text-neutral-300">
              {normalizeDateString(pinnedData.date)}
            </span>
            {Object.entries(pinnedData.values).map(([key, value]) => (
              <span key={key}>
                <span className="text-neutral-600"> · </span>
                <span className="text-neutral-500">{displayName(key)}</span>
                <span className="font-mono text-neutral-300"> {value}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {selectedList.length > 0 && (
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
      )}
    </section>

    <div className="mt-6 space-y-6">
      <AlphaStrategiesDashboard />
      <PaperPortfolioPanel />
    </div>
    </>
  );
}
