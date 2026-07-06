"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Download, Search } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { EntityCategory, EntityMeta, TrendDatum } from "@/app/actions";

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

type Timeframe = "6M" | "1Y" | "5Y";

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

type TooltipEntry = { name: string; value: number; color: string; dataKey?: string };

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

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  const raw = payload.filter((e) => !isSmaKey(String(e.dataKey ?? e.name)));
  const smoothed = payload.filter((e) => isSmaKey(String(e.dataKey ?? e.name)));

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/95 px-3 py-2.5 shadow-2xl backdrop-blur">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {label}
      </p>
      <div className="space-y-1">
        {[...raw]
          .sort((a, b) => b.value - a.value)
          .map((entry) => (
            <div
              key={entry.name}
              className="flex items-center justify-between gap-8 text-sm"
            >
              <span className="flex items-center gap-2 text-neutral-300">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                {displayName(entry.name)}
              </span>
              <span className="font-mono text-xs font-medium text-neutral-100">
                {entry.value}
              </span>
            </div>
          ))}
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

function EntityPicker({
  entities,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  search,
  onSearchChange,
}: {
  entities: EntityMeta[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  onSelectAll: (category: EntityCategory) => void;
  onClear: () => void;
  search: string;
  onSearchChange: (q: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filter = (list: EntityMeta[]) =>
      list.filter((e) => !q || e.name.toLowerCase().includes(q));

    return {
      brand: filter(entities.filter((e) => e.category === "brand")),
      trend: filter(entities.filter((e) => e.category === "trend")),
    };
  }, [entities, search]);

  const renderGroup = (label: string, list: EntityMeta[], category: EntityCategory) => {
    if (list.length === 0) return null;
    return (
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
            {label}
          </p>
          <button
            type="button"
            onClick={() => onSelectAll(category)}
            className="text-[10px] text-neutral-500 transition-colors hover:text-neutral-300"
          >
            Select all
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {list.map((entity) => {
            const active = selected.has(entity.name);
            return (
              <button
                key={entity.name}
                type="button"
                onClick={() => onToggle(entity.name)}
                className={`rounded-full border px-3 py-1 text-xs transition-all ${
                  active
                    ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-200 shadow-[0_0_12px_rgba(99,102,241,0.15)]"
                    : "border-neutral-800 bg-neutral-900/40 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
                }`}
              >
                {entity.name}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-neutral-800/80 bg-neutral-950/50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <p className="text-xs font-medium text-neutral-300">Entity Comparator</p>
          <p className="text-[11px] text-neutral-500">
            {selected.size} of {entities.length} series selected
          </p>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-neutral-500 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-neutral-800/80 px-4 pb-4 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-neutral-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Filter entities…"
                className="w-full bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 outline-none"
              />
            </div>
            <button
              type="button"
              onClick={onClear}
              className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            >
              Clear
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {renderGroup("Brands", grouped.brand, "brand")}
            {renderGroup("Cultural Trends", grouped.trend, "trend")}
          </div>
        </div>
      )}
    </div>
  );
}

export default function TrendExplorer({
  data,
  entities,
}: {
  data: TrendDatum[];
  entities: EntityMeta[];
}) {
  const isLive = data.length > 0 && entities.length > 0;
  const sourceData = isLive ? data : SAMPLE_DATA;
  const allEntities = isLive ? entities : SAMPLE_ENTITIES;

  const [timeframe, setTimeframe] = useState<Timeframe>("1Y");
  const [showSMA, setShowSMA] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() =>
    defaultSelection(allEntities)
  );

  useEffect(() => {
    if (isLive && selected.size === 0) {
      setSelected(defaultSelection(allEntities));
    }
  }, [isLive, allEntities, selected.size]);

  const colorByName = useMemo(() => {
    const map = new Map<string, string>();
    allEntities.forEach((e, i) => map.set(e.name, PALETTE[i % PALETTE.length]));
    return map;
  }, [allEntities]);

  const selectedList = useMemo(
    () => allEntities.map((e) => e.name).filter((name) => selected.has(name)),
    [allEntities, selected]
  );

  const filteredData = useMemo(
    () => filterByTimeframe(sourceData, timeframe),
    [sourceData, timeframe]
  );

  const chartData = useMemo(() => {
    if (!showSMA || selectedList.length === 0) return filteredData;
    return applySMA(filteredData, selectedList);
  }, [filteredData, showSMA, selectedList]);

  const toggleEntity = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAllInCategory = (category: EntityCategory) => {
    setSelected((prev) => {
      const next = new Set(prev);
      allEntities.filter((e) => e.category === category).forEach((e) => next.add(e.name));
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

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

        <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-1.5">
          <span className="text-xs text-neutral-400">90-Day Moving Average</span>
          <button
            type="button"
            role="switch"
            aria-checked={showSMA}
            onClick={() => setShowSMA((v) => !v)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              showSMA ? "bg-indigo-500/80" : "bg-neutral-700"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                showSMA ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </label>

        <span className="text-[11px] text-neutral-600">
          {filteredData.length} observations · {selectedList.length} series
        </span>
      </div>

      {/* Multi-select entity picker */}
      <div className="mb-5">
        <EntityPicker
          entities={allEntities}
          selected={selected}
          onToggle={toggleEntity}
          onSelectAll={selectAllInCategory}
          onClear={clearSelection}
          search={search}
          onSearchChange={setSearch}
        />
      </div>

      {/* Chart */}
      <div className="h-96 w-full rounded-lg border border-neutral-800/60 bg-neutral-950/30 p-2">
        {selectedList.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            Select at least one entity to plot.
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            No data in this timeframe.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 12, right: 16, left: 0, bottom: 4 }}
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
                domain={[0, 100]}
                stroke="#525252"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={36}
                tickFormatter={(v) => String(v)}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ stroke: "#404040", strokeWidth: 1 }}
              />
              {selectedList.map((name) => (
                <Line
                  key={name}
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
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Active series legend */}
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
      )}
    </section>
  );
}
