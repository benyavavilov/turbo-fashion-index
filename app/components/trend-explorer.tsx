"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
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
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#3b82f6", // blue
];

/**
 * Sample fallback used only when the live Supabase dataset is empty (e.g. the
 * pipeline hasn't run yet). Lets the dashboard stay fully interactive.
 */
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
  { date: "Jan", Nike: 78, Lululemon: 62, Adidas: 70, Zara: 66, Gorpcore: 24, "Y2K Fashion": 55, "Quiet Luxury": 30, Streetwear: 61 },
  { date: "Feb", Nike: 74, Lululemon: 65, Adidas: 68, Zara: 63, Gorpcore: 29, "Y2K Fashion": 58, "Quiet Luxury": 38, Streetwear: 59 },
  { date: "Mar", Nike: 80, Lululemon: 69, Adidas: 72, Zara: 70, Gorpcore: 35, "Y2K Fashion": 61, "Quiet Luxury": 44, Streetwear: 64 },
  { date: "Apr", Nike: 83, Lululemon: 74, Adidas: 71, Zara: 72, Gorpcore: 41, "Y2K Fashion": 57, "Quiet Luxury": 52, Streetwear: 66 },
  { date: "May", Nike: 79, Lululemon: 77, Adidas: 75, Zara: 69, Gorpcore: 46, "Y2K Fashion": 60, "Quiet Luxury": 63, Streetwear: 70 },
  { date: "Jun", Nike: 86, Lululemon: 82, Adidas: 78, Zara: 74, Gorpcore: 52, "Y2K Fashion": 64, "Quiet Luxury": 71, Streetwear: 73 },
];

type TooltipEntry = { name: string; value: number; color: string };

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
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/95 px-3 py-2 shadow-xl backdrop-blur">
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      {[...payload]
        .sort((a, b) => b.value - a.value)
        .map((entry) => (
          <div
            key={entry.name}
            className="flex items-center justify-between gap-6 text-sm"
          >
            <span className="flex items-center gap-2 text-neutral-300">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              {entry.name}
            </span>
            <span className="font-mono font-medium text-neutral-100">
              {entry.value}
            </span>
          </div>
        ))}
    </div>
  );
}

const VIEWS: { id: EntityCategory; label: string }[] = [
  { id: "brand", label: "Brands" },
  { id: "trend", label: "Cultural Trends" },
];

export default function TrendExplorer({
  data,
  entities,
}: {
  data: TrendDatum[];
  entities: EntityMeta[];
}) {
  const isLive = data.length > 0 && entities.length > 0;
  const chartData = isLive ? data : SAMPLE_DATA;
  const allEntities = isLive ? entities : SAMPLE_ENTITIES;

  const [view, setView] = useState<EntityCategory>("brand");
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Stable color assignment across the full entity list.
  const colorByName = useMemo(() => {
    const map = new Map<string, string>();
    allEntities.forEach((e, i) => map.set(e.name, PALETTE[i % PALETTE.length]));
    return map;
  }, [allEntities]);

  const counts = useMemo(
    () => ({
      brand: allEntities.filter((e) => e.category === "brand").length,
      trend: allEntities.filter((e) => e.category === "trend").length,
    }),
    [allEntities]
  );

  const seriesForView = useMemo(
    () => allEntities.filter((e) => e.category === view).map((e) => e.name),
    [allEntities, view]
  );

  const visibleSeries = seriesForView.filter((name) => !hidden.has(name));

  const toggleSeries = (name: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-neutral-100">
              Search Interest Over Time
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
          <p className="text-sm text-neutral-500">
            Normalized index (0–100){isLive ? "" : " · run the pipeline for live data"}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Brand / Trend segmented control */}
          <div className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900/60 p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  view === v.id
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {v.label}
                <span className="ml-1.5 text-xs text-neutral-500">
                  {counts[v.id]}
                </span>
              </button>
            ))}
          </div>

          <button className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-800">
            <Download className="h-4 w-4" />
            Export
          </button>
        </div>
      </div>

      {/* Interactive legend: click a chip to toggle a series */}
      <div className="mb-4 flex flex-wrap gap-2">
        {seriesForView.map((name) => {
          const active = !hidden.has(name);
          const color = colorByName.get(name);
          return (
            <button
              key={name}
              onClick={() => toggleSeries(name)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
                active
                  ? "border-neutral-700 bg-neutral-800/60 text-neutral-200"
                  : "border-neutral-800 bg-transparent text-neutral-600"
              }`}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: active ? color : "#525252" }}
              />
              {name}
            </button>
          );
        })}
      </div>

      <div className="h-80 w-full">
        {visibleSeries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-600">
            No series selected.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 12, left: -8, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#262626"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                stroke="#525252"
                fontSize={12}
                tickLine={false}
                axisLine={{ stroke: "#262626" }}
              />
              <YAxis
                domain={[0, 100]}
                stroke="#525252"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ stroke: "#404040", strokeWidth: 1 }}
              />
              {visibleSeries.map((name) => (
                <Line
                  key={name}
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
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
